import {
  parseProjectYaml,
  parseSceneYaml,
  serializeProjectYaml,
  serializeSceneYaml,
  type Project,
  type Scene,
  type SceneTranslation as PortableSceneTranslation,
  type Step,
  type StepCta,
} from '@scenebook/schema';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { parseDocument } from 'yaml';

import { createLocalMediaUrl, getLocalMediaBlob } from './local-media';
import { cloneScene, defaultStep, normalizedPoint } from './model';
import type { EditorCta, EditorScene, EditorStep } from './model';

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 10 * 1024 * 1024;
const INLINE_ASSET_KEY = 'scenebookStudioInlineAssets';
const REMOTE_IMAGE_KEY = 'scenebookStudioRemoteImages';
const CTA_KEY = 'scenebookStudioCtas';
const TRANSLATIONS_KEY = 'scenebookStudioTranslations';
const SIDECARS_KEY = 'scenebookStudioSidecars';
const EXTENSION_REPLAY_PATH = 'automation/replay.ts';

export type PortableDocumentKind = 'scene' | 'project';

export interface PortableImportResult {
  kind: PortableDocumentKind;
  scenes: EditorScene[];
  project?: Project;
  warnings: string[];
}

export interface PortableExport {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
}

export class PortableFileError extends Error {
  readonly issues: readonly string[];
  readonly code:
    | 'invalid-file'
    | 'invalid-yaml'
    | 'invalid-archive'
    | 'unsupported-version'
    | 'missing-asset'
    | 'corrupt-asset'
    | 'missing-sidecar';

  constructor(
    message: string,
    issues: readonly string[] = [],
    code: PortableFileError['code'] = 'invalid-file',
  ) {
    super(message);
    this.name = 'PortableFileError';
    this.issues = issues;
    this.code = code;
  }
}

interface SceneArchiveSource {
  source: Scene;
  yamlPath: string;
  assets: Record<string, string>;
  sidecars: Record<string, string>;
}

interface BuiltScene {
  source: Scene;
  files: Record<string, Uint8Array>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isSafeArchivePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1_024 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function isSafeArchiveEntryPath(path: string): boolean {
  return path.endsWith('/') ? isSafeArchivePath(path.slice(0, -1)) : isSafeArchivePath(path);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function preflightZip(bytes: Uint8Array): void {
  const minimumEocd = 22;
  if (bytes.byteLength < minimumEocd) {
    throw new PortableFileError('The ZIP archive is truncated.', [], 'invalid-archive');
  }
  const earliest = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - minimumEocd; offset >= earliest; offset -= 1) {
    if (readUint32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new PortableFileError('The ZIP central directory is missing.', [], 'invalid-archive');
  }
  const disk = readUint16(bytes, eocd + 4);
  const centralDisk = readUint16(bytes, eocd + 6);
  const diskEntries = readUint16(bytes, eocd + 8);
  const totalEntries = readUint16(bytes, eocd + 10);
  const centralSize = readUint32(bytes, eocd + 12);
  const centralOffset = readUint32(bytes, eocd + 16);
  const commentLength = readUint16(bytes, eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new PortableFileError(
      'Multi-disk ZIP archives are not supported.',
      [],
      'invalid-archive',
    );
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new PortableFileError(
      'ZIP64 archives are not supported by the browser importer.',
      [],
      'invalid-archive',
    );
  }
  if (
    totalEntries > MAX_ARCHIVE_ENTRIES ||
    eocd + minimumEocd + commentLength !== bytes.byteLength ||
    centralOffset + centralSize !== eocd
  ) {
    throw new PortableFileError(
      'The ZIP central directory is inconsistent or exceeds Studio’s limits.',
      [],
      'invalid-archive',
    );
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = centralOffset;
  let expandedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocd || readUint32(bytes, offset) !== 0x02014b50) {
      throw new PortableFileError(
        'The ZIP central directory contains a malformed entry.',
        [],
        'invalid-archive',
      );
    }
    const flags = readUint16(bytes, offset + 8);
    const compression = readUint16(bytes, offset + 10);
    const compressedSize = readUint32(bytes, offset + 20);
    const originalSize = readUint32(bytes, offset + 24);
    const filenameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const entryCommentLength = readUint16(bytes, offset + 32);
    const diskStart = readUint16(bytes, offset + 34);
    const localOffset = readUint32(bytes, offset + 42);
    const next = offset + 46 + filenameLength + extraLength + entryCommentLength;
    if (next > eocd || localOffset >= centralOffset || compressedSize > bytes.byteLength) {
      throw new PortableFileError('A ZIP entry has invalid bounds.', [], 'invalid-archive');
    }
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + filenameLength));
    } catch {
      throw new PortableFileError('ZIP entry names must use valid UTF-8.', [], 'invalid-archive');
    }
    if (!isSafeArchiveEntryPath(name)) {
      throw new PortableFileError(
        'The ZIP archive contains an unsafe path.',
        [name],
        'invalid-archive',
      );
    }
    if ((flags & 0x1) !== 0 || diskStart !== 0 || ![0, 8].includes(compression)) {
      throw new PortableFileError(
        'Encrypted, multi-disk, or unsupported ZIP entries cannot be imported.',
        [name],
        'invalid-archive',
      );
    }
    expandedBytes += originalSize;
    if (originalSize > MAX_ENTRY_BYTES || expandedBytes > MAX_EXPANDED_BYTES) {
      throw new PortableFileError(
        'The ZIP archive expands beyond Studio’s safety limits.',
        [name],
        'invalid-archive',
      );
    }
    offset = next;
  }
  if (offset !== eocd) {
    throw new PortableFileError(
      'The ZIP central directory has unexpected trailing data.',
      [],
      'invalid-archive',
    );
  }
}

const SCREENSHOT_MEDIA_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const ACTIVE_MEDIA_TYPES = /(?:html|javascript|ecmascript|svg|xml|x-shockwave-flash)/iu;

function sniffRasterMediaType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  )
    return 'image/png';
  if (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes.at(-1) === 0xd9
  )
    return 'image/jpeg';
  const header = new TextDecoder().decode(bytes.subarray(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  if (
    bytes.length >= 12 &&
    header.slice(4, 8) === 'ftyp' &&
    /avif|avis/iu.test(header.slice(8, 12))
  )
    return 'image/avif';
  return null;
}

function validateAssetContent(
  bytes: Uint8Array,
  mediaType: string,
  role: string,
  path: string,
): void {
  const normalizedType = mediaType.split(';')[0]!.trim().toLowerCase();
  if (ACTIVE_MEDIA_TYPES.test(normalizedType)) {
    throw new PortableFileError(
      'Active content is not allowed in portable Scene assets.',
      [`${path}: ${normalizedType}`],
      'invalid-file',
    );
  }
  if (role === 'screenshot') {
    if (!SCREENSHOT_MEDIA_TYPES.has(normalizedType) || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new PortableFileError(
        'Screenshots must be passive PNG, JPEG, WebP, GIF, or AVIF files up to 25 MB.',
        [`${path}: ${normalizedType}`],
        'invalid-file',
      );
    }
    const sniffed = sniffRasterMediaType(bytes);
    if (sniffed !== normalizedType) {
      throw new PortableFileError(
        'A screenshot’s bytes do not match its declared media type.',
        [`${path}: declared ${normalizedType}, detected ${sniffed ?? 'unknown content'}`],
        'corrupt-asset',
      );
    }
  }
}

export async function readScreenshotFile(file: File): Promise<string> {
  if (file.size > MAX_SCREENSHOT_BYTES) {
    throw new PortableFileError('Screenshots must be 25 MB or smaller.', [], 'invalid-file');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateAssetContent(bytes, file.type, 'screenshot', file.name);
  return createLocalMediaUrl(bytes.buffer, file.type);
}

function archiveDirectory(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash < 0 ? '' : path.slice(0, lastSlash + 1);
}

function joinArchivePath(directory: string, relative: string): string {
  const joined = `${directory}${relative}`;
  if (!isSafeArchivePath(joined)) {
    throw new PortableFileError(
      'The archive contains an unsafe asset path.',
      [joined],
      'invalid-archive',
    );
  }
  return joined;
}

function describeError(error: unknown): string[] {
  const record = objectValue(error);
  const issues = record?.issues;
  if (Array.isArray(issues)) {
    return issues.slice(0, 12).map((issue) => {
      const candidate = objectValue(issue);
      const path = Array.isArray(candidate?.path) ? candidate.path.join('.') : '';
      const message = stringValue(candidate?.message, 'Invalid value');
      return path ? `${path}: ${message}` : message;
    });
  }
  const errors = record?.errors;
  if (Array.isArray(errors)) return errors.slice(0, 12).map(String);
  return error instanceof Error ? [error.message] : ['The file could not be read.'];
}

function rethrowYaml(error: unknown): never {
  const issues = describeError(error);
  const unsupported = issues.some((issue) => /schemaVersion|version|literal.*1/iu.test(issue));
  throw new PortableFileError(
    unsupported
      ? 'This file uses a Scenebook version that Studio does not support.'
      : 'The YAML file is not a valid Scenebook Scene or project.',
    issues,
    unsupported ? 'unsupported-version' : 'invalid-yaml',
  );
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toDataUri(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${uint8ToBase64(bytes)}`;
}

function fromDataUri(value: string): { bytes: Uint8Array; mediaType: string } | null {
  const match = /^data:([^,]*),(.*)$/isu.exec(value);
  if (!match) return null;
  const metadata = match[1] ?? '';
  const payload = match[2] ?? '';
  const mediaType = metadata.split(';')[0] || 'text/plain';
  try {
    return metadata.split(';').includes('base64')
      ? { bytes: base64ToUint8(payload.replaceAll(/\s/gu, '')), mediaType }
      : { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mediaType };
  } catch {
    return null;
  }
}

async function fromEmbeddedUrl(
  value: string,
  maxBytes: number,
  label: string,
): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  const inline = fromDataUri(value);
  if (inline) return inline;
  if (!value.startsWith('blob:')) return null;
  const local = getLocalMediaBlob(value);
  if (local) {
    if (local.size > maxBytes) {
      throw new PortableFileError(
        `The local media for ${label} exceeds its size limit.`,
        [label],
        'missing-asset',
      );
    }
    return {
      bytes: new Uint8Array(await local.arrayBuffer()),
      mediaType: local.type || 'application/octet-stream',
    };
  }
  let response: Response;
  try {
    response = await fetch(value);
  } catch (error) {
    throw new PortableFileError(
      `The local media for ${label} is no longer available.`,
      [error instanceof Error ? error.message : label],
      'missing-asset',
    );
  }
  const advertisedBytes = Number(response.headers.get('content-length') ?? 0);
  if (!response.ok || advertisedBytes > maxBytes) {
    throw new PortableFileError(
      `The local media for ${label} could not be read safely.`,
      [advertisedBytes > maxBytes ? `${label} exceeds its size limit.` : `HTTP ${response.status}`],
      'missing-asset',
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new PortableFileError(
      `The local media for ${label} exceeds its size limit.`,
      [label],
      'missing-asset',
    );
  }
  return {
    bytes,
    mediaType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
  };
}

async function readBoundedResponse(response: Response, label: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_SCREENSHOT_BYTES) {
      await reader.cancel();
      throw new PortableFileError(
        `The screenshot for ${label} exceeds Studio’s 25 MB export limit.`,
        [label],
        'missing-asset',
      );
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function extensionFor(mediaType: string): string {
  const known: Record<string, string> = {
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
  };
  return known[mediaType.toLowerCase()] ?? 'bin';
}

function selectedState(step: Step) {
  const requested = step.presentation.state === 'after' ? step.states.after : step.states.before;
  return requested ?? step.states.before ?? step.states.after;
}

function centerOf(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: normalizedPoint(rect.x + rect.width / 2),
    y: normalizedPoint(rect.y + rect.height / 2),
  };
}

function editorKind(kind: Step['kind']): EditorStep['type'] {
  if (kind === 'browser') return 'screen';
  if (kind === 'explanation') return 'separator';
  return kind;
}

function sourceImageMap(source: Scene): Record<string, string> {
  const metadata = objectValue(source.metadata);
  const remote = objectValue(metadata?.[REMOTE_IMAGE_KEY]);
  const result: Record<string, string> = {};
  if (remote) {
    for (const [stepId, value] of Object.entries(remote)) {
      if (typeof value === 'string' && /^https?:\/\//iu.test(value)) result[stepId] = value;
    }
  }
  return result;
}

function restoredMetadataCtas(source: Scene, stepId: string): EditorStep['ctas'] {
  const metadata = objectValue(source.metadata);
  const byStep = objectValue(metadata?.[CTA_KEY]);
  const values = byStep?.[stepId];
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const candidate = objectValue(value);
    const id = stringValue(candidate?.id);
    const label = stringValue(candidate?.label);
    if (!id || !label) return [];
    const kind = [
      'open-product',
      'read-docs',
      'restart',
      'view-scene',
      'book-call',
      'external',
      'form',
    ].includes(stringValue(candidate?.kind))
      ? (candidate!.kind as EditorCta['kind'])
      : undefined;
    const fields = Array.isArray(candidate?.fields)
      ? candidate.fields.flatMap((rawField) => {
          const field = objectValue(rawField);
          const fieldId = stringValue(field?.id);
          const fieldLabel = stringValue(field?.label);
          const type = stringValue(field?.type);
          if (!fieldId || !fieldLabel || !['email', 'text', 'checkbox'].includes(type)) return [];
          return [
            {
              id: fieldId,
              label: fieldLabel,
              type: type as 'email' | 'text' | 'checkbox',
              required: booleanValue(field?.required, false),
              consent: booleanValue(field?.consent, false),
            },
          ];
        })
      : undefined;
    return [
      {
        id,
        label,
        kind,
        href: typeof candidate?.href === 'string' ? candidate.href : undefined,
        event: typeof candidate?.event === 'string' ? candidate.event : undefined,
        targetSceneId:
          typeof candidate?.targetSceneId === 'string' ? candidate.targetSceneId : undefined,
        webhookId: typeof candidate?.webhookId === 'string' ? candidate.webhookId : undefined,
        fields,
        variant: candidate?.variant === 'secondary' ? ('secondary' as const) : ('primary' as const),
      },
    ];
  });
}

function editorCtaFromPortable(cta: NonNullable<Step['cta']>, stepId: string): EditorCta {
  return {
    id: `${stepId}-cta`,
    label: cta.label,
    kind: cta.kind,
    href: cta.url,
    event: cta.kind === 'restart' ? 'restart' : undefined,
    targetSceneId: cta.targetSceneId,
    webhookId: cta.webhookId,
    fields: structuredClone(cta.fields),
    variant: 'primary',
  };
}

function editorCtaFromPortableEntry(cta: StepCta): EditorCta {
  return {
    id: cta.id,
    label: cta.label,
    kind: cta.kind,
    href: cta.url,
    event: cta.kind === 'restart' ? 'restart' : undefined,
    targetSceneId: cta.targetSceneId,
    webhookId: cta.webhookId,
    fields: structuredClone(cta.fields),
    variant: cta.variant,
  };
}

function mergeTranslation(
  target: NonNullable<EditorScene['translations']>,
  locale: string,
  source: unknown,
): void {
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(locale)) return;
  const document = objectValue(source);
  if (!document) return;
  const scene = objectValue(document.scene);
  const rawSteps = objectValue(document.steps);
  const existing = target[locale] ?? { steps: {} };
  const steps = { ...existing.steps };
  if (rawSteps) {
    for (const [stepId, rawStep] of Object.entries(rawSteps).slice(0, 10_000)) {
      const step = objectValue(rawStep);
      if (!step) continue;
      const previous = steps[stepId] ?? {};
      const restored = {
        ...previous,
        ...(typeof step.title === 'string' ? { title: step.title } : {}),
        ...(typeof step.instruction === 'string' ? { instruction: step.instruction } : {}),
        ...(typeof step.caption === 'string' ? { caption: step.caption } : {}),
        ...(typeof step.altText === 'string'
          ? { alt: step.altText }
          : typeof step.alt === 'string'
            ? { alt: step.alt }
            : {}),
      };
      if (Object.keys(restored).length > 0) steps[stepId] = restored;
    }
  }
  target[locale] = {
    ...existing,
    ...(typeof (scene ?? document).title === 'string'
      ? { title: (scene ?? document).title as string }
      : {}),
    ...(typeof (scene ?? document).description === 'string'
      ? { description: (scene ?? document).description as string }
      : {}),
    steps,
  };
}

function restoredTranslations(
  source: Scene,
  sidecars: Readonly<Record<string, string>>,
): NonNullable<EditorScene['translations']> {
  const translations: NonNullable<EditorScene['translations']> = {};

  // Sidecars are the authored base. Legacy Studio metadata and canonical inline overrides are
  // layered over them so an edit made in Studio cannot be shadowed after export.
  for (const descriptor of source.locales) {
    const encoded = sidecars[descriptor.file];
    const decoded = encoded ? fromDataUri(encoded) : null;
    if (!decoded) continue;
    try {
      const document = parseDocument(new TextDecoder().decode(decoded.bytes), {
        prettyErrors: true,
        strict: true,
        uniqueKeys: true,
      });
      if (document.errors.length === 0) {
        mergeTranslation(translations, descriptor.locale, document.toJS({ maxAliasCount: 0 }));
      }
    } catch {
      // The schema importer already proved the sidecar is bounded and present. An unfamiliar
      // locale document stays byte-exact in portableSidecars even when Studio cannot edit it.
    }
  }

  const metadata = objectValue(source.metadata);
  const values = objectValue(metadata?.[TRANSLATIONS_KEY]);
  for (const [locale, rawTranslation] of Object.entries(values ?? {}).slice(0, 100))
    mergeTranslation(translations, locale, rawTranslation);
  for (const [locale, translation] of Object.entries(source.translations))
    mergeTranslation(translations, locale, translation);
  return translations;
}

function applyThemeLayer(
  target: Record<'accent' | 'paper' | 'ink' | 'radius' | 'frame', unknown>,
  rawLayer: unknown,
): void {
  const layer = objectValue(rawLayer);
  if (!layer) return;
  const assign = (
    values: Record<string, unknown>,
    targetName: 'accent' | 'paper' | 'ink' | 'radius' | 'frame',
    sourceNames: readonly string[],
  ): void => {
    for (const sourceName of sourceNames) {
      const value = values[sourceName];
      if (typeof value === 'string' || typeof value === 'number') {
        target[targetName] = value;
        return;
      }
    }
  };
  for (const values of [layer, objectValue(layer.variables)].filter(
    (value): value is Record<string, unknown> => value !== null,
  )) {
    assign(values, 'accent', ['accent', '--accent', '--sb-accent']);
    assign(values, 'paper', ['paper', 'background', '--paper', '--sb-paper']);
    assign(values, 'ink', ['ink', 'foreground', '--ink', '--sb-ink']);
    assign(values, 'radius', ['radius', '--radius', '--sb-radius']);
    assign(values, 'frame', ['frame', '--frame', '--sb-frame']);
  }
}

function restoredTheme(
  source: Scene,
  sidecars: Readonly<Record<string, string>>,
): EditorScene['theme'] {
  const values: Record<'accent' | 'paper' | 'ink' | 'radius' | 'frame', unknown> = {
    accent: '#b83b24',
    paper: '#fbf7ef',
    ink: '#191816',
    radius: 14,
    frame: 'dark',
  };
  const themeFile = source.theme?.file;
  const encoded = themeFile ? sidecars[themeFile] : undefined;
  const decoded = encoded ? fromDataUri(encoded) : null;
  if (decoded) {
    try {
      const document = parseDocument(new TextDecoder().decode(decoded.bytes), {
        prettyErrors: true,
        strict: true,
        uniqueKeys: true,
      });
      if (document.errors.length === 0) {
        applyThemeLayer(values, document.toJS({ maxAliasCount: 0 }));
      }
    } catch {
      // Preserve unfamiliar theme documents byte-for-byte even when Studio cannot project them.
    }
  }
  applyThemeLayer(values, source.theme?.variables);
  const radiusText = String(values.radius).trim();
  const radius = /^\d+(?:\.\d+)?(?:px)?$/u.test(radiusText) ? Number.parseFloat(radiusText) : 14;
  return {
    accent: stringValue(values.accent, '#b83b24'),
    paper: stringValue(values.paper, '#fbf7ef'),
    ink: stringValue(values.ink, '#191816'),
    radius: Math.max(0, Math.min(40, radius)),
    frame: values.frame === 'light' ? 'light' : 'dark',
  };
}

export function toEditorScene(
  source: Scene,
  assets: Record<string, string> = {},
  sidecars: Record<string, string> = {},
): EditorScene {
  const remoteImages = sourceImageMap(source);
  const steps = source.steps.map((step): EditorStep => {
    const state = selectedState(step);
    const screenshotPath = state?.screenshot?.path;
    const hotspotAnnotation = step.presentation.annotations.find(
      (annotation) => annotation.kind === 'hotspot' && annotation.rect,
    );
    const hotspotRect = hotspotAnnotation?.rect ?? step.target?.normalizedRect;
    const cursor = step.presentation.cursor;
    const focalPoint = step.presentation.crop?.focalPoint;
    const editor = defaultStep(step.id, screenshotPath ? assets[screenshotPath] : undefined);
    editor.type = editorKind(step.kind);
    editor.title = step.title;
    editor.instruction = step.instruction ?? '';
    editor.caption = step.caption ?? '';
    editor.notes = step.notes ?? '';
    editor.alt = step.altText ?? '';
    editor.image = editor.image ?? remoteImages[step.id];
    editor.durationMs = step.presentation.durationMs;
    editor.autoAdvance = step.presentation.autoAdvance;
    editor.frame =
      step.presentation.frame?.kind === 'device'
        ? 'mobile'
        : step.presentation.frame?.kind === 'none'
          ? 'none'
          : 'browser';
    editor.crop = {
      x: focalPoint?.x ?? 0.5,
      y: focalPoint?.y ?? 0.5,
      zoom: step.presentation.crop?.zoom ?? 1,
    };
    editor.cursor = {
      x: cursor?.position?.x ?? (hotspotRect ? centerOf(hotspotRect).x : 0.5),
      y: cursor?.position?.y ?? (hotspotRect ? centerOf(hotspotRect).y : 0.5),
      visible: cursor?.visible ?? false,
      click: cursor?.clickAtMs !== undefined,
      path:
        cursor?.path.map((keyframe) => ({
          atMs: keyframe.atMs,
          x: keyframe.point.x,
          y: keyframe.point.y,
        })) ?? [],
      clickAtMs: cursor?.clickAtMs,
      style: cursor?.style ?? 'default',
    };
    editor.hotspot = hotspotRect
      ? {
          ...centerOf(hotspotRect),
          width: hotspotRect.width,
          height: hotspotRect.height,
          label: hotspotAnnotation?.label ?? step.target?.accessibleName ?? 'Continue',
        }
      : undefined;
    editor.annotations = step.presentation.annotations
      .filter((annotation) => annotation.kind !== 'hotspot')
      .map((annotation) => {
        const point = annotation.rect
          ? centerOf(annotation.rect)
          : (annotation.to ?? annotation.from ?? { x: 0.5, y: 0.5 });
        return {
          id: annotation.id,
          x: point.x,
          y: point.y,
          text: annotation.text ?? annotation.label ?? annotation.kind,
          width: annotation.rect?.width,
          height: annotation.rect?.height,
          fromX: annotation.from?.x,
          fromY: annotation.from?.y,
          color: annotation.color,
          kind:
            annotation.kind === 'spotlight'
              ? ('spotlight' as const)
              : annotation.kind === 'arrow'
                ? ('arrow' as const)
                : ('callout' as const),
        };
      });
    editor.masks = step.masks
      .filter((mask) => mask.rect)
      .map((mask) => ({
        id: mask.id,
        mode: mask.mode,
        source: mask.source,
        scope: mask.scope,
        classification: mask.classification,
        locator: mask.locator,
        x: mask.rect!.x,
        y: mask.rect!.y,
        width: mask.rect!.width,
        height: mask.rect!.height,
        label: mask.reason ?? 'Redacted content',
      }));
    editor.choices = step.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      description: choice.description,
      sceneId: choice.targetSceneId,
      stepId: choice.targetStepId,
      href: `/scenes/${encodeURIComponent(choice.targetSceneId)}`,
    }));
    const studioCtas =
      step.ctas.length > 0
        ? step.ctas.map(editorCtaFromPortableEntry)
        : restoredMetadataCtas(source, step.id);
    if (step.cta && step.ctas.length === 0) {
      const canonicalCta = editorCtaFromPortable(step.cta, step.id);
      if (studioCtas.length) {
        const primaryIndex = Math.max(
          0,
          studioCtas.findIndex((candidate) => candidate.variant !== 'secondary'),
        );
        const previous = studioCtas[primaryIndex];
        studioCtas[primaryIndex] = {
          ...canonicalCta,
          id: previous?.id ?? canonicalCta.id,
          variant: 'primary',
        };
      } else {
        studioCtas.push(canonicalCta);
      }
    }
    editor.ctas = studioCtas;
    editor.ctaEdited = false;
    editor.outputVisibility = {
      interactive: step.presentation.visibility.interactive,
      guide: step.presentation.visibility.guide,
      motion: step.presentation.visibility.motion,
      social: step.presentation.visibility.launchMedia,
    };
    return editor;
  });

  const translations = restoredTranslations(source, sidecars);
  return {
    version: 1,
    id: source.id,
    title: source.title,
    description: source.description ?? '',
    audience: source.audience.join(', '),
    tags: [...source.tags],
    steps,
    theme: restoredTheme(source, sidecars),
    portableSource: source,
    portableAssets: { ...assets },
    portableSidecars: { ...sidecars },
    translations: Object.keys(translations).length > 0 ? translations : undefined,
  };
}

function parseLegacyEditorScene(source: string): EditorScene | null {
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) return null;
  const raw = objectValue(document.toJS({ maxAliasCount: 0 }));
  if (!raw || raw.version !== 1 || typeof raw.id !== 'string' || typeof raw.title !== 'string') {
    return null;
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 10_000) return null;
  const seen = new Set<string>();
  const steps = raw.steps.map((candidate, index) => {
    const value = objectValue(candidate);
    const id = stringValue(value?.id, `step-${index + 1}`);
    if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(id) || seen.has(id)) {
      throw new PortableFileError(
        'The legacy Scene contains invalid or duplicate Step IDs.',
        [`steps.${index}.id: ${id}`],
        'invalid-yaml',
      );
    }
    seen.add(id);
    const step = defaultStep(id, stringValue(value?.image) || undefined);
    step.title = stringValue(value?.title, `Step ${index + 1}`);
    step.instruction = stringValue(value?.instruction);
    step.caption = stringValue(value?.caption);
    step.notes = stringValue(value?.notes);
    step.alt = stringValue(value?.alt);
    step.type = ['screen', 'choice', 'end', 'intro', 'separator'].includes(stringValue(value?.type))
      ? (value!.type as EditorStep['type'])
      : 'screen';
    step.durationMs = Math.max(250, Math.min(120_000, numberValue(value?.durationMs, 2_400)));
    step.autoAdvance = booleanValue(value?.autoAdvance, false);
    return step;
  });
  const theme = objectValue(raw.theme);
  return {
    version: 1,
    id: raw.id,
    title: raw.title,
    description: stringValue(raw.description),
    audience: stringValue(raw.audience),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((value): value is string => typeof value === 'string')
      : [],
    steps,
    theme: {
      accent: stringValue(theme?.accent, '#b83b24'),
      paper: stringValue(theme?.paper, '#fbf7ef'),
      ink: stringValue(theme?.ink, '#191816'),
      radius: Math.max(0, Math.min(40, numberValue(theme?.radius, 14))),
      frame: theme?.frame === 'light' ? 'light' : 'dark',
    },
  };
}

function inlineAssets(source: Scene): Record<string, string> {
  const metadata = objectValue(source.metadata);
  const values = objectValue(metadata?.[INLINE_ASSET_KEY]);
  if (!values) return {};
  const result: Record<string, string> = {};
  for (const [path, value] of Object.entries(values)) {
    if (isSafeArchivePath(path) && typeof value === 'string' && fromDataUri(value)) {
      result[path] = value;
    }
  }
  return result;
}

function inlineSidecars(source: Scene): Record<string, string> {
  const metadata = objectValue(source.metadata);
  const values = objectValue(metadata?.[SIDECARS_KEY]);
  if (!values) return {};
  const result: Record<string, string> = {};
  for (const [path, value] of Object.entries(values)) {
    if (isSafeArchivePath(path) && typeof value === 'string' && fromDataUri(value)) {
      result[path] = value;
    }
  }
  return result;
}

function referencedSidecarPaths(source: Scene): string[] {
  const paths = new Set<string>();
  if (source.narrativeFile) paths.add(source.narrativeFile);
  if (source.theme?.file) paths.add(source.theme.file);
  for (const locale of source.locales) paths.add(locale.file);
  if (source.automation.replayPath) paths.add(source.automation.replayPath);
  return [...paths];
}

function hasExtensionReplayDraft(source: Scene): boolean {
  const metadata = objectValue(source.metadata);
  return metadata?.recorder === 'browser-extension' && metadata.replayDraft === true;
}

function isReservedSidecarPath(path: string): boolean {
  return /(^|\/)(?:scene|project)\.ya?ml$/iu.test(path);
}

function sidecarMediaType(path: string): string {
  if (/\.mdx?$/iu.test(path)) return 'text/markdown';
  if (/\.ya?ml$/iu.test(path)) return 'application/yaml';
  if (/\.[cm]?[jt]sx?$/iu.test(path)) return 'text/plain';
  return 'application/octet-stream';
}

function validateSidecar(path: string, bytes: Uint8Array): void {
  if (!isSafeArchivePath(path) || isReservedSidecarPath(path)) {
    throw new PortableFileError(
      'A Scene references a sidecar path reserved for portable manifests.',
      [path],
      'invalid-archive',
    );
  }
  if (bytes.byteLength > MAX_SIDECAR_BYTES) {
    throw new PortableFileError(
      'A referenced Scene sidecar exceeds the 10 MB safety limit.',
      [path],
      'invalid-archive',
    );
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

async function verifySceneAssets(
  source: Scene,
  yamlPath: string,
  files: Readonly<Record<string, Uint8Array>>,
  allowInlineSidecars = false,
): Promise<SceneArchiveSource> {
  const directory = archiveDirectory(yamlPath);
  const assets: Record<string, string> = {};
  const sidecars: Record<string, string> = {};
  const embedded = inlineAssets(source);
  const embeddedSidecars = allowInlineSidecars ? inlineSidecars(source) : {};
  const declaredPaths = new Set(source.assets.map((asset) => asset.path));
  for (const step of source.steps) {
    for (const state of [step.states.before, step.states.after]) {
      if (state?.screenshot && !declaredPaths.has(state.screenshot.path)) {
        throw new PortableFileError(
          'A screenshot is not declared in the Scene asset manifest.',
          [`Step ${step.id}: ${state.screenshot.path}`],
          'missing-asset',
        );
      }
    }
  }
  for (const asset of source.assets) {
    const archivePath = joinArchivePath(directory, asset.path);
    const bytes = files[archivePath];
    if (!bytes) {
      const fallback = embedded[asset.path];
      if (fallback) {
        const decoded = fromDataUri(fallback);
        if (!decoded || decoded.bytes.byteLength !== asset.byteLength) {
          throw new PortableFileError(
            'An inline asset does not match its manifest.',
            [asset.path],
            'corrupt-asset',
          );
        }
        const digest = await sha256(decoded.bytes);
        if (digest !== asset.sha256) {
          throw new PortableFileError(
            'An inline asset failed its integrity check.',
            [`${asset.path}: expected ${asset.sha256}, found ${digest}`],
            'corrupt-asset',
          );
        }
        validateAssetContent(decoded.bytes, asset.mediaType, asset.role, asset.path);
        assets[asset.path] = fallback;
        continue;
      }
      throw new PortableFileError(
        'The Scene archive is incomplete.',
        [`Missing asset: ${asset.path}`],
        'missing-asset',
      );
    }
    if (bytes.byteLength !== asset.byteLength) {
      throw new PortableFileError(
        'An asset does not match its manifest.',
        [`${asset.path}: expected ${asset.byteLength} bytes, found ${bytes.byteLength}`],
        'corrupt-asset',
      );
    }
    validateAssetContent(bytes, asset.mediaType, asset.role, asset.path);
    const digest = await sha256(bytes);
    if (digest !== asset.sha256) {
      throw new PortableFileError(
        'An asset failed its integrity check.',
        [`${asset.path}: expected ${asset.sha256}, found ${digest}`],
        'corrupt-asset',
      );
    }
    assets[asset.path] = toDataUri(bytes, asset.mediaType);
  }
  for (const path of referencedSidecarPaths(source)) {
    const archivePath = joinArchivePath(directory, path);
    const bytes = files[archivePath];
    if (bytes) {
      validateSidecar(path, bytes);
      sidecars[path] = toDataUri(bytes, sidecarMediaType(path));
      continue;
    }
    const fallback = embeddedSidecars[path];
    const decoded = fallback ? fromDataUri(fallback) : null;
    if (decoded) {
      validateSidecar(path, decoded.bytes);
      sidecars[path] = fallback!;
      continue;
    }
    throw new PortableFileError(
      'The Scene archive is missing an explicitly referenced sidecar.',
      [`Missing sidecar: ${path}`],
      'missing-sidecar',
    );
  }
  if (hasExtensionReplayDraft(source) && !sidecars[EXTENSION_REPLAY_PATH]) {
    const archivePath = joinArchivePath(directory, EXTENSION_REPLAY_PATH);
    const bytes = files[archivePath];
    const fallback = embeddedSidecars[EXTENSION_REPLAY_PATH];
    const decoded = fallback ? fromDataUri(fallback) : null;
    if (bytes) {
      validateSidecar(EXTENSION_REPLAY_PATH, bytes);
      sidecars[EXTENSION_REPLAY_PATH] = toDataUri(bytes, sidecarMediaType(EXTENSION_REPLAY_PATH));
    } else if (decoded) {
      validateSidecar(EXTENSION_REPLAY_PATH, decoded.bytes);
      sidecars[EXTENSION_REPLAY_PATH] = fallback!;
    }
  }
  return { source, yamlPath, assets, sidecars };
}

function unzipSafely(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new PortableFileError(
      'The ZIP archive exceeds the 50 MB import limit.',
      [],
      'invalid-archive',
    );
  }
  preflightZip(bytes);
  let entries = 0;
  let expandedBytes = 0;
  try {
    const files = unzipSync(bytes, {
      filter(entry) {
        entries += 1;
        expandedBytes += entry.originalSize;
        if (!isSafeArchiveEntryPath(entry.name)) {
          throw new PortableFileError(
            'The ZIP archive contains an unsafe path.',
            [entry.name],
            'invalid-archive',
          );
        }
        if (
          entries > MAX_ARCHIVE_ENTRIES ||
          entry.originalSize > MAX_ENTRY_BYTES ||
          expandedBytes > MAX_EXPANDED_BYTES
        ) {
          throw new PortableFileError(
            'The ZIP archive expands beyond Studio’s safety limits.',
            [],
            'invalid-archive',
          );
        }
        return !entry.name.startsWith('__MACOSX/') && !entry.name.endsWith('/');
      },
    });
    let actualBytes = 0;
    for (const [path, value] of Object.entries(files)) {
      actualBytes += value.byteLength;
      if (value.byteLength > MAX_ENTRY_BYTES || actualBytes > MAX_EXPANDED_BYTES) {
        throw new PortableFileError(
          'The ZIP archive expanded beyond Studio’s safety limits.',
          [path],
          'invalid-archive',
        );
      }
    }
    return files;
  } catch (error) {
    if (error instanceof PortableFileError) throw error;
    throw new PortableFileError(
      'The ZIP archive is damaged or uses an unsupported compression method.',
      describeError(error),
      'invalid-archive',
    );
  }
}

function parseScene(source: string): Scene {
  try {
    return parseSceneYaml(source);
  } catch (error) {
    const legacy = parseLegacyEditorScene(source);
    if (legacy) {
      throw new PortableFileError(
        'This legacy Studio YAML must be imported through the legacy path.',
        [],
        'invalid-yaml',
      );
    }
    rethrowYaml(error);
  }
}

export async function importPortableBytes(
  bytes: Uint8Array,
  filename: string,
): Promise<PortableImportResult> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const files = unzipSafely(bytes);
    const yamlPaths = Object.keys(files).filter((path) => /(^|\/)scene\.ya?ml$/iu.test(path));
    const projectPath = Object.keys(files).find((path) => /(^|\/)project\.ya?ml$/iu.test(path));
    if (yamlPaths.length === 0 && !projectPath) {
      throw new PortableFileError(
        'No scene.yaml or project.yaml was found in this archive.',
        [],
        'invalid-archive',
      );
    }
    let project: Project | undefined;
    if (projectPath) {
      try {
        project = parseProjectYaml(strFromU8(files[projectPath]!));
      } catch (error) {
        rethrowYaml(error);
      }
    }
    const sceneIds = new Set<string>();
    const scenes: EditorScene[] = [];
    for (const yamlPath of yamlPaths.sort()) {
      let source: Scene;
      try {
        source = parseSceneYaml(strFromU8(files[yamlPath]!));
      } catch (error) {
        throw new PortableFileError(
          `The Scene at ${yamlPath} is invalid.`,
          describeError(error),
          'invalid-yaml',
        );
      }
      if (sceneIds.has(source.id)) {
        throw new PortableFileError(
          'The archive contains duplicate Scene IDs.',
          [source.id],
          'invalid-archive',
        );
      }
      sceneIds.add(source.id);
      const verified = await verifySceneAssets(source, yamlPath, files);
      scenes.push(toEditorScene(verified.source, verified.assets, verified.sidecars));
    }
    return {
      kind: project || scenes.length !== 1 ? 'project' : 'scene',
      scenes,
      project,
      warnings:
        project && scenes.length === 0
          ? ['The project contains no Scene source files.']
          : !project && scenes.length > 1
            ? ['Imported a multi-Scene archive without project metadata.']
            : [],
    };
  }

  if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) {
    throw new PortableFileError(
      'Choose a .yaml, .yml, or .zip Scenebook file.',
      [],
      'invalid-file',
    );
  }
  if (bytes.byteLength > 10_000_000) {
    throw new PortableFileError(
      'The YAML file exceeds the 10 MB safety limit.',
      [],
      'invalid-yaml',
    );
  }
  const source = strFromU8(bytes);
  try {
    const scene = parseSceneYaml(source);
    const verified = await verifySceneAssets(scene, 'scene.yaml', {}, true);
    return {
      kind: 'scene',
      scenes: [toEditorScene(verified.source, verified.assets, verified.sidecars)],
      warnings: [],
    };
  } catch (sceneError) {
    const legacy = parseLegacyEditorScene(source);
    if (legacy) {
      return {
        kind: 'scene',
        scenes: [legacy],
        warnings: ['Imported a legacy Studio Scene; export it to upgrade to the canonical format.'],
      };
    }
    try {
      const project = parseProjectYaml(source);
      return {
        kind: 'project',
        scenes: [],
        project,
        warnings: [
          'Project YAML contains configuration only; import a project ZIP to include Scenes.',
        ],
      };
    } catch {
      rethrowYaml(sceneError);
    }
  }
}

function rectAround(x: number, y: number, width: number, height: number) {
  const safeWidth = Math.max(0.001, Math.min(1, width));
  const safeHeight = Math.max(0.001, Math.min(1, height));
  return {
    x: Math.max(0, Math.min(1 - safeWidth, x - safeWidth / 2)),
    y: Math.max(0, Math.min(1 - safeHeight, y - safeHeight / 2)),
    width: safeWidth,
    height: safeHeight,
  };
}

type PortableAnnotation = Step['presentation']['annotations'][number];
type PortableMask = Step['masks'][number];

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * 16;
}

function samePoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return sameNumber(left.x, right.x) && sameNumber(left.y, right.y);
}

function projectedFrameKind(frame: Step['presentation']['frame']): EditorStep['frame'] {
  if (frame?.kind === 'device') return 'mobile';
  if (frame?.kind === 'none') return 'none';
  return 'browser';
}

function frameForExport(existing: Step | undefined, editor: EditorStep) {
  const frame = existing?.presentation.frame;
  if (existing && projectedFrameKind(frame) === editor.frame) return frame;
  return {
    kind: editor.frame === 'mobile' ? ('device' as const) : editor.frame,
    showAddressBar: editor.frame === 'browser',
  };
}

function cropForExport(existing: Step | undefined, editor: EditorStep) {
  const crop = existing?.presentation.crop;
  const focalPoint = crop?.focalPoint ?? { x: 0.5, y: 0.5 };
  const zoom = crop?.zoom ?? 1;
  if (existing && samePoint(focalPoint, editor.crop) && sameNumber(zoom, editor.crop.zoom)) {
    return crop;
  }
  return {
    rect: crop?.rect ?? { x: 0, y: 0, width: 1, height: 1 },
    focalPoint: { x: normalizedPoint(editor.crop.x), y: normalizedPoint(editor.crop.y) },
    zoom: Math.max(1, Math.min(10, editor.crop.zoom)),
  };
}

function projectedHotspot(step: Step) {
  const annotation = step.presentation.annotations.find(
    (candidate) => candidate.kind === 'hotspot' && candidate.rect,
  );
  const rect = annotation?.rect ?? step.target?.normalizedRect;
  if (!rect) return undefined;
  return {
    annotation,
    rect,
    point: centerOf(rect),
    label: annotation?.label ?? step.target?.accessibleName ?? 'Continue',
  };
}

function hotspotProjectionMatches(step: Step, editor: EditorStep): boolean {
  const projected = projectedHotspot(step);
  if (!projected || !editor.hotspot) return projected === undefined && editor.hotspot === undefined;
  return (
    samePoint(projected.point, editor.hotspot) &&
    sameNumber(projected.rect.width, editor.hotspot.width ?? 0.045) &&
    sameNumber(projected.rect.height, editor.hotspot.height ?? 0.045) &&
    projected.label === editor.hotspot.label
  );
}

function cursorForExport(existing: Step | undefined, editor: EditorStep) {
  const cursor = existing?.presentation.cursor;
  const hotspot = existing ? projectedHotspot(existing) : undefined;
  const projectedPosition = cursor?.position ?? hotspot?.point ?? { x: 0.5, y: 0.5 };
  const projectionMatches =
    existing !== undefined &&
    samePoint(projectedPosition, editor.cursor) &&
    (cursor?.visible ?? false) === editor.cursor.visible &&
    (cursor?.clickAtMs !== undefined) === editor.cursor.click &&
    (cursor?.clickAtMs ?? undefined) === editor.cursor.clickAtMs &&
    (cursor?.style ?? 'default') === (editor.cursor.style ?? 'default') &&
    (cursor?.path.length ?? 0) === (editor.cursor.path?.length ?? 0) &&
    (cursor?.path ?? []).every((keyframe, index) => {
      const editorKeyframe = editor.cursor.path?.[index];
      return (
        editorKeyframe !== undefined &&
        keyframe.atMs === editorKeyframe.atMs &&
        samePoint(keyframe.point, editorKeyframe)
      );
    });
  if (projectionMatches) return cursor;
  const durationMs = Math.max(250, Math.min(120_000, Math.round(editor.durationMs ?? 2_400)));
  return {
    ...(cursor ?? {}),
    visible: editor.cursor.visible,
    position: { x: normalizedPoint(editor.cursor.x), y: normalizedPoint(editor.cursor.y) },
    path: [...(editor.cursor.path ?? [])]
      .map((keyframe) => ({
        atMs: Math.max(0, Math.min(durationMs, Math.round(keyframe.atMs))),
        point: { x: normalizedPoint(keyframe.x), y: normalizedPoint(keyframe.y) },
      }))
      .sort((left, right) => left.atMs - right.atMs),
    clickAtMs: editor.cursor.click
      ? Math.max(0, Math.min(durationMs, Math.round(editor.cursor.clickAtMs ?? 300)))
      : undefined,
    style: editor.cursor.style ?? ('default' as const),
  };
}

function projectedAnnotationKind(
  annotation: PortableAnnotation,
): NonNullable<EditorStep['annotations'][number]['kind']> {
  if (annotation.kind === 'spotlight') return 'spotlight';
  if (annotation.kind === 'arrow') return 'arrow';
  return 'callout';
}

function annotationProjectionMatches(
  annotation: PortableAnnotation,
  editor: EditorStep['annotations'][number],
): boolean {
  const point = annotation.rect
    ? centerOf(annotation.rect)
    : (annotation.to ?? annotation.from ?? { x: 0.5, y: 0.5 });
  return (
    annotation.id === editor.id &&
    projectedAnnotationKind(annotation) === (editor.kind ?? 'note') &&
    samePoint(point, editor) &&
    (annotation.text ?? annotation.label ?? annotation.kind) === editor.text &&
    (annotation.rect?.width ?? undefined) === editor.width &&
    (annotation.rect?.height ?? undefined) === editor.height &&
    (annotation.from?.x ?? undefined) === editor.fromX &&
    (annotation.from?.y ?? undefined) === editor.fromY &&
    annotation.color === editor.color
  );
}

function annotationsProjectionMatches(step: Step, editor: EditorStep): boolean {
  if (!hotspotProjectionMatches(step, editor)) return false;
  const annotations = step.presentation.annotations.filter(
    (annotation) => annotation.kind !== 'hotspot',
  );
  return (
    annotations.length === editor.annotations.length &&
    annotations.every((annotation, index) => {
      const editorAnnotation = editor.annotations[index];
      return (
        editorAnnotation !== undefined && annotationProjectionMatches(annotation, editorAnnotation)
      );
    })
  );
}

function annotationsForExport(
  existing: Step | undefined,
  editor: EditorStep,
): PortableAnnotation[] {
  if (existing && annotationsProjectionMatches(existing, editor)) {
    return existing.presentation.annotations;
  }
  const hotspot = editor.hotspot
    ? (() => {
        const imported = existing ? projectedHotspot(existing) : undefined;
        if (existing && imported?.annotation && hotspotProjectionMatches(existing, editor)) {
          return imported.annotation;
        }
        return {
          id: `${editor.id}-hotspot`,
          kind: 'hotspot' as const,
          rect: rectAround(
            editor.hotspot.x,
            editor.hotspot.y,
            editor.hotspot.width ?? 0.045,
            editor.hotspot.height ?? 0.045,
          ),
          label: editor.hotspot.label,
        };
      })()
    : undefined;
  const annotations = editor.annotations.map((annotation): PortableAnnotation => {
    const imported = existing?.presentation.annotations.find(
      (candidate) => candidate.id === annotation.id && candidate.kind !== 'hotspot',
    );
    if (imported && annotationProjectionMatches(imported, annotation)) return imported;
    if (annotation.kind === 'arrow') {
      return {
        id: annotation.id,
        kind: 'arrow',
        from: {
          x: normalizedPoint(annotation.fromX ?? annotation.x - 0.08),
          y: normalizedPoint(annotation.fromY ?? annotation.y),
        },
        to: { x: annotation.x, y: annotation.y },
        text: annotation.text,
        color: annotation.color,
      };
    }
    return {
      id: annotation.id,
      kind: annotation.kind === 'spotlight' ? 'spotlight' : 'callout',
      rect: rectAround(
        annotation.x,
        annotation.y,
        annotation.width ?? (annotation.kind === 'spotlight' ? 0.16 : 0.2),
        annotation.height ?? (annotation.kind === 'spotlight' ? 0.16 : 0.1),
      ),
      text: annotation.text,
      color: annotation.color,
    };
  });
  return [...(hotspot ? [hotspot] : []), ...annotations];
}

function maskProjectionMatches(mask: PortableMask, editor: EditorStep['masks'][number]): boolean {
  return (
    mask.rect !== undefined &&
    mask.id === editor.id &&
    sameNumber(mask.rect.x, editor.x) &&
    sameNumber(mask.rect.y, editor.y) &&
    sameNumber(mask.rect.width, editor.width) &&
    sameNumber(mask.rect.height, editor.height) &&
    mask.mode === editor.mode &&
    mask.source === editor.source &&
    mask.scope === editor.scope &&
    mask.classification === editor.classification &&
    mask.locator === editor.locator &&
    (mask.reason ?? 'Redacted content') === (editor.label ?? 'Redacted content')
  );
}

function masksForExport(existing: Step | undefined, editor: EditorStep): PortableMask[] {
  for (const mask of editor.masks) {
    if (mask.mode === 'blur' && (mask.source !== 'manual' || mask.classification !== 'custom')) {
      throw new PortableFileError(
        'Blur is only available for manual presentation regions that do not contain sensitive data.',
        [
          `Mask ${mask.id} is ${mask.source}/${mask.classification}. Keep privacy masks opaque and use blur only for user-authored presentation regions.`,
        ],
      );
    }
  }
  const editableMasks = existing?.masks.filter((mask) => mask.rect) ?? [];
  if (
    existing &&
    editableMasks.length === editor.masks.length &&
    editableMasks.every((mask, index) => {
      const editorMask = editor.masks[index];
      return editorMask !== undefined && maskProjectionMatches(mask, editorMask);
    })
  ) {
    return existing.masks;
  }
  const masks = editor.masks.map((mask): PortableMask => {
    const imported = existing?.masks.find(
      (candidate) => candidate.id === mask.id && candidate.rect,
    );
    if (imported && maskProjectionMatches(imported, mask)) return imported;
    const projectedLabel = imported?.reason ?? 'Redacted content';
    return {
      ...(imported ?? {
        id: mask.id,
        mode: mask.mode,
        source: mask.source,
        scope: mask.scope,
        classification: mask.classification,
      }),
      mode: mask.mode,
      source: mask.source,
      scope: mask.scope,
      classification: mask.classification,
      locator: mask.locator,
      rect: {
        x: Math.max(0, Math.min(1 - Math.min(1, mask.width), mask.x)),
        y: Math.max(0, Math.min(1 - Math.min(1, mask.height), mask.y)),
        width: Math.max(0.001, Math.min(1, mask.width)),
        height: Math.max(0.001, Math.min(1, mask.height)),
      },
      reason: (mask.label ?? 'Redacted content') === projectedLabel ? imported?.reason : mask.label,
    };
  });
  const unresolved = existing?.masks.filter((mask) => mask.rect === undefined) ?? [];
  return [...masks, ...unresolved];
}

function portableKind(type: EditorStep['type']): Step['kind'] {
  if (type === 'screen') return 'browser';
  return type;
}

function portableId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._:-]+/gu, '-')
    .replaceAll(/^[^a-z0-9]+|[^a-z0-9._:-]+$/gu, '')
    .slice(0, 128);
}

function portableCtaFromEditor(cta: EditorCta, stepId: string): NonNullable<Step['cta']> {
  const kind =
    cta.kind ??
    (cta.event === 'restart'
      ? 'restart'
      : cta.targetSceneId
        ? 'view-scene'
        : cta.fields?.length
          ? 'form'
          : 'external');
  const label = cta.label.trim();
  if (!label) {
    throw new PortableFileError(
      'An end-card action needs a label before export.',
      [`Step ${stepId}`],
      'invalid-file',
    );
  }
  const urlKinds = ['open-product', 'read-docs', 'book-call', 'external'];
  if (urlKinds.includes(kind) && !cta.href) {
    throw new PortableFileError(
      'This end-card action needs an HTTP, HTTPS, or mailto URL.',
      [`Step ${stepId}: ${label}`],
      'invalid-file',
    );
  }
  if (urlKinds.includes(kind) && cta.href) {
    try {
      const url = new URL(cta.href);
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol))
        throw new Error('unsafe protocol');
    } catch {
      throw new PortableFileError(
        'This end-card action needs a valid HTTP, HTTPS, or mailto URL.',
        [`Step ${stepId}: ${label}`],
        'invalid-file',
      );
    }
  }
  if (kind === 'view-scene' && !cta.targetSceneId?.trim()) {
    throw new PortableFileError(
      'A view-Scene action needs a destination Scene ID.',
      [`Step ${stepId}: ${label}`],
      'invalid-file',
    );
  }
  if (
    kind === 'view-scene' &&
    cta.targetSceneId &&
    !/^[a-z0-9][a-z0-9._:-]*$/u.test(cta.targetSceneId.trim())
  ) {
    throw new PortableFileError(
      'A view-Scene action has an invalid destination Scene ID.',
      [`Step ${stepId}: ${cta.targetSceneId}`],
      'invalid-file',
    );
  }
  const fields = structuredClone(cta.fields ?? []);
  if (kind === 'form' && fields.length === 0) {
    throw new PortableFileError(
      'A form action needs at least one field.',
      [`Step ${stepId}: ${label}`],
      'invalid-file',
    );
  }
  if (fields.length > 20) {
    throw new PortableFileError(
      'A form action can contain at most 20 fields.',
      [`Step ${stepId}: ${label}`],
      'invalid-file',
    );
  }
  if (kind === 'form' && cta.webhookId && !/^[a-z0-9][a-z0-9._:-]*$/u.test(cta.webhookId.trim())) {
    throw new PortableFileError(
      'A form action has an invalid webhook ID.',
      [`Step ${stepId}: ${cta.webhookId}`],
      'invalid-file',
    );
  }
  const fieldIds = new Set<string>();
  for (const field of fields) {
    if (
      !/^[a-z0-9][a-z0-9._:-]*$/u.test(field.id.trim()) ||
      fieldIds.has(field.id.trim()) ||
      !field.label.trim()
    ) {
      throw new PortableFileError(
        'Every form field needs a unique valid ID and a label.',
        [`Step ${stepId}: ${label}`],
        'invalid-file',
      );
    }
    fieldIds.add(field.id.trim());
    if (field.type === 'checkbox' && field.required && !field.consent) {
      throw new PortableFileError(
        'A required checkbox must be marked as explicit consent.',
        [`Step ${stepId}: ${field.label}`],
        'invalid-file',
      );
    }
  }
  return {
    kind,
    label,
    url: urlKinds.includes(kind) ? cta.href : undefined,
    targetSceneId: kind === 'view-scene' ? cta.targetSceneId?.trim() : undefined,
    webhookId: kind === 'form' ? cta.webhookId?.trim() || undefined : undefined,
    fields: kind === 'form' ? fields : [],
  };
}

function portableStepCtaFromEditor(cta: EditorCta, stepId: string): StepCta {
  const id = portableId(cta.id);
  if (!id) {
    throw new PortableFileError(
      'Every end-card action needs a stable ID before export.',
      [`Step ${stepId}: ${cta.label}`],
      'invalid-file',
    );
  }
  return {
    id,
    variant: cta.variant === 'secondary' ? 'secondary' : 'primary',
    ...portableCtaFromEditor(cta, stepId),
  };
}

function portableTranslations(
  translations: EditorScene['translations'],
  existing: Scene['translations'] = {},
): Record<string, PortableSceneTranslation> {
  return Object.fromEntries(
    Object.entries(translations ?? {}).map(([locale, translation]) => [
      locale,
      {
        ...(existing[locale] ?? { steps: {} }),
        ...(translation.title !== undefined ? { title: translation.title } : {}),
        ...(translation.description !== undefined ? { description: translation.description } : {}),
        steps: {
          ...(existing[locale]?.steps ?? {}),
          ...Object.fromEntries(
            Object.entries(translation.steps).map(([stepId, step]) => [
              stepId,
              {
                ...(existing[locale]?.steps[stepId] ?? { choices: {}, ctas: {} }),
                ...(step.title !== undefined ? { title: step.title } : {}),
                ...(step.instruction !== undefined ? { instruction: step.instruction } : {}),
                ...(step.caption !== undefined ? { caption: step.caption } : {}),
                ...(step.alt !== undefined ? { altText: step.alt } : {}),
              },
            ]),
          ),
        },
      },
    ]),
  );
}

async function buildScene(
  scene: EditorScene,
  requireCompleteAssets: boolean,
  embedInlineAssets: boolean,
): Promise<BuiltScene> {
  const base = scene.portableSource;
  const files: Record<string, Uint8Array> = {};
  const generatedAssets = new Map<
    string,
    { sha256: string; path: string; mediaType: string; byteLength: number; role: 'screenshot' }
  >();
  const inline: Record<string, string> = {};
  const inlineSidecarData: Record<string, string> = {};

  for (const [path, embedded] of Object.entries(scene.portableAssets ?? {})) {
    if (!isSafeArchivePath(path)) continue;
    const decoded = await fromEmbeddedUrl(embedded, MAX_ENTRY_BYTES, path);
    if (!decoded) continue;
    files[path] = decoded.bytes;
    inline[path] = toDataUri(decoded.bytes, decoded.mediaType);
  }

  const sidecarPaths = new Set(base ? referencedSidecarPaths(base) : []);
  if (base && hasExtensionReplayDraft(base) && scene.portableSidecars?.[EXTENSION_REPLAY_PATH]) {
    sidecarPaths.add(EXTENSION_REPLAY_PATH);
  }
  for (const path of sidecarPaths) {
    const encoded = scene.portableSidecars?.[path];
    const decoded = encoded ? await fromEmbeddedUrl(encoded, MAX_SIDECAR_BYTES, path) : null;
    if (!decoded) {
      throw new PortableFileError(
        'This Scene references a sidecar that is not available locally.',
        [path, 'Re-import the complete Scene ZIP before exporting this Scene.'],
        'missing-sidecar',
      );
    }
    validateSidecar(path, decoded.bytes);
    const existing = files[path];
    if (existing && !sameBytes(existing, decoded.bytes)) {
      throw new PortableFileError(
        'A referenced sidecar conflicts with another portable file.',
        [path],
        'invalid-file',
      );
    }
    files[path] = decoded.bytes;
    inlineSidecarData[path] = toDataUri(decoded.bytes, sidecarMediaType(path));
  }

  const steps: Step[] = [];
  for (const editor of scene.steps) {
    const existing = base?.steps.find((step) => step.id === editor.id);
    let screenshot:
      | { sha256: string; path: string; mediaType: string; byteLength: number; role: 'screenshot' }
      | undefined;
    if (editor.image?.startsWith('data:') || editor.image?.startsWith('blob:')) {
      const decoded = await fromEmbeddedUrl(
        editor.image,
        MAX_SCREENSHOT_BYTES,
        `Step ${editor.id}`,
      );
      if (!decoded) {
        throw new PortableFileError(
          'A screenshot uses an invalid data URI.',
          [`Step ${editor.id}`],
          'corrupt-asset',
        );
      }
      validateAssetContent(decoded.bytes, decoded.mediaType, 'screenshot', `Step ${editor.id}`);
      const digest = await sha256(decoded.bytes);
      const path = `assets/${digest}.${extensionFor(decoded.mediaType)}`;
      screenshot = {
        sha256: digest,
        path,
        mediaType: decoded.mediaType,
        byteLength: decoded.bytes.byteLength,
        role: 'screenshot',
      };
      generatedAssets.set(digest, screenshot);
      files[path] = decoded.bytes;
      inline[path] = toDataUri(decoded.bytes, decoded.mediaType);
    } else if (editor.image?.startsWith('/') || /^https?:\/\//iu.test(editor.image ?? '')) {
      const remote = /^https?:\/\//iu.test(editor.image ?? '');
      let response: Response;
      try {
        response = await fetch(
          editor.image!,
          remote
            ? {
                credentials: 'omit',
                mode: 'cors',
                redirect: 'follow',
                referrerPolicy: 'no-referrer',
              }
            : { credentials: 'same-origin' },
        );
      } catch (error) {
        throw new PortableFileError(
          `${remote ? 'The remote' : 'The local'} screenshot for Step ${editor.id} could not be read for export.`,
          [`Step ${editor.id}: ${error instanceof Error ? error.message : editor.image}`],
          'missing-asset',
        );
      }
      const advertisedBytes = Number(response.headers.get('content-length') ?? 0);
      if (!response.ok || advertisedBytes > MAX_SCREENSHOT_BYTES) {
        throw new PortableFileError(
          `${remote ? 'The remote' : 'The local'} screenshot for Step ${editor.id} could not be bundled.`,
          [`Step ${editor.id}: ${response.status || 'file exceeds 25 MB'}`],
          'missing-asset',
        );
      }
      const mediaType = response.headers.get('content-type')?.split(';')[0] ?? '';
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedResponse(response, `Step ${editor.id}`);
      } catch (error) {
        if (error instanceof PortableFileError) throw error;
        throw new PortableFileError(
          `${remote ? 'The remote' : 'The local'} screenshot stream for Step ${editor.id} ended before export completed.`,
          [`Step ${editor.id}: ${error instanceof Error ? error.message : editor.image}`],
          'missing-asset',
        );
      }
      validateAssetContent(bytes, mediaType, 'screenshot', editor.image!);
      const digest = await sha256(bytes);
      const path = `assets/${digest}.${extensionFor(mediaType)}`;
      screenshot = {
        sha256: digest,
        path,
        mediaType,
        byteLength: bytes.byteLength,
        role: 'screenshot',
      };
      generatedAssets.set(digest, screenshot);
      files[path] = bytes;
      inline[path] = toDataUri(bytes, mediaType);
    } else {
      screenshot = existing
        ? (selectedState(existing)?.screenshot as typeof screenshot)
        : undefined;
    }

    const kind =
      existing && editorKind(existing.kind) === editor.type
        ? existing.kind
        : portableKind(editor.type);
    const existingState = existing ? selectedState(existing) : undefined;
    const statePhase = existing?.presentation.state === 'after' ? 'after' : 'before';
    const browserState = {
      id: existingState?.id ?? `${editor.id}-${statePhase}`,
      route: existingState?.route ?? '/',
      title: existingState?.title,
      screenshot,
      viewport: existingState?.viewport ?? {
        width: editor.frame === 'mobile' ? 390 : 1_440,
        height: editor.frame === 'mobile' ? 844 : 900,
        deviceScaleFactor: 1,
        isMobile: editor.frame === 'mobile',
      },
      scroll: existingState?.scroll ?? { x: 0, y: 0 },
      capturedAt: existingState?.capturedAt,
    };
    const states =
      kind === 'browser' || screenshot || existingState
        ? { ...(existing?.states ?? {}), [statePhase]: browserState }
        : {};
    const annotations = annotationsForExport(existing, editor);
    const authoredCtas = editor.ctas.map((candidate) =>
      portableStepCtaFromEditor(candidate, editor.id),
    );
    const authoredCtaIds = new Set(authoredCtas.map((candidate) => candidate.id));
    if (authoredCtaIds.size !== authoredCtas.length) {
      throw new PortableFileError(
        'Every end-card action needs a unique stable ID.',
        [`Step ${editor.id}`],
        'invalid-file',
      );
    }
    const canonicalCtas =
      existing && !editor.ctaEdited && existing.ctas.length > 0 ? existing.ctas : authoredCtas;
    const primaryCta =
      canonicalCtas.find((candidate) => candidate.variant === 'primary') ?? canonicalCtas[0];
    const cta =
      existing && !editor.ctaEdited && existing.ctas.length === 0
        ? existing.cta
        : primaryCta
          ? {
              kind: primaryCta.kind,
              label: primaryCta.label,
              url: primaryCta.url,
              targetSceneId: primaryCta.targetSceneId,
              webhookId: primaryCta.webhookId,
              fields: structuredClone(primaryCta.fields),
            }
          : undefined;
    const portableStep: Step = {
      ...(existing ?? {}),
      id: editor.id,
      kind,
      title: editor.title || 'Untitled step',
      instruction: editor.instruction || undefined,
      caption: editor.caption || undefined,
      notes: editor.notes || undefined,
      altText: editor.alt || undefined,
      states,
      actions: existing?.actions ?? [],
      checks: existing?.checks ?? [],
      presentation: {
        ...(existing?.presentation ?? {}),
        durationMs: Math.max(250, Math.min(120_000, Math.round(editor.durationMs ?? 2_400))),
        frame: frameForExport(existing, editor),
        crop: cropForExport(existing, editor),
        cursor: cursorForExport(existing, editor),
        annotations,
        autoAdvance: editor.autoAdvance ?? false,
        transition: existing?.presentation.transition ?? 'fade',
        state:
          existing && editorKind(existing.kind) === editor.type
            ? existing.presentation.state
            : kind === 'browser'
              ? statePhase
              : 'before',
        visibility: {
          interactive: editor.outputVisibility.interactive,
          guide: editor.outputVisibility.guide,
          motion: editor.outputVisibility.motion,
          launchMedia: editor.outputVisibility.social,
        },
        practiceMode: existing?.presentation.practiceMode ?? false,
      },
      masks: masksForExport(existing, editor),
      choices:
        kind === 'choice'
          ? editor.choices.map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description,
              targetSceneId: choice.sceneId,
              targetStepId: choice.stepId,
            }))
          : [],
      ctas: canonicalCtas,
      cta,
    };
    steps.push(portableStep);
  }

  const assetsByHash = new Map(base?.assets.map((asset) => [asset.sha256, asset]) ?? []);
  for (const asset of generatedAssets.values()) assetsByHash.set(asset.sha256, asset);
  for (const asset of assetsByHash.values()) {
    if (!files[asset.path]) {
      const embedded = scene.portableAssets?.[asset.path];
      const decoded = embedded
        ? await fromEmbeddedUrl(embedded, MAX_ENTRY_BYTES, asset.path)
        : null;
      if (decoded) files[asset.path] = decoded.bytes;
      else if (requireCompleteAssets) {
        throw new PortableFileError(
          'This Scene references an asset that is not available locally.',
          [asset.path, 'Re-import the complete Scene ZIP or remove the missing screenshot.'],
          'missing-asset',
        );
      }
    }
  }

  const metadata: Record<string, unknown> = { ...(base?.metadata ?? {}) };
  if (embedInlineAssets && Object.keys(inline).length > 0) metadata[INLINE_ASSET_KEY] = inline;
  else delete metadata[INLINE_ASSET_KEY];
  if (embedInlineAssets && Object.keys(inlineSidecarData).length > 0) {
    metadata[SIDECARS_KEY] = inlineSidecarData;
  } else {
    delete metadata[SIDECARS_KEY];
  }
  delete metadata[REMOTE_IMAGE_KEY];
  const studioCtas = Object.fromEntries(
    scene.steps.filter((step) => step.ctas.length > 0).map((step) => [step.id, step.ctas]),
  );
  if (Object.keys(studioCtas).length > 0) {
    metadata[CTA_KEY] = JSON.parse(JSON.stringify(studioCtas)) as unknown;
  } else delete metadata[CTA_KEY];
  if (scene.translations && Object.keys(scene.translations).length > 0) {
    metadata[TRANSLATIONS_KEY] = JSON.parse(JSON.stringify(scene.translations)) as unknown;
  } else {
    delete metadata[TRANSLATIONS_KEY];
  }

  const now = new Date().toISOString();
  const source: Scene = {
    schemaVersion: 1,
    id: scene.id,
    slug: scene.id
      .replaceAll(/[._:]+/gu, '-')
      .replaceAll(/-+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 100),
    title: scene.title || 'Untitled Scene',
    description: scene.description || undefined,
    status: base?.status ?? 'draft',
    capability: base?.capability ?? 'captured',
    criticality: base?.criticality ?? 'normal',
    audience: scene.audience.split(',').map(portableId).filter(Boolean),
    tags: [...new Set(scene.tags.map(portableId).filter(Boolean))],
    defaultLocale: base?.defaultLocale ?? 'en',
    locales: base?.locales ?? [],
    translations: portableTranslations(scene.translations, base?.translations),
    narrativeFile: base?.narrativeFile,
    theme: {
      ...(base?.theme ?? {}),
      variables: {
        ...(base?.theme?.variables ?? {}),
        accent: scene.theme.accent,
        paper: scene.theme.paper,
        ink: scene.theme.ink,
        radius: String(scene.theme.radius),
        frame: scene.theme.frame,
      },
    },
    steps,
    assets: [...assetsByHash.values()],
    automation: base?.automation ?? { level: 'none' },
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
    metadata: metadata as Scene['metadata'],
  };
  return { source, files };
}

export async function exportSceneYaml(scene: EditorScene): Promise<PortableExport> {
  const built = await buildScene(scene, false, true);
  return {
    bytes: strToU8(serializeSceneYaml(built.source)),
    filename: `${scene.id}.scene.yaml`,
    mediaType: 'application/yaml',
  };
}

export async function exportSceneZip(scene: EditorScene): Promise<PortableExport> {
  const built = await buildScene(scene, true, false);
  const files: Record<string, Uint8Array> = {
    ...built.files,
    'scene.yaml': strToU8(serializeSceneYaml(built.source)),
  };
  files['README.md'] ??= strToU8(
    `# ${scene.title}\n\nPortable Scenebook source. Open scene.yaml in Scenebook Studio or keep this archive intact to retain assets.\n`,
  );
  return {
    bytes: zipSync(files, { level: 6 }),
    filename: `${scene.id}.scene.zip`,
    mediaType: 'application/zip',
  };
}

export function defaultProject(scenes: readonly Pick<EditorScene, 'id'>[]): Project {
  return {
    schemaVersion: 1,
    id: 'local-workspace',
    name: 'Local workspace',
    slug: 'local-workspace',
    description: 'A local-first Scenebook workspace.',
    defaultLocale: 'en',
    locales: ['en'],
    repositories: [],
    environments: [],
    productVariants: [],
    captureProfiles: [],
    runTargets: [],
    collections: [
      {
        id: 'all-scenes',
        title: 'All Scenes',
        slug: 'all-scenes',
        audience: [],
        entries: scenes.map((scene) => ({ id: `${scene.id}-entry`, sceneId: scene.id })),
      },
    ],
    channels: [],
    public: {
      seo: { index: false, follow: false },
      attribution: true,
      remix: true,
    },
    metadata: { source: 'scenebook-studio' },
  };
}

export function exportProjectYaml(project: Project): PortableExport {
  return {
    bytes: strToU8(serializeProjectYaml(project)),
    filename: `${project.slug}.project.yaml`,
    mediaType: 'application/yaml',
  };
}

export async function exportProjectZip(
  scenes: readonly EditorScene[],
  project: Project = defaultProject(scenes),
): Promise<PortableExport> {
  if (scenes.length === 0) {
    throw new PortableFileError('A project archive needs at least one Scene.');
  }
  const files: Record<string, Uint8Array> = {
    'project.yaml': strToU8(serializeProjectYaml(project)),
    'README.md': strToU8(
      `# ${project.name}\n\nPortable Scenebook project with ${scenes.length} Scene${scenes.length === 1 ? '' : 's'}.\n`,
    ),
  };
  for (const editor of scenes) {
    const built = await buildScene(cloneScene(editor), true, false);
    const directory = `scenes/${editor.id}/`;
    files[`${directory}scene.yaml`] = strToU8(serializeSceneYaml(built.source));
    for (const [path, bytes] of Object.entries(built.files)) files[`${directory}${path}`] = bytes;
  }
  return {
    bytes: zipSync(files, { level: 6 }),
    filename: `${project.slug}.scenebook.zip`,
    mediaType: 'application/zip',
  };
}

export function downloadPortable(output: PortableExport): void {
  const blob = new Blob([Uint8Array.from(output.bytes)], { type: output.mediaType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = output.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
