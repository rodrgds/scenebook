import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SceneSchema, serializeSceneYaml } from '@scenebook/schema';

import { compileScenes, type PrivacyGate } from '../src/index.js';

const roots: string[] = [];
const passedPrivacy: PrivacyGate = async () => ({
  status: 'passed',
  scanner: 'test',
  findings: [],
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly root: string;
  readonly scenes: string;
  readonly scene: string;
  readonly manifest: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-output-safety-'));
  roots.push(root);
  const scenes = join(root, 'scenes');
  const scene = join(scenes, 'protected.scene');
  const manifest = join(scene, 'scene.yaml');
  await mkdir(scene, { recursive: true });
  await writeFile(
    manifest,
    serializeSceneYaml(
      SceneSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: 'protected',
        slug: 'protected',
        title: 'Protected source',
        steps: [{ id: 'done', kind: 'end', title: 'Done' }],
      }),
    ),
  );
  await writeFile(join(root, 'sentinel.txt'), 'project source');
  return { root, scenes, scene, manifest };
}

async function compile(scene: string, outputDirectory: string, protectedPaths: string[] = []) {
  return compileScenes({
    scenes: [scene],
    outputDirectory,
    protectedPaths,
    formats: ['markdown'],
    sourceDateEpoch: 0,
    privacyGate: passedPrivacy,
  });
}

describe('compiler output path safety', () => {
  it('rejects project/source ancestors, exact Scene paths, and Scene descendants before mutation', async () => {
    const value = await fixture();
    const destinations = [
      value.root,
      value.scenes,
      value.scene,
      dirname(value.manifest),
      join(value.scene, 'generated', 'nested'),
    ];

    for (const destination of destinations) {
      await expect(compile(value.scene, destination)).rejects.toThrow(
        'overlaps protected source or state path',
      );
      expect(await readFile(value.manifest, 'utf8')).toContain('Protected source');
      expect(await readFile(join(value.root, 'sentinel.txt'), 'utf8')).toBe('project source');
    }
  });

  it('canonicalizes an existing symlink parent plus a nonexistent tail', async () => {
    const value = await fixture();
    const alias = join(value.root, 'scene-alias');
    await symlink(value.scene, alias);

    await expect(compile(value.scene, join(alias, 'generated', 'deep'))).rejects.toThrow(
      'overlaps protected source or state path',
    );
    expect(await readFile(value.manifest, 'utf8')).toContain('Protected source');
  });

  it('honors caller-protected config/state files while allowing a sibling output', async () => {
    const value = await fixture();
    const configuration = join(value.root, 'configuration', 'scenebook.config.yaml');
    await mkdir(dirname(configuration), { recursive: true });
    await writeFile(configuration, 'source: true\n');

    await expect(compile(value.scene, dirname(configuration), [configuration])).rejects.toThrow(
      'overlaps protected source or state path',
    );
    await expect(compile(value.scene, configuration, [configuration])).rejects.toThrow(
      'overlaps protected source or state path',
    );

    const output = join(dirname(configuration), 'dist');
    const result = await compile(value.scene, output, [configuration]);
    expect(result.outputDirectory).toBe(join(await realpath(dirname(configuration)), 'dist'));
    expect(await readFile(join(output, 'manifest.json'), 'utf8')).toContain('protected');
    expect(await readFile(configuration, 'utf8')).toBe('source: true\n');
  });
});
