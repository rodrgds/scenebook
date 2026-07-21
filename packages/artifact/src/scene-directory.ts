import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  assertPathInside,
  collectAssetReferences,
  resolveSceneDirectoryLayout,
  sceneSourceRevision,
  sha256,
} from '@scenebook/core';
import { parseSceneYaml, serializeSceneYaml, type AssetRef, type Scene } from '@scenebook/schema';

import { atomicWriteFile, type AtomicWriteOptions } from './atomic.js';

export interface LoadedSceneDirectory {
  readonly scene: Scene;
  readonly root: string;
  readonly revision: string;
  readonly narrative?: string;
  readonly theme?: string;
  readonly locales: ReadonlyMap<string, string>;
}

export interface LoadSceneDirectoryOptions {
  readonly verifyAssets?: boolean;
  readonly loadSidecars?: boolean;
  readonly maxSceneBytes?: number;
  readonly maxSidecarBytes?: number;
  readonly maxAssetBytes?: number;
}

export interface WriteSceneSidecars {
  readonly narrative?: string;
  readonly theme?: string;
  readonly locales?: Readonly<Record<string, string>>;
}

export interface WriteSceneDirectoryOptions extends AtomicWriteOptions {
  readonly sidecars?: WriteSceneSidecars;
  readonly verifyAssets?: boolean;
}

async function assertPhysicalPathInside(
  root: string,
  candidate: string,
  options: { readonly allowMissing?: boolean } = {},
): Promise<string> {
  const declared = assertPathInside(root, candidate);
  const physicalRoot = await realpath(root);
  let existing = declared;
  while (true) {
    try {
      const info = await lstat(existing);
      if (existing === declared && info.isSymbolicLink()) {
        throw new Error(`Path must not be a symbolic link: ${declared}`);
      }
      assertPathInside(physicalRoot, await realpath(existing));
      return declared;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!options.allowMissing) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

async function readOptional(
  root: string,
  path: string,
  maximumBytes: number,
): Promise<string | undefined> {
  try {
    const safePath = await assertPhysicalPathInside(root, path);
    const info = await lstat(safePath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Sidecar must be a regular non-symlink file: ${safePath}`);
    if (info.size > maximumBytes) {
      throw new RangeError(`Sidecar exceeds ${maximumBytes} bytes: ${safePath}`);
    }
    return await readFile(safePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function verifyAsset(root: string, asset: AssetRef, maximumBytes: number): Promise<void> {
  const path = await assertPhysicalPathInside(root, `${root}/${asset.path}`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Asset must be a regular non-symlink file: ${asset.path}`);
  if (info.size > maximumBytes)
    throw new RangeError(`Asset exceeds ${maximumBytes} bytes: ${asset.path}`);
  if (info.size !== asset.byteLength) throw new Error(`Asset byte length mismatch: ${asset.path}`);
  if (sha256(await readFile(path)) !== asset.sha256)
    throw new Error(`Asset integrity mismatch: ${asset.path}`);
}

export async function loadSceneDirectory(
  directory: string,
  options: LoadSceneDirectoryOptions = {},
): Promise<LoadedSceneDirectory> {
  const layout = resolveSceneDirectoryLayout(directory);
  const sceneFile = await assertPhysicalPathInside(layout.root, layout.sceneFile);
  const sceneInfo = await lstat(sceneFile);
  if (!sceneInfo.isFile() || sceneInfo.isSymbolicLink()) {
    throw new Error(`scene.yaml must be a regular non-symlink file: ${layout.sceneFile}`);
  }
  const source = await readFile(sceneFile, 'utf8');
  const maxSceneBytes = options.maxSceneBytes ?? 10 * 1024 * 1024;
  if (Buffer.byteLength(source) > maxSceneBytes)
    throw new RangeError(`scene.yaml exceeds ${maxSceneBytes} bytes`);
  const scene = parseSceneYaml(source);
  const maxAssetBytes = options.maxAssetBytes ?? 250 * 1024 * 1024;
  const maxSidecarBytes = options.maxSidecarBytes ?? 10 * 1024 * 1024;

  if (options.verifyAssets !== false) {
    await Promise.all(
      collectAssetReferences(scene).map(async (asset) =>
        verifyAsset(layout.root, asset, maxAssetBytes),
      ),
    );
  }

  let narrative: string | undefined;
  let theme: string | undefined;
  const locales = new Map<string, string>();
  if (options.loadSidecars !== false) {
    if (scene.narrativeFile) {
      const path = assertPathInside(layout.root, `${layout.root}/${scene.narrativeFile}`);
      narrative = await readOptional(layout.root, path, maxSidecarBytes);
      if (narrative === undefined)
        throw new Error(`Referenced narrative sidecar is missing: ${scene.narrativeFile}`);
    } else {
      narrative = await readOptional(layout.root, layout.narrativeFile, maxSidecarBytes);
    }
    if (scene.theme?.file) {
      const path = assertPathInside(layout.root, `${layout.root}/${scene.theme.file}`);
      theme = await readOptional(layout.root, path, maxSidecarBytes);
      if (theme === undefined)
        throw new Error(`Referenced theme sidecar is missing: ${scene.theme.file}`);
    } else {
      theme = await readOptional(layout.root, layout.themeFile, maxSidecarBytes);
    }
    for (const descriptor of scene.locales) {
      const content = await readOptional(
        layout.root,
        assertPathInside(layout.root, `${layout.root}/${descriptor.file}`),
        maxSidecarBytes,
      );
      if (content === undefined)
        throw new Error(`Referenced locale sidecar is missing: ${descriptor.file}`);
      locales.set(descriptor.locale, content);
    }
  }

  return {
    scene,
    root: layout.root,
    revision: sceneSourceRevision(scene),
    ...(narrative === undefined ? {} : { narrative }),
    ...(theme === undefined ? {} : { theme }),
    locales,
  };
}

export async function writeSceneDirectory(
  directory: string,
  scene: Scene,
  options: WriteSceneDirectoryOptions = {},
): Promise<void> {
  const layout = resolveSceneDirectoryLayout(directory);
  await mkdir(layout.root, { recursive: true });
  const source = serializeSceneYaml(scene);
  if (options.verifyAssets) {
    await Promise.all(
      collectAssetReferences(scene).map(async (asset) =>
        verifyAsset(layout.root, asset, 250 * 1024 * 1024),
      ),
    );
  }
  if (options.sidecars?.narrative !== undefined) {
    const path = scene.narrativeFile ?? 'narrative.mdx';
    await atomicWriteFile(
      await assertPhysicalPathInside(layout.root, `${layout.root}/${path}`, {
        allowMissing: true,
      }),
      options.sidecars.narrative,
      options,
    );
  }
  if (options.sidecars?.theme !== undefined) {
    const path = scene.theme?.file ?? 'theme.yaml';
    await atomicWriteFile(
      await assertPhysicalPathInside(layout.root, `${layout.root}/${path}`, {
        allowMissing: true,
      }),
      options.sidecars.theme,
      options,
    );
  }
  for (const [locale, content] of Object.entries(options.sidecars?.locales ?? {})) {
    const descriptor = scene.locales.find((candidate) => candidate.locale === locale);
    if (!descriptor) throw new Error(`No locale descriptor exists for ${locale}`);
    await atomicWriteFile(
      await assertPhysicalPathInside(layout.root, `${layout.root}/${descriptor.file}`, {
        allowMissing: true,
      }),
      content,
      options,
    );
  }
  // scene.yaml is the directory commit point: referenced sidecars are durable
  // before readers can observe the new source revision.
  await atomicWriteFile(
    await assertPhysicalPathInside(layout.root, layout.sceneFile, { allowMissing: true }),
    source,
    options,
  );
}

export async function loadScene(
  directory: string,
  options?: LoadSceneDirectoryOptions,
): Promise<Scene> {
  return (await loadSceneDirectory(directory, options)).scene;
}

export async function writeScene(
  directory: string,
  scene: Scene,
  options?: WriteSceneDirectoryOptions,
): Promise<void> {
  await writeSceneDirectory(directory, scene, options);
}
