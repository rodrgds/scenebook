import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SceneSchema } from '@scenebook/schema';
import { parse } from 'yaml';
import sharp from 'sharp';
import { stepImageReference } from './normalize.js';
import type { CompilerDiagnostic, LoadedScene, ResolvedSceneAsset } from './types.js';

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const MAX_SCENE_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_SCENE_SIDECAR_BYTES = 4 * 1024 * 1024;
const MAX_AUTOMATION_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_RASTER_ASSET_BYTES = 64 * 1024 * 1024;

function rasterMediaType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function readBoundedFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error(`${label} must be a regular file.`);
    if (!Number.isSafeInteger(initial.size) || initial.size < 0) {
      throw new Error(`${label} has an unsupported byte length.`);
    }
    if (initial.size > maximumBytes) {
      throw new Error(
        `${label} exceeds the ${maximumBytes}-byte encoded input limit (${initial.size} bytes).`,
      );
    }

    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${label} changed while it was being read.`);
      offset += result.bytesRead;
    }

    const final = await handle.stat();
    const probe = Buffer.allocUnsafe(1);
    const trailing = await handle.read(probe, 0, 1, bytes.byteLength);
    if (final.size !== initial.size || trailing.bytesRead > 0) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function sceneFile(
  base: string,
  reference: string,
  options: {
    readonly label: string;
    readonly maximumBytes: number;
    readonly required: boolean;
  },
): Promise<Buffer | undefined> {
  const path = resolve(base, reference);
  if (!isInside(base, path))
    throw new Error(`Scene ${options.label} escapes its directory: ${reference}`);
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink()) {
      throw new Error(`Scene ${options.label} must not be a symbolic link: ${reference}`);
    }
    if (!status.isFile())
      throw new Error(`Scene ${options.label} must be a regular file: ${reference}`);
    const canonical = await realpath(path);
    if (!isInside(base, canonical)) {
      throw new Error(`Scene ${options.label} escapes its directory: ${reference}`);
    }
    return await readBoundedFile(
      canonical,
      options.maximumBytes,
      `Scene ${options.label} ${reference}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (options.required) throw new Error(`Scene ${options.label} is missing: ${reference}`);
      return undefined;
    }
    throw error;
  }
}

async function sceneText(
  base: string,
  reference: string,
  label: string,
  required: boolean,
): Promise<string | undefined> {
  return (
    await sceneFile(base, reference, {
      label,
      maximumBytes: MAX_SCENE_SIDECAR_BYTES,
      required,
    })
  )?.toString('utf8');
}

function referencesFromScene(scene: unknown): string[] {
  const source = scene as { steps?: unknown[]; assets?: Array<{ path?: unknown }> };
  const references = new Set<string>();
  for (const asset of source.assets ?? []) {
    if (typeof asset.path === 'string') references.add(asset.path);
  }
  for (const step of source.steps ?? []) {
    const reference = stepImageReference(step);
    if (reference) references.add(reference);
  }
  return [...references];
}

export async function loadSceneDirectory(
  directory: string,
  options: {
    /** Migration-only escape hatch. Never enabled by compileScenes/publication. */
    readonly allowAssetMetadataMismatch?: boolean;
    /** Deprecated compatibility flag; strict validation is the production default. */
    readonly strictAssetHashes?: boolean;
  } = {},
): Promise<LoadedScene> {
  const absoluteDirectory = await realpath(resolve(directory));
  const manifestCandidate = join(absoluteDirectory, 'scene.yaml');
  const manifestStatus = await lstat(manifestCandidate);
  if (manifestStatus.isSymbolicLink() || !manifestStatus.isFile()) {
    throw new Error('Scene manifest scene.yaml must be a regular file and not a symbolic link.');
  }
  const manifestPath = await realpath(manifestCandidate);
  if (!isInside(absoluteDirectory, manifestPath)) {
    throw new Error('Scene manifest scene.yaml escapes its directory.');
  }
  const source = (
    await readBoundedFile(manifestPath, MAX_SCENE_MANIFEST_BYTES, 'Scene manifest scene.yaml')
  ).toString('utf8');
  const scene = SceneSchema.parse(parse(source));
  const diagnostics: CompilerDiagnostic[] = [];
  const assets = new Map<string, ResolvedSceneAsset>();
  const declaredAssets = new Map(scene.assets.map((asset) => [asset.path, asset]));

  for (const reference of referencesFromScene(scene)) {
    const absoluteAsset = await realpath(resolve(absoluteDirectory, reference)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Scene ${scene.id} references a missing asset: ${reference}`);
      }
      throw error;
    });
    if (!isInside(absoluteDirectory, absoluteAsset)) {
      throw new Error(`Scene ${scene.id} asset escapes its directory: ${reference}`);
    }
    const bytes = await readBoundedFile(
      absoluteAsset,
      MAX_RASTER_ASSET_BYTES,
      `Scene ${scene.id} asset ${reference}`,
    );
    const hash = createHash('sha256').update(bytes).digest('hex');
    const extension = extname(absoluteAsset).toLowerCase();
    const declared = declaredAssets.get(reference);
    if (!declared) {
      throw new Error(`Scene ${scene.id} references undeclared asset: ${reference}`);
    }
    if (extension === '.svg' || declared.mediaType.toLowerCase() === 'image/svg+xml') {
      throw new Error(
        `Scene ${scene.id} asset ${reference} is SVG/vector content. Screenshot publication accepts only trusted PNG, JPEG, or WebP raster bytes.`,
      );
    }
    const actualMediaType = rasterMediaType(bytes);
    if (!actualMediaType) {
      throw new Error(
        `Scene ${scene.id} asset ${reference} is not a trusted PNG, JPEG, or WebP raster by magic bytes.`,
      );
    }
    const metadata = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: 100_000_000,
    }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Scene ${scene.id} asset ${reference} has no decodable raster dimensions.`);
    }
    const mismatches: string[] = [];
    if (declared.sha256 !== hash)
      mismatches.push(`declared SHA-256 ${declared.sha256} does not match bytes ${hash}`);
    if (declared.byteLength !== bytes.byteLength)
      mismatches.push(
        `declared byteLength ${declared.byteLength} does not match bytes ${bytes.byteLength}`,
      );
    if (declared.mediaType.toLowerCase() !== actualMediaType)
      mismatches.push(
        `declared mediaType ${declared.mediaType} does not match magic bytes ${actualMediaType}`,
      );
    if (MEDIA_TYPES[extension] !== actualMediaType)
      mismatches.push(
        `filename extension ${extension || '(none)'} does not match magic bytes ${actualMediaType}`,
      );
    if (declared.width !== undefined && declared.width !== metadata.width)
      mismatches.push(`declared width ${declared.width} does not match pixels ${metadata.width}`);
    if (declared.height !== undefined && declared.height !== metadata.height)
      mismatches.push(
        `declared height ${declared.height} does not match pixels ${metadata.height}`,
      );
    const expectedHash = /(?:^|\/)([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i.exec(reference)?.[1];
    if (expectedHash && expectedHash.toLowerCase() !== hash) {
      mismatches.push(`filename claims SHA-256 ${expectedHash}, but bytes are ${hash}`);
    }
    if (mismatches.length) {
      const diagnostic: CompilerDiagnostic = {
        code: 'asset-integrity-mismatch',
        level: options.allowAssetMetadataMismatch ? 'warning' : 'error',
        message: `Asset integrity mismatch for ${reference}: ${mismatches.join('; ')}.`,
        path: reference,
      };
      diagnostics.push(diagnostic);
      if (!options.allowAssetMetadataMismatch) throw new Error(diagnostic.message);
    }
    assets.set(reference, {
      reference,
      sourcePath: absoluteAsset,
      hash,
      extension: extension || '.bin',
      mediaType: actualMediaType,
      bytes: bytes.byteLength,
    });
  }

  const sceneRecord = scene as unknown as {
    narrativeFile?: string;
    theme?: { file?: string; variables?: Record<string, string> };
    locales?: Array<{ locale: string; file: string }>;
  };
  const narrative = sceneRecord.narrativeFile
    ? await sceneText(absoluteDirectory, sceneRecord.narrativeFile, 'narrative sidecar', true)
    : await sceneText(absoluteDirectory, 'narrative.mdx', 'narrative sidecar', false);
  const themeSource = sceneRecord.theme?.file
    ? await sceneText(absoluteDirectory, sceneRecord.theme.file, 'theme sidecar', true)
    : await sceneText(absoluteDirectory, 'theme.yaml', 'theme sidecar', false);
  const locales: Record<string, unknown> = {};
  for (const descriptor of sceneRecord.locales ?? []) {
    const localeSource = await sceneText(
      absoluteDirectory,
      descriptor.file,
      `locale sidecar ${descriptor.locale}`,
      true,
    );
    locales[descriptor.locale] = parse(localeSource as string) as unknown;
  }
  if (scene.automation.replayPath) {
    await sceneFile(absoluteDirectory, scene.automation.replayPath, {
      label: 'automation replay',
      maximumBytes: MAX_AUTOMATION_REPLAY_BYTES,
      required: true,
    });
  }

  return {
    scene,
    directory: absoluteDirectory,
    manifestPath,
    ...(narrative ? { narrative } : {}),
    ...(themeSource
      ? { theme: parse(themeSource) as Record<string, unknown> }
      : sceneRecord.theme?.variables
        ? { theme: sceneRecord.theme.variables }
        : {}),
    locales,
    assets,
    diagnostics,
  };
}
