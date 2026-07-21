import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectSchema,
  SCHEMA_VERSION,
  SceneSchema,
  ScenebookConfigSchema,
  serializeConfigYaml,
  serializeSceneYaml,
} from '@scenebook/schema';

import { runCli } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write(value: string | Uint8Array) {
          stdout += String(value);
          return true;
        },
      },
      stderr: {
        write(value: string | Uint8Array) {
          stderr += String(value);
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function fixture(configuredOutput = 'scenebook-dist'): Promise<{
  readonly root: string;
  readonly scenes: string;
  readonly scene: string;
  readonly manifest: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-cli-output-safety-'));
  roots.push(root);
  const scenes = join(root, 'scenes');
  const scene = join(scenes, 'protected.scene');
  const manifest = join(scene, 'scene.yaml');
  await mkdir(scene, { recursive: true });
  await writeFile(
    join(root, 'scenebook.config.yaml'),
    serializeConfigYaml(
      ScenebookConfigSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        project: ProjectSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          id: 'protected-project',
          name: 'Protected project',
          slug: 'protected-project',
        }),
        paths: { output: configuredOutput },
        output: { formats: ['catalog'] },
      }),
    ),
  );
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
  await writeFile(join(root, 'sentinel.txt'), 'keep me');
  return { root, scenes, scene, manifest };
}

async function expectRejected(root: string, arguments_: readonly string[]): Promise<void> {
  const result = output();
  expect(await runCli(arguments_, { cwd: root, io: result.io })).toBe(1);
  expect(result.stderr()).toContain('overlaps protected source or state path');
}

describe('CLI output replacement safety', () => {
  it('rejects adversarial build/export/dev/publish overrides and preserves every source', async () => {
    const value = await fixture();
    const alias = join(value.root, 'scene-alias');
    await symlink(value.scene, alias);

    const commands = [
      ['build', '--output', '.'],
      ['export', '--format', 'markdown', '--output', value.root],
      ['publish', '--destination', 'scenes'],
      ['dev', '--output', 'scenes/protected.scene'],
      ['build', '--output', 'scenes/protected.scene/generated/deep'],
      ['publish', '--destination', 'scene-alias/generated'],
      ['build', '--output', '.scenebook'],
    ] as const;
    for (const command of commands) {
      await expectRejected(value.root, command);
      expect(await readFile(value.manifest, 'utf8')).toContain('Protected source');
      expect(await readFile(join(value.root, 'sentinel.txt'), 'utf8')).toBe('keep me');
    }

    const result = output();
    expect(
      await runCli(['build', '--output', 'safe-dist', '--allow-unscanned-privacy'], {
        cwd: value.root,
        io: result.io,
      }),
    ).toBe(0);
    expect(await readFile(join(value.root, 'safe-dist/manifest.json'), 'utf8')).toContain(
      'protected',
    );
    expect(await readFile(value.manifest, 'utf8')).toContain('Protected source');

    expect(
      await runCli(
        ['build', '--output', '.scenebook/staging/privacy-scan-test', '--allow-unscanned-privacy'],
        { cwd: value.root, io: output().io },
      ),
    ).toBe(0);
    expect(
      await readFile(
        join(value.root, '.scenebook/staging/privacy-scan-test/manifest.json'),
        'utf8',
      ),
    ).toContain('protected');
  });

  it('rejects unsafe configured output for build, export, and dev', async () => {
    const value = await fixture('scenes');
    for (const command of [['build'], ['export', '--format', 'markdown'], ['dev']] as const) {
      await expectRejected(value.root, command);
      expect(await readFile(value.manifest, 'utf8')).toContain('Protected source');
    }
  });
});
