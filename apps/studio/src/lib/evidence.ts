import {
  BaselineSchema,
  BuildArtifactSchema,
  ReviewSchema,
  RunArtifactSchema,
  SceneSchema,
  type Baseline,
  type Review,
  type RunArtifact,
} from '@scenebook/schema';
import { unzipSync } from 'fflate';
import { parseDocument } from 'yaml';

import { createLocalMediaUrl } from './local-media';
import { cloneScene, type EditorScene, type RunStatus, type StudioRunEvidence } from './model';

const MAX_INPUT_BYTES = 150 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_RUNS_PER_IMPORT = 500;

export interface EvidenceInput {
  name: string;
  bytes: Uint8Array;
  mediaType?: string;
}

export interface EvidenceAssetInput {
  sha256: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface EvidenceImportCandidate {
  sceneId: string;
  evidence: StudioRunEvidence;
  assets: EvidenceAssetInput[];
}

export interface EvidenceImportInspection {
  candidates: EvidenceImportCandidate[];
  warnings: string[];
  ignoredFiles: string[];
  buildCount: number;
}

export interface AttachedEvidenceResult {
  scene: EditorScene;
  createdUrls: string[];
  replacedRevision: boolean;
}

export class EvidenceImportError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'EvidenceImportError';
    this.issues = issues;
  }
}

interface BundleEntry {
  path: string;
  bytes: Uint8Array;
  mediaType?: string;
}

interface ParsedRun {
  run: RunArtifact;
  revision: string;
  path: string;
}

interface ParsedReview {
  review: Review;
  path: string;
}

interface ParsedBaseline {
  baseline: Baseline;
  revision: string;
  path: string;
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

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 2_000 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function safeEntryPath(path: string): boolean {
  return path.endsWith('/') ? safePath(path.slice(0, -1)) : safePath(path);
}

/** Bound allocation before fflate sees an untrusted evidence archive. */
function preflightZip(bytes: Uint8Array): number {
  if (bytes.byteLength < 22) throw new EvidenceImportError('The evidence ZIP is truncated.');
  const earliest = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (readUint32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new EvidenceImportError('The evidence ZIP central directory is missing.');
  const disk = readUint16(bytes, eocd + 4);
  const centralDisk = readUint16(bytes, eocd + 6);
  const diskEntries = readUint16(bytes, eocd + 8);
  const totalEntries = readUint16(bytes, eocd + 10);
  const centralSize = readUint32(bytes, eocd + 12);
  const centralOffset = readUint32(bytes, eocd + 16);
  const commentLength = readUint16(bytes, eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new EvidenceImportError('Multi-disk evidence ZIPs are not supported.');
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new EvidenceImportError('ZIP64 evidence archives are not supported in browser Studio.');
  }
  if (
    totalEntries > MAX_ARCHIVE_ENTRIES ||
    centralOffset + centralSize !== eocd ||
    eocd + 22 + commentLength !== bytes.byteLength
  ) {
    throw new EvidenceImportError('The evidence ZIP exceeds Studio limits or is malformed.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let expanded = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocd || readUint32(bytes, offset) !== 0x02014b50) {
      throw new EvidenceImportError('The evidence ZIP contains a malformed entry.');
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
      throw new EvidenceImportError('An evidence ZIP entry has invalid bounds.');
    }
    let path: string;
    try {
      path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + filenameLength));
    } catch {
      throw new EvidenceImportError('Evidence ZIP paths must be valid UTF-8.');
    }
    if (!safeEntryPath(path)) {
      throw new EvidenceImportError('The evidence ZIP contains an unsafe path.', [path]);
    }
    if ((flags & 0x1) !== 0 || diskStart !== 0 || ![0, 8].includes(compression)) {
      throw new EvidenceImportError('Encrypted or unsupported evidence ZIP entries are blocked.', [
        path,
      ]);
    }
    expanded += originalSize;
    if (originalSize > MAX_ENTRY_BYTES || expanded > MAX_EXPANDED_BYTES) {
      throw new EvidenceImportError('The evidence ZIP expands beyond Studio safety limits.', [
        path,
      ]);
    }
    offset = next;
  }
  if (offset !== eocd) {
    throw new EvidenceImportError('The evidence ZIP central directory has trailing data.');
  }
  return expanded;
}

export function assertEvidenceExpandedBudget(sizes: readonly number[]): number {
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXPANDED_BYTES - total) {
      throw new EvidenceImportError(
        'The combined evidence selection expands beyond Studio’s 500 MB safety limit.',
      );
    }
    total += size;
  }
  return total;
}

function isZip(input: EvidenceInput): boolean {
  return (
    input.name.toLowerCase().endsWith('.zip') ||
    input.mediaType === 'application/zip' ||
    (input.bytes[0] === 0x50 && input.bytes[1] === 0x4b)
  );
}

function expandedEntries(inputs: readonly EvidenceInput[]): BundleEntry[] {
  const total = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
  if (inputs.length === 0) throw new EvidenceImportError('Choose Run evidence files first.');
  if (total > MAX_INPUT_BYTES) {
    throw new EvidenceImportError('Selected evidence exceeds Studio’s 150 MB input limit.');
  }
  const entries: BundleEntry[] = [];
  const expandedSizes: number[] = [];
  for (const input of inputs) {
    if (!input.name || input.name.length > 2_000) {
      throw new EvidenceImportError('An evidence file has an invalid name.');
    }
    if (isZip(input)) {
      expandedSizes.push(preflightZip(input.bytes));
      assertEvidenceExpandedBudget(expandedSizes);
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(input.bytes);
      } catch (error) {
        throw new EvidenceImportError('The evidence ZIP could not be decompressed.', [
          error instanceof Error ? error.message : String(error),
        ]);
      }
      let actualExpanded = 0;
      for (const [path, bytes] of Object.entries(files)) {
        if (!safeEntryPath(path)) {
          throw new EvidenceImportError('The decompressed evidence ZIP contains an unsafe path.', [
            path,
          ]);
        }
        if (path.endsWith('/')) continue;
        actualExpanded += bytes.byteLength;
        if (bytes.byteLength > MAX_ENTRY_BYTES || actualExpanded > MAX_EXPANDED_BYTES) {
          throw new EvidenceImportError(
            'The decompressed evidence ZIP exceeds Studio safety limits.',
            [path],
          );
        }
        entries.push({ path, bytes });
      }
      expandedSizes[expandedSizes.length - 1] = actualExpanded;
      assertEvidenceExpandedBudget(expandedSizes);
    } else {
      const path = input.name.replace(/^\/+|\/+$/gu, '');
      if (!safePath(path))
        throw new EvidenceImportError('An evidence file path is unsafe.', [path]);
      expandedSizes.push(input.bytes.byteLength);
      assertEvidenceExpandedBudget(expandedSizes);
      entries.push({ path, bytes: input.bytes, mediaType: input.mediaType });
    }
  }
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new EvidenceImportError('The evidence selection contains too many files.');
  }
  return entries;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new EvidenceImportError('Evidence contains a non-finite number.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object') {
    throw new EvidenceImportError('Evidence contains a value that is not JSON-serializable.');
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) {
      throw new EvidenceImportError(`Evidence contains undefined at ${key}.`);
    }
    output[key] = canonicalize(entry);
  }
  return output;
}

export async function canonicalEvidenceHash(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new EvidenceImportError('Web Crypto is required to verify evidence integrity.');
  }
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoded));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function bytesHash(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new EvidenceImportError('Web Crypto is required to verify screenshot integrity.');
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', copy.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function strictJson(entry: BundleEntry): unknown {
  if (entry.bytes.byteLength === 0 || entry.bytes.byteLength > MAX_JSON_BYTES) {
    throw new EvidenceImportError('Evidence JSON is empty or exceeds the 20 MB limit.', [
      entry.path,
    ]);
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
  } catch {
    throw new EvidenceImportError('Evidence JSON must be valid UTF-8.', [entry.path]);
  }
  const document = parseDocument(source, {
    schema: 'json',
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.contents === null) {
    throw new EvidenceImportError('Evidence JSON is invalid or contains duplicate keys.', [
      entry.path,
      ...document.errors.map((error) => error.message),
    ]);
  }
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}

function objectKind(value: unknown): string | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? ((value as { kind?: unknown }).kind as string | undefined)
    : undefined;
}

function screenshotMagic(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

function aliases(path: string): string[] {
  const normalized = path.replace(/^\/+|\/+$/gu, '');
  const output = new Set([normalized]);
  const marker = '/.scenebook/runs/';
  const markerAt = normalized.indexOf(marker);
  if (markerAt >= 0) output.add(normalized.slice(markerAt + marker.length));
  for (const prefix of ['.scenebook/runs/', 'scenebook/runs/']) {
    if (normalized.startsWith(prefix)) output.add(normalized.slice(prefix.length));
  }
  return [...output];
}

function findAssetEntry(entries: readonly BundleEntry[], path: string): BundleEntry | undefined {
  const candidates = entries.filter((entry) => {
    const paths = aliases(entry.path);
    return paths.includes(path) || paths.some((candidate) => candidate.endsWith(`/${path}`));
  });
  if (candidates.length === 1) return candidates[0];
  const basename = path.split('/').at(-1);
  const byBasename = entries.filter((entry) => entry.path.split('/').at(-1) === basename);
  return byBasename.length === 1 ? byBasename[0] : undefined;
}

async function verifyScreenshot(
  entries: readonly BundleEntry[],
  screenshot: RunArtifact['attempts'][number]['states'][number]['screenshot'],
): Promise<EvidenceAssetInput | null> {
  const entry = findAssetEntry(entries, screenshot.path);
  if (!entry) return null;
  if (
    entry.bytes.byteLength !== screenshot.byteLength ||
    entry.bytes.byteLength > MAX_SCREENSHOT_BYTES
  ) {
    throw new EvidenceImportError('A Run screenshot has the wrong byte length.', [
      `${screenshot.path}: expected ${screenshot.byteLength}, found ${entry.bytes.byteLength}`,
    ]);
  }
  const digest = await bytesHash(entry.bytes);
  if (digest !== screenshot.sha256) {
    throw new EvidenceImportError('A Run screenshot failed its SHA-256 integrity check.', [
      screenshot.path,
    ]);
  }
  const mediaType = screenshot.mediaType.toLowerCase();
  if (screenshotMagic(entry.bytes) !== mediaType) {
    throw new EvidenceImportError('A Run screenshot does not match its declared media type.', [
      `${screenshot.path}: ${mediaType}`,
    ]);
  }
  return { sha256: screenshot.sha256, mediaType, bytes: entry.bytes };
}

function latestReview(reviews: readonly ParsedReview[]): ParsedReview | undefined {
  return [...reviews].sort(
    (left, right) =>
      Date.parse(right.review.createdAt) - Date.parse(left.review.createdAt) ||
      right.review.id.localeCompare(left.review.id),
  )[0];
}

export function runEvidenceStatus(run: RunArtifact): Exclude<RunStatus, 'stale'> {
  if (run.changeState) return run.changeState;
  if (run.status === 'blocked' || ['blocked', 'quarantined'].includes(run.privacy.status))
    return 'blocked';
  return run.status === 'passed' ? 'passed' : 'broken';
}

export function selectedRunAttempt(run: RunArtifact) {
  return run.attempts.find((attempt) => attempt.id === run.selectedAttemptId);
}

export function evidenceImage(
  scene: Pick<EditorScene, 'runEvidenceAssets'>,
  sha256: string | undefined,
): string | undefined {
  return sha256 ? scene.runEvidenceAssets?.[sha256] : undefined;
}

export async function inspectEvidenceInputs(
  inputs: readonly EvidenceInput[],
  now: () => Date = () => new Date(),
): Promise<EvidenceImportInspection> {
  const entries = expandedEntries(inputs);
  const runs: ParsedRun[] = [];
  const reviews: ParsedReview[] = [];
  const baselines: ParsedBaseline[] = [];
  const warnings: string[] = [];
  const ignoredFiles: string[] = [];
  let buildCount = 0;

  for (const entry of entries) {
    if (!entry.path.toLowerCase().endsWith('.json')) continue;
    const parsed = strictJson(entry);
    const kind = objectKind(parsed);
    try {
      if (kind === 'run') {
        const run = RunArtifactSchema.parse(parsed);
        runs.push({ run, revision: await canonicalEvidenceHash(run), path: entry.path });
      } else if (kind === 'review') {
        reviews.push({ review: ReviewSchema.parse(parsed), path: entry.path });
      } else if (kind === 'baseline') {
        const baseline = BaselineSchema.parse(parsed);
        baselines.push({
          baseline,
          revision: await canonicalEvidenceHash(baseline),
          path: entry.path,
        });
      } else if (kind === 'build') {
        BuildArtifactSchema.parse(parsed);
        buildCount += 1;
      } else {
        ignoredFiles.push(entry.path);
      }
    } catch (error) {
      throw new EvidenceImportError(`Invalid ${kind ?? 'unknown'} evidence artifact.`, [
        entry.path,
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }
  if (runs.length === 0) {
    throw new EvidenceImportError(
      'No Run artifacts were found. Choose Run JSON plus its assets, or a ZIP of .scenebook/runs.',
    );
  }
  if (runs.length > MAX_RUNS_PER_IMPORT) {
    throw new EvidenceImportError(`One import may contain at most ${MAX_RUNS_PER_IMPORT} Runs.`);
  }
  const seenRunRevisions = new Set<string>();
  const uniqueRuns = runs.filter((item) => {
    if (seenRunRevisions.has(item.revision)) return false;
    seenRunRevisions.add(item.revision);
    return true;
  });
  if (uniqueRuns.length !== runs.length) {
    warnings.push(`${runs.length - uniqueRuns.length} duplicate Run artifact(s) were ignored.`);
  }

  const candidates: EvidenceImportCandidate[] = [];
  for (const item of uniqueRuns) {
    const boundReviews = reviews.filter(
      ({ review }) =>
        review.subject.kind === 'run' &&
        review.subject.id === item.run.id &&
        review.subject.revision === item.revision,
    );
    const selectedReview = latestReview(boundReviews)?.review;
    if (boundReviews.length > 1) {
      warnings.push(
        `Run ${item.run.id} has ${boundReviews.length} exact Reviews; the newest was attached.`,
      );
    }
    const sameIdWrongRevision = reviews.filter(
      ({ review }) =>
        review.subject.kind === 'run' &&
        review.subject.id === item.run.id &&
        review.subject.revision !== item.revision,
    );
    if (!selectedReview && sameIdWrongRevision.length > 0) {
      throw new EvidenceImportError('A Review targets the Run ID but not its exact revision.', [
        item.run.id,
        ...sameIdWrongRevision.map(({ path }) => path),
      ]);
    }
    if (selectedReview) {
      if (selectedReview.projectId !== item.run.projectId) {
        throw new EvidenceImportError('Review project does not match its exact Run artifact.', [
          selectedReview.id,
        ]);
      }
      if (selectedReview.changeState !== runEvidenceStatus(item.run)) {
        throw new EvidenceImportError('Review change state contradicts its exact Run artifact.', [
          selectedReview.id,
        ]);
      }
      if (selectedReview.changes.some((change) => change.sceneId !== item.run.sceneId)) {
        throw new EvidenceImportError('Review changes belong to another Scene.', [
          selectedReview.id,
        ]);
      }
      if (
        selectedReview.baselineCandidate &&
        (selectedReview.baselineCandidate.kind !== 'run' ||
          selectedReview.baselineCandidate.id !== item.run.id ||
          selectedReview.baselineCandidate.sha256 !== item.revision)
      ) {
        throw new EvidenceImportError(
          'Review baselineCandidate does not bind the exact candidate Run.',
          [selectedReview.id],
        );
      }
    }

    let baseline: Baseline | undefined;
    if (selectedReview?.baseline) {
      const exact = baselines.find(
        (candidate) =>
          candidate.baseline.id === selectedReview.baseline!.id &&
          candidate.revision === selectedReview.baseline!.sha256,
      );
      if (exact) {
        baseline = exact.baseline;
        if (
          baseline.projectId !== item.run.projectId ||
          baseline.sceneId !== item.run.sceneId ||
          baseline.runTargetId !== item.run.runTargetId ||
          baseline.sourceRevision !== item.run.sourceRevision
        ) {
          throw new EvidenceImportError('Baseline scope does not match the candidate Run.', [
            baseline.id,
          ]);
        }
      } else if (
        baselines.some((candidate) => candidate.baseline.id === selectedReview.baseline!.id)
      )
        throw new EvidenceImportError('Included Baseline does not match the Review revision.', [
          selectedReview.baseline.id,
        ]);
      else
        warnings.push(
          `Run ${item.run.id} references Baseline ${selectedReview.baseline.id}, but its exact artifact was not included.`,
        );
    }

    const assetByHash = new Map<string, EvidenceAssetInput>();
    const missing = new Set<string>();
    const screenshots = [
      ...item.run.attempts.flatMap((attempt) => attempt.states.map((state) => state.screenshot)),
      ...(baseline?.states.map((state) => state.screenshot) ?? []),
    ];
    for (const screenshot of screenshots) {
      if (assetByHash.has(screenshot.sha256) || missing.has(screenshot.sha256)) continue;
      const verified = await verifyScreenshot(entries, screenshot);
      if (verified) assetByHash.set(verified.sha256, verified);
      else missing.add(screenshot.sha256);
    }
    if (missing.size > 0) {
      warnings.push(
        `Run ${item.run.id} is metadata-complete, but ${missing.size} referenced screenshot asset${missing.size === 1 ? ' is' : 's are'} not in this import.`,
      );
    }
    if (!selectedReview) {
      warnings.push(
        `Run ${item.run.id} has no exact Review artifact; functional results remain inspectable, but no dimension diff is attached.`,
      );
    }
    candidates.push({
      sceneId: item.run.sceneId,
      evidence: {
        runRevision: item.revision,
        run: item.run,
        ...(selectedReview ? { review: selectedReview } : {}),
        ...(baseline ? { baseline } : {}),
        importedAt: now().toISOString(),
        bundleName: inputs
          .map((input) => input.name)
          .join(', ')
          .slice(0, 2_000),
        verifiedAssetHashes: [...assetByHash.keys()].sort(),
        missingAssetHashes: [...missing].sort(),
      },
      assets: [...assetByHash.values()],
    });
  }

  return { candidates, warnings, ignoredFiles, buildCount };
}

export async function inspectEvidenceFiles(
  files: readonly File[],
  now?: () => Date,
): Promise<EvidenceImportInspection> {
  const declaredBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (declaredBytes > MAX_INPUT_BYTES) {
    throw new EvidenceImportError('Selected evidence exceeds Studio’s 150 MB input limit.');
  }
  const inputs: EvidenceInput[] = [];
  for (const file of files) {
    inputs.push({
      name:
        (file as File & { webkitRelativePath?: string }).webkitRelativePath?.replace(
          /^\/+|\/+$/gu,
          '',
        ) || file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mediaType: file.type || undefined,
    });
  }
  return inspectEvidenceInputs(inputs, now);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export async function attachEvidenceToScene(
  source: EditorScene,
  candidate: EvidenceImportCandidate,
): Promise<AttachedEvidenceResult> {
  const { run } = candidate.evidence;
  if (source.sample) {
    throw new EvidenceImportError('Synthetic sample Scenes cannot receive product Run evidence.', [
      source.id,
    ]);
  }
  if (source.id !== run.sceneId || source.id !== candidate.sceneId) {
    throw new EvidenceImportError('Run evidence belongs to another Scene.', [
      `local ${source.id}; Run ${run.sceneId}`,
    ]);
  }
  if (!source.portableSource) {
    throw new EvidenceImportError(
      'Run evidence requires canonical portable Scene source so Studio can verify sourceRevision.',
      [source.id],
    );
  }
  const portable = SceneSchema.parse(source.portableSource);
  const sourceRevision = await canonicalEvidenceHash(portable);
  if (sourceRevision !== run.sourceRevision) {
    throw new EvidenceImportError('Run evidence was produced from a different Scene revision.', [
      `local ${sourceRevision}`,
      `Run ${run.sourceRevision}`,
    ]);
  }
  if (
    !sameStringSet(
      run.expectedStepIds,
      portable.steps.map((step) => step.id),
    )
  ) {
    throw new EvidenceImportError('Run evidence does not cover the exact canonical Step set.', [
      source.id,
    ]);
  }

  const scene = cloneScene(source);
  const existingAssets = { ...(scene.runEvidenceAssets ?? {}) };
  const createdUrls: string[] = [];
  for (const asset of candidate.assets) {
    if (existingAssets[asset.sha256]) continue;
    const copy = new Uint8Array(asset.bytes.byteLength);
    copy.set(asset.bytes);
    const url = createLocalMediaUrl(copy.buffer, asset.mediaType);
    createdUrls.push(url);
    existingAssets[asset.sha256] = url;
  }
  scene.runEvidenceAssets = existingAssets;
  const previous = scene.runEvidence ?? [];
  const previousExact = previous.find(
    (evidence) => evidence.runRevision === candidate.evidence.runRevision,
  );
  const replacedRevision = Boolean(previousExact);
  const locallyAvailable = new Set(Object.keys(existingAssets));
  const mergedReview = candidate.evidence.review ?? previousExact?.review;
  const mergedBaseline = candidate.evidence.baseline ?? previousExact?.baseline;
  const referencedAssetHashes = new Set([
    ...candidate.evidence.run.attempts.flatMap((attempt) =>
      attempt.states.map((state) => state.screenshot.sha256),
    ),
    ...(mergedBaseline?.states.map((state) => state.screenshot.sha256) ?? []),
  ]);
  const mergedEvidence: StudioRunEvidence = {
    ...candidate.evidence,
    ...(mergedReview ? { review: mergedReview } : {}),
    ...(mergedBaseline ? { baseline: mergedBaseline } : {}),
    verifiedAssetHashes: [...referencedAssetHashes]
      .filter((hash) => locallyAvailable.has(hash))
      .sort(),
    missingAssetHashes: [...referencedAssetHashes]
      .filter((hash) => !locallyAvailable.has(hash))
      .sort(),
  };
  scene.runEvidence = [
    mergedEvidence,
    ...previous.filter((evidence) => evidence.runRevision !== candidate.evidence.runRevision),
  ].sort(
    (left, right) =>
      Date.parse(right.run.endedAt) - Date.parse(left.run.endedAt) ||
      right.runRevision.localeCompare(left.runRevision),
  );
  const latest = scene.runEvidence[0]!;
  scene.verified = {
    status: runEvidenceStatus(latest.run),
    commit: latest.run.repository.commit,
    environment: latest.run.runTargetId,
    at: latest.run.endedAt,
  };
  return { scene, createdUrls, replacedRevision };
}
