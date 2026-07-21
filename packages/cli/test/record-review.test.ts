import { sha256 } from '@scenebook/core';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sanitizePlaywrightRecording } from '../src/record-capture.js';
import {
  prepareRecorderArtifactPaths,
  writeRecorderReviewArtifacts,
  type RecorderReviewArtifact,
} from '../src/record-review.js';
import { scaffoldRecordedScene } from '../src/record-scaffold.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function program(body: string): string {
  return `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
${body}
});
`;
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-record-review-'));
  roots.push(root);
  return root;
}

async function review(
  root: string,
  generatedSource: string,
): Promise<{
  readonly artifact: RecorderReviewArtifact;
  readonly reviewSource: string;
  readonly patchSource: string;
}> {
  const recording = sanitizePlaywrightRecording(generatedSource);
  const replayPath = join(root, 'scenes/checkout.scene/automation/replay.ts');
  const paths = await prepareRecorderArtifactPaths(root, replayPath);
  await mkdir(join(root, 'scenes/checkout.scene/automation'), { recursive: true });
  await writeFile(paths.replayPath, recording.source);
  const scaffold = await scaffoldRecordedScene({
    replayPath: paths.replayPath,
    targetHref: 'https://staging.example.test/private/start',
    title: 'Checkout',
  });
  const artifact = await writeRecorderReviewArtifacts({
    paths,
    source: recording.source,
    placeholders: recording.placeholders,
    manifestCreated: scaffold.created,
  });
  return {
    artifact,
    reviewSource: await readFile(paths.reviewPath, 'utf8'),
    patchSource: await readFile(paths.patchPath, 'utf8'),
  };
}

function applyStructuredEdits(source: string, artifact: RecorderReviewArtifact): string {
  let result = Buffer.from(source, 'utf8');
  for (const edit of [...artifact.proposedPatch.edits].sort(
    (left, right) => right.byteOffset - left.byteOffset,
  )) {
    result = Buffer.concat([
      result.subarray(0, edit.byteOffset),
      Buffer.from(edit.text, 'utf8'),
      result.subarray(edit.byteOffset),
    ]);
  }
  return result.toString('utf8');
}

describe('controlled recorder review artifacts', () => {
  it('reports semantic boundaries, brittle locators, missing checks, and timing hazards', async () => {
    const root = await project();
    const generated =
      program(`  await page.goto('https://staging.example.test/private?code=canary');
  await page.locator('.implementation-only').nth(2).click();
  await page.getByLabel('Résumé ✨').fill('private account value');
  await page.waitForTimeout(750);
  await page.getByRole('button').click();
  if (process.env.SCENEBOOK_RECORDED_BRANCH === 'alternate') {
    await page.getByTestId('optional-control').click();
  }`);
    const recording = sanitizePlaywrightRecording(generated);
    const result = await review(root, generated);

    expect(result.artifact.source.sha256).toBe(sha256(recording.source));
    expect(result.artifact.source.integrityVerifiedAfterPersistence).toBe(true);
    expect(result.artifact.summary).toMatchObject({ assertions: 0, suggestedSteps: 4 });
    expect(result.artifact.suggestedSteps.map((step) => step.rationale)).toEqual([
      'navigation-setup',
      'interaction',
      'form-outcome',
      'interaction',
    ]);
    expect(result.artifact.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'check.missing-outcome',
        'flow.dynamic-control',
        'locator.implementation-coupled',
        'locator.positional',
        'locator.unnamed-role',
        'wait.fixed-timeout',
      ]),
    );
    expect(result.artifact.proposedPatch.appliesAutomatically).toBe(false);
    expect(result.artifact.proposedPatch.hunkCount).toBeGreaterThan(0);
    expect(result.patchSource).toContain('diff --git a/scenes/checkout.scene/automation/replay.ts');
    expect(result.patchSource).not.toContain('.implementation-only');
    expect(result.reviewSource).not.toContain('.implementation-only');

    const proposed = applyStructuredEdits(recording.source, result.artifact);
    expect(sha256(proposed)).toBe(result.artifact.proposedPatch.resultSha256);
  });

  it('recognizes a terminal assertion and emits byte-for-byte deterministic output', async () => {
    const root = await project();
    const secondRoot = await project();
    const generated = program(`  await page.goto('https://staging.example.test/start');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('status', { name: 'Completed' })).toBeVisible();`);
    const first = await review(root, generated);
    const second = await review(secondRoot, generated);

    expect(first.artifact.summary.assertions).toBe(1);
    expect(first.artifact.findings.map((finding) => finding.code)).not.toContain(
      'check.missing-outcome',
    );
    expect(second.artifact).toEqual(first.artifact);
    expect(second.reviewSource).toBe(first.reviewSource);
    expect(second.patchSource).toBe(first.patchSource);
  });

  it('never copies raw URLs, entered values, locator text, or provider secrets into diagnostics', async () => {
    const root = await project();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const input = 'private customer value';
    const locator = 'Private customer control';
    const url = `https://internal.example.test/callback?token=${secret}`;
    const result = await review(
      root,
      program(`  await page.goto('${url}');
  await page.getByLabel('${locator}').fill('${input}');
  await page.getByText('${secret}').click();`),
    ).catch((error: unknown) => error);

    // The sanitizer fails closed because the secret is repeated in a non-input locator. No review
    // can be derived from source whose private material was not classifiable as an input fixture.
    expect(result).toBeInstanceOf(Error);

    const safe = await review(
      root,
      program(`  await page.goto('${url}');
  await page.getByLabel('${locator}').fill('${input}');
  await page.getByRole('button', { name: 'Continue' }).click();`),
    );
    for (const canary of [secret, input, locator, url, 'internal.example.test']) {
      expect(safe.reviewSource).not.toContain(canary);
      expect(safe.patchSource).not.toContain(canary);
    }
    expect(safe.reviewSource).not.toMatch(/(?:https?|file):\/\//iu);
    expect(safe.patchSource).not.toMatch(/(?:https?|file):\/\//iu);
    expect(safe.reviewSource).not.toContain(root);
    expect(safe.patchSource).not.toContain(root);
    expect(safe.reviewSource).toContain('SCENEBOOK_INPUT_001');
    expect(safe.reviewSource).toContain('SCENEBOOK_URL_001');
  });

  it('rejects path escape, private path names, symlink parents, and symlink artifact targets', async () => {
    const root = await project();
    const outside = await project();

    await expect(
      prepareRecorderArtifactPaths(
        root,
        join(outside, 'scenes/escaped.scene/automation/replay.ts'),
      ),
    ).rejects.toThrow('inside the current project');
    await expect(
      prepareRecorderArtifactPaths(
        root,
        join(root, 'scenes/owner@example.com.scene/automation/replay.ts'),
      ),
    ).rejects.toThrow('private data');
    await expect(
      prepareRecorderArtifactPaths(root, join(root, 'scenes/not-automation.scene/replay.ts')),
    ).rejects.toThrow('inside the Scene automation directory');
    await expect(
      prepareRecorderArtifactPaths(
        root,
        join(root, 'scenes/not-typescript.scene/automation/replay.js'),
      ),
    ).rejects.toThrow('TypeScript file');

    if (process.platform === 'win32') return;
    await mkdir(join(root, 'scenes/linked.scene'), { recursive: true });
    await symlink(outside, join(root, 'scenes/linked.scene/automation'));
    await expect(
      prepareRecorderArtifactPaths(root, join(root, 'scenes/linked.scene/automation/replay.ts')),
    ).rejects.toThrow('cannot traverse a symlink');

    await mkdir(join(root, 'scenes/safe.scene/automation'), { recursive: true });
    await writeFile(join(outside, 'review.json'), '{}');
    await symlink(
      join(outside, 'review.json'),
      join(root, 'scenes/safe.scene/automation/recording-review.json'),
    );
    await expect(
      prepareRecorderArtifactPaths(root, join(root, 'scenes/safe.scene/automation/replay.ts')),
    ).rejects.toThrow('cannot be a symlink');
  });

  it('fails closed when the persisted replay changes before diagnostics', async () => {
    const root = await project();
    const recording = sanitizePlaywrightRecording(
      program(`  await page.goto('https://staging.example.test/start');`),
    );
    const replayPath = join(root, 'scenes/changed.scene/automation/replay.ts');
    const paths = await prepareRecorderArtifactPaths(root, replayPath);
    await mkdir(join(root, 'scenes/changed.scene/automation'), { recursive: true });
    await writeFile(paths.replayPath, recording.source);
    const scaffold = await scaffoldRecordedScene({
      replayPath: paths.replayPath,
      targetHref: 'https://staging.example.test/start',
    });
    await writeFile(paths.replayPath, `${recording.source}\n// changed after persistence\n`);

    await expect(
      writeRecorderReviewArtifacts({
        paths,
        source: recording.source,
        placeholders: recording.placeholders,
        manifestCreated: scaffold.created,
      }),
    ).rejects.toThrow('changed before diagnostics');
    await expect(readFile(paths.reviewPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(paths.patchPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
