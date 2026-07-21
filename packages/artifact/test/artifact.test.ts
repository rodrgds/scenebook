import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SceneSchema } from '@scenebook/schema';

import {
  ContentAddressedStore,
  atomicWriteFile,
  loadJsonArtifact,
  loadSceneDirectory,
  writeJsonArtifactAtomic,
  writeSceneDirectory,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scenebook-artifact-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('atomic writes', () => {
  it('replaces a destination without leaving partial temporary files', async () => {
    const root = await temporaryDirectory();
    const destination = join(root, 'nested', 'result.txt');
    await atomicWriteFile(destination, 'first');
    await atomicWriteFile(destination, 'second');

    expect(await readFile(destination, 'utf8')).toBe('second');
    expect(await readdir(join(root, 'nested'))).toEqual(['result.txt']);
  });

  it('writes validated canonical JSON artifacts', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'artifact.json');
    const schema = z.object({ a: z.number(), z: z.string() }).strict();
    await writeJsonArtifactAtomic(path, { z: 'last', a: 1 }, schema);

    expect(await readFile(path, 'utf8')).toBe('{\n  "a": 1,\n  "z": "last"\n}\n');
    await expect(loadJsonArtifact(path, schema)).resolves.toEqual({ a: 1, z: 'last' });
  });
});

describe('content-addressed storage', () => {
  it('deduplicates immutable bytes and verifies integrity', async () => {
    const root = await temporaryDirectory();
    const store = new ContentAddressedStore(join(root, 'assets'));
    const first = await store.put(new Uint8Array([1, 2, 3, 4]), {
      mediaType: 'image/png',
      role: 'screenshot',
      width: 1,
      height: 1,
    });
    const second = await store.put(new Uint8Array([1, 2, 3, 4]), {
      mediaType: 'image/png',
      role: 'screenshot',
      width: 1,
      height: 1,
    });

    expect(second.sha256).toBe(first.sha256);
    expect(await readdir(join(root, 'assets'))).toEqual([`${first.sha256}.png`]);
    expect(await store.get(first)).toEqual(new Uint8Array([1, 2, 3, 4]));
    await writeFile(join(root, 'assets', `${first.sha256}.png`), new Uint8Array([9, 9, 9, 9]));
    await expect(store.get(first)).rejects.toThrow('integrity mismatch');
    await expect(store.verify(first)).resolves.toBe(false);
  });

  it('rejects unsafe extensions and forged paths', async () => {
    const root = await temporaryDirectory();
    const store = new ContentAddressedStore(join(root, 'assets'));
    await expect(store.put('x', { mediaType: 'text/plain', extension: '../txt' })).rejects.toThrow(
      'Unsafe',
    );
  });
});

describe('portable Scene directories', () => {
  it('round-trips source and sidecars while verifying every referenced asset', async () => {
    const root = await temporaryDirectory();
    const store = new ContentAddressedStore(join(root, 'assets'));
    const screenshot = await store.put(new Uint8Array([0, 0, 0, 255]), {
      mediaType: 'image/png',
      role: 'screenshot',
      width: 1,
      height: 1,
    });
    const scene = SceneSchema.parse({
      schemaVersion: 1,
      id: 'welcome',
      title: 'Welcome',
      slug: 'welcome',
      narrativeFile: 'narrative.mdx',
      locales: [{ locale: 'en', file: 'locales/en.yaml', complete: true }],
      steps: [
        {
          id: 'welcome-step',
          title: 'Welcome',
          states: {
            before: {
              id: 'welcome-before',
              route: '/',
              viewport: { width: 1, height: 1 },
              screenshot,
            },
          },
        },
      ],
      assets: [screenshot],
    });

    await writeSceneDirectory(root, scene, {
      verifyAssets: true,
      sidecars: {
        narrative: '# Welcome\n',
        locales: { en: 'title: Welcome\n' },
      },
    });
    const loaded = await loadSceneDirectory(root);

    expect(loaded.scene).toEqual(scene);
    expect(loaded.narrative).toBe('# Welcome\n');
    expect(loaded.locales.get('en')).toBe('title: Welcome\n');
    expect(loaded.revision).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed when a referenced asset was tampered with', async () => {
    const root = await temporaryDirectory();
    const store = new ContentAddressedStore(join(root, 'assets'));
    const screenshot = await store.put(new Uint8Array([0, 0, 0, 255]), {
      mediaType: 'image/png',
      role: 'screenshot',
      width: 1,
      height: 1,
    });
    const scene = SceneSchema.parse({
      schemaVersion: 1,
      id: 'tampered',
      title: 'Tampered',
      slug: 'tampered',
      steps: [
        {
          id: 'step',
          title: 'Step',
          states: {
            before: {
              id: 'before',
              route: '/',
              viewport: { width: 1, height: 1 },
              screenshot,
            },
          },
        },
      ],
      assets: [screenshot],
    });
    await writeSceneDirectory(root, scene, { verifyAssets: true });
    await expect(loadSceneDirectory(root, { maxAssetBytes: 3 })).rejects.toThrow(
      'Asset exceeds 3 bytes',
    );
    await writeFile(join(root, screenshot.path), new Uint8Array([255, 0, 0, 255]));

    await expect(loadSceneDirectory(root)).rejects.toThrow('integrity mismatch');
  });

  it('rejects referenced assets reached through a symlink outside the Scene root', async () => {
    const container = await temporaryDirectory();
    const root = join(container, 'scene');
    const outside = join(container, 'outside');
    await mkdir(root, { recursive: true });
    const store = new ContentAddressedStore(outside, { publicPathPrefix: 'assets' });
    const screenshot = await store.put(new Uint8Array([0, 0, 0, 255]), {
      mediaType: 'image/png',
      role: 'screenshot',
      width: 1,
      height: 1,
    });
    const scene = SceneSchema.parse({
      schemaVersion: 1,
      id: 'symlink-escape',
      title: 'Symlink escape',
      slug: 'symlink-escape',
      steps: [
        {
          id: 'step',
          title: 'Step',
          states: {
            before: {
              id: 'before',
              route: '/',
              viewport: { width: 1, height: 1 },
              screenshot,
            },
          },
        },
      ],
      assets: [screenshot],
    });
    await writeSceneDirectory(root, scene);
    await symlink(outside, join(root, 'assets'), 'dir');

    await expect(loadSceneDirectory(root)).rejects.toThrow(/escapes root|outside/iu);
  });
});
