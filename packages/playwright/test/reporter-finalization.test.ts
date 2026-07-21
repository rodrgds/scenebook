import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { BuildArtifactSchema, RunArtifactSchema, type PrivacySummary } from '@scenebook/schema';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import ScenebookReporter from '../src/reporter.js';
import type { CapturedBeatMetadata } from '../src/types.js';
import { sha256 } from '@scenebook/core';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function clearPrivacy(): PrivacySummary {
  return {
    status: 'clear',
    scannedAt: NOW.toISOString(),
    scannerVersion: 'test-ocr:1.0.0',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  };
}

function testCase(sourcePath: string, repeat = 0, title = 'Retry Scene'): TestCase {
  return {
    id: `retry-test-${repeat}`,
    title,
    repeatEachIndex: repeat,
    annotations: [
      {
        type: 'scenebook:scene',
        description: JSON.stringify({ id: 'retry-scene', title: 'Retry Scene' }),
      },
    ],
    location: { file: sourcePath, line: 1, column: 1 },
    parent: { project: () => ({ name: 'chromium' }) },
  } as unknown as TestCase;
}

async function screenshotAttachments(retry: number) {
  const screenshot = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 59, g: 130, b: 246, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const hash = sha256(screenshot);
  const name = `scenebook-state-retry-after-${hash.slice(0, 12)}.png`;
  const beat: CapturedBeatMetadata = {
    version: 1,
    sceneId: 'retry-scene',
    stepId: 'outcome',
    title: 'Verify the outcome',
    states: [
      {
        version: 1,
        sceneId: 'retry-scene',
        stepId: 'outcome',
        phase: 'after',
        capturedAt: new Date(NOW.getTime() + retry * 1_000).toISOString(),
        route: '/',
        viewport: { width: 16, height: 16, deviceScaleFactor: 1, isMobile: false },
        screenshotHash: hash,
        screenshotAttachment: name,
        masksApplied: [],
        privacy: clearPrivacy(),
      },
    ],
  };
  return [
    { name, contentType: 'image/png', body: screenshot },
    {
      name: `scenebook-beat-${retry}-outcome.json`,
      contentType: 'application/vnd.scenebook.beat+json',
      body: Buffer.from(JSON.stringify(beat)),
    },
  ];
}

async function result(status: 'passed' | 'failed', retry: number): Promise<TestResult> {
  return {
    status,
    retry,
    startTime: new Date(NOW.getTime() + retry * 1_000),
    duration: 25,
    errors: status === 'failed' ? [{ message: `attempt ${retry} failed` }] : [],
    steps: [],
    attachments: await screenshotAttachments(retry),
  } as unknown as TestResult;
}

async function readBuildAndRun(root: string, buildPath = '.scenebook/runs/build.json') {
  const build = BuildArtifactSchema.parse(
    JSON.parse(await readFile(join(root, buildPath), 'utf8')),
  );
  const runRoot = join(root, '.scenebook/runs');
  const run = RunArtifactSchema.parse(
    JSON.parse(await readFile(join(runRoot, build.runs[0]!.run!.path!), 'utf8')),
  );
  return { build, run };
}

describe('reporter finalization', () => {
  it('collapses a failed retry followed by a pass into one logical changed Run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retry-pass-'));
    directories.push(root);
    const sourcePath = join(root, 'retry.spec.ts');
    await writeFile(sourcePath, 'test("Retry Scene", async () => {});');
    const test = testCase(sourcePath);
    const reporter = new ScenebookReporter({ outputDirectory: '.scenebook/runs', quiet: true });
    reporter.onBegin(
      { rootDir: root } as FullConfig,
      { allTests: () => [test] } as unknown as Suite,
    );
    reporter.onTestEnd(test, await result('failed', 0));
    reporter.onTestEnd(test, await result('passed', 1));
    await reporter.onEnd({ status: 'passed' } as FullResult);

    const { build, run } = await readBuildAndRun(root);
    expect(build.summary).toMatchObject({ total: 1, changed: 1, broken: 0, pending: 0 });
    expect(run).toMatchObject({ status: 'passed', changeState: 'changed' });
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts.map((attempt) => [attempt.retry, attempt.status])).toEqual([
      [0, 'failed'],
      [1, 'passed'],
    ]);
    expect(run.selectedAttemptId).toBe(run.attempts[1]!.id);
  });

  it('makes an exhausted retry and any failed repeat Broken without overflowing Build totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retry-failed-'));
    directories.push(root);
    const sourcePath = join(root, 'retry.spec.ts');
    await writeFile(sourcePath, 'test("Retry Scene", async () => {});');
    const firstRepeat = testCase(sourcePath, 0);
    const secondRepeat = testCase(sourcePath, 1);
    const reporter = new ScenebookReporter({ outputDirectory: '.scenebook/runs', quiet: true });
    reporter.onBegin(
      { rootDir: root } as FullConfig,
      { allTests: () => [firstRepeat, secondRepeat] } as unknown as Suite,
    );
    reporter.onTestEnd(firstRepeat, await result('passed', 0));
    reporter.onTestEnd(secondRepeat, await result('failed', 0));
    reporter.onTestEnd(secondRepeat, await result('failed', 1));
    await reporter.onEnd({ status: 'failed' } as FullResult);

    const { build, run } = await readBuildAndRun(root);
    expect(build.summary).toMatchObject({ total: 1, passed: 0, broken: 1, pending: 0 });
    expect(run).toMatchObject({ status: 'failed', changeState: 'broken' });
    expect(run.attempts).toHaveLength(3);
    expect(run.attempts.map((attempt) => attempt.repeat)).toEqual([0, 1, 1]);
    expect(run.attempts.find((attempt) => attempt.id === run.selectedAttemptId)).toMatchObject({
      repeat: 1,
      retry: 1,
      status: 'failed',
    });
  });

  it('writes only an explicit partial fragment for a Playwright shard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-reporter-shard-'));
    directories.push(root);
    const sourcePath = join(root, 'retry.spec.ts');
    await writeFile(sourcePath, 'test("Retry Scene", async () => {});');
    const test = testCase(sourcePath);
    const reporter = new ScenebookReporter({ outputDirectory: '.scenebook/runs', quiet: true });
    reporter.onBegin(
      { rootDir: root, shard: { current: 1, total: 2 } } as FullConfig,
      { allTests: () => [test] } as unknown as Suite,
    );
    reporter.onTestEnd(test, await result('passed', 0));
    await reporter.onEnd({ status: 'passed' } as FullResult);

    const { build, run } = await readBuildAndRun(root, '.scenebook/runs/shards/1-of-2/build.json');
    expect(build).toMatchObject({ completeness: 'partial', shard: { current: 1, total: 2 } });
    expect(run.attempts[0]!.shard).toEqual({ current: 1, total: 2 });
    await expect(readFile(join(root, '.scenebook/runs/build.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects multiple Playwright owners claiming one Scene/Target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-reporter-owner-'));
    directories.push(root);
    const firstPath = join(root, 'first.spec.ts');
    const secondPath = join(root, 'second.spec.ts');
    await writeFile(firstPath, 'test("First", async () => {});');
    await writeFile(secondPath, 'test("Second", async () => {});');
    const first = testCase(firstPath, 0, 'First owner');
    const second = testCase(secondPath, 0, 'Second owner');
    const reporter = new ScenebookReporter({ outputDirectory: '.scenebook/runs', quiet: true });
    reporter.onBegin(
      { rootDir: root } as FullConfig,
      { allTests: () => [first, second] } as unknown as Suite,
    );
    reporter.onTestEnd(first, await result('passed', 0));
    reporter.onTestEnd(second, await result('passed', 0));
    await expect(reporter.onEnd({ status: 'passed' } as FullResult)).rejects.toThrow(
      /Multiple Playwright tests claim Scene retry-scene/u,
    );
  });
});
