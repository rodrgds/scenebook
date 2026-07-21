import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSceneYaml } from '@scenebook/schema';
import { recordedSceneDirectory, scaffoldRecordedScene } from '../src/record-scaffold.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('recorded Scene scaffolding', () => {
  it('wraps a replay in valid Captured portable source without retaining URL secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-record-scaffold-'));
    directories.push(root);
    const replay = join(root, 'scenes/onboarding.scene/automation/replay.ts');
    await mkdir(join(root, 'scenes/onboarding.scene/automation'), { recursive: true });
    await writeFile(replay, "import { test } from '@playwright/test';\n");
    const result = await scaffoldRecordedScene({
      replayPath: replay,
      targetHref: 'https://app.example.test/start?mode=preview',
      title: 'Onboard a teammate',
    });

    expect(result.created).toBe(true);
    const source = await readFile(result.manifestPath, 'utf8');
    const scene = parseSceneYaml(source);
    expect(scene).toMatchObject({
      id: 'onboarding',
      slug: 'onboarding',
      title: 'Onboard a teammate',
      capability: 'captured',
      automation: {
        level: 'none',
        framework: 'playwright',
        replayPath: 'automation/replay.ts',
      },
    });
    expect(source).toContain('recordingOrigin: https://app.example.test');
    expect(source).not.toContain('mode=preview');
    expect(
      (await scaffoldRecordedScene({ replayPath: replay, targetHref: 'https://x.test/' })).created,
    ).toBe(false);
  });

  it('rejects loose replay paths that cannot form a portable Scene', () => {
    expect(() => recordedSceneDirectory('/tmp/automation/replay.ts')).toThrow(
      'must be inside a portable *.scene directory',
    );
  });
});
