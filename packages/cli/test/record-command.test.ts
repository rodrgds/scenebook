import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  ProjectSchema,
  SCHEMA_VERSION,
  ScenebookConfigSchema,
  serializeConfigYaml,
} from '@scenebook/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

const captureMock = vi.hoisted(() => vi.fn());

vi.mock('../src/record-capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/record-capture.js')>();
  return { ...actual, captureSanitizedPlaywrightRecording: captureMock };
});

import { runCli } from '../src/index.js';
import { sanitizePlaywrightRecording } from '../src/record-capture.js';

const roots: string[] = [];

afterEach(async () => {
  captureMock.mockReset();
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

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await walk(root);
  return result;
}

describe('record command sanitized persistence', () => {
  it('writes only sanitized bytes atomically and keeps canaries out of logs and compiled ZIPs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-record-command-'));
    roots.push(root);
    await writeFile(
      join(root, 'scenebook.config.yaml'),
      serializeConfigYaml(
        ScenebookConfigSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          project: ProjectSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            id: 'recorded-project',
            name: 'Recorded project',
            slug: 'recorded-project',
          }),
          paths: { output: 'scenebook-dist' },
          output: { formats: ['catalog'] },
        }),
      ),
    );

    const canary = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const generated = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/private?token=${canary}');
  await page.getByLabel('Token').fill('${canary}');
});
`;
    const sanitized = sanitizePlaywrightRecording(generated);
    captureMock.mockResolvedValue(sanitized);
    const recordOutput = output();
    expect(
      await runCli(
        [
          'record',
          'http://127.0.0.1:3000',
          '--output',
          'scenes/private.scene/automation/replay.ts',
        ],
        { cwd: root, env: { ...process.env, RECORDER_CANARY: canary }, io: recordOutput.io },
      ),
    ).toBe(0);

    expect(captureMock).toHaveBeenCalledWith({
      cwd: root,
      env: expect.objectContaining({ RECORDER_CANARY: canary }),
      targetHref: 'http://127.0.0.1:3000/',
    });
    const replay = join(root, 'scenes/private.scene/automation/replay.ts');
    expect(await readFile(replay, 'utf8')).toBe(sanitized.source);
    expect((await stat(replay)).mode & 0o777).toBe(0o600);
    const reviewPath = join(root, 'scenes/private.scene/automation/recording-review.json');
    const patchPath = join(root, 'scenes/private.scene/automation/recording-review.patch');
    const review = JSON.parse(await readFile(reviewPath, 'utf8')) as {
      readonly source: {
        readonly sha256: string;
        readonly integrityVerifiedAfterPersistence: boolean;
      };
      readonly proposedPatch: {
        readonly preconditionSha256: string;
        readonly appliesAutomatically: boolean;
      };
      readonly fileImpact: {
        readonly files: readonly { readonly path: string; readonly operation: string }[];
      };
    };
    expect(review.source.integrityVerifiedAfterPersistence).toBe(true);
    expect(review.proposedPatch.preconditionSha256).toBe(review.source.sha256);
    expect(review.proposedPatch.appliesAutomatically).toBe(false);
    expect(review.fileImpact.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'automation/replay.ts', operation: 'create' }),
        expect.objectContaining({ path: 'scene.yaml', operation: 'create' }),
        expect.objectContaining({
          path: 'automation/recording-review.patch',
          operation: 'create',
        }),
      ]),
    );
    expect((await stat(reviewPath)).mode & 0o777).toBe(0o600);
    expect((await stat(patchPath)).mode & 0o777).toBe(0o600);
    expect(recordOutput.stdout()).toContain('2 fixture placeholder(s)');
    expect(recordOutput.stdout()).toContain('privacy-safe review');
    expect(recordOutput.stdout()).toContain('unapplied exact patch');
    expect(recordOutput.stdout()).not.toContain(canary);
    expect(recordOutput.stderr()).not.toContain(canary);
    expect((await files(root)).map((path) => relative(root, path))).not.toContainEqual(
      expect.stringMatching(/\.replay\.ts\..*\.tmp$/u),
    );

    const rerecordOutput = output();
    expect(
      await runCli(
        [
          'record',
          'http://127.0.0.1:3000',
          '--output',
          'scenes/private.scene/automation/replay.ts',
        ],
        { cwd: root, env: { ...process.env, RECORDER_CANARY: canary }, io: rerecordOutput.io },
      ),
    ).toBe(0);
    const replacedReview = JSON.parse(await readFile(reviewPath, 'utf8')) as {
      readonly fileImpact: {
        readonly files: readonly { readonly path: string; readonly operation: string }[];
      };
    };
    expect(replacedReview.fileImpact.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'automation/replay.ts', operation: 'replace' }),
        expect.objectContaining({ path: 'scene.yaml', operation: 'unchanged' }),
        expect.objectContaining({
          path: 'automation/recording-review.patch',
          operation: 'replace',
        }),
        expect.objectContaining({
          path: 'automation/recording-review.json',
          operation: 'replace',
        }),
      ]),
    );
    expect(rerecordOutput.stdout()).not.toContain(canary);
    expect(rerecordOutput.stderr()).not.toContain(canary);

    const buildOutput = output();
    expect(
      await runCli(['build', '--allow-unscanned-privacy'], {
        cwd: root,
        io: buildOutput.io,
      }),
    ).toBe(0);
    expect(buildOutput.stdout()).not.toContain(canary);
    expect(buildOutput.stderr()).not.toContain(canary);

    const allFiles = await files(root);
    expect(allFiles.some((path) => path.endsWith('.zip'))).toBe(true);
    for (const path of allFiles) {
      expect(
        Buffer.from(await readFile(path)).includes(Buffer.from(canary)),
        relative(root, path),
      ).toBe(false);
    }
  });
});
