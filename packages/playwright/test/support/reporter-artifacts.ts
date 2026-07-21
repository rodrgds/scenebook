import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import { canonicalJsonHash, sha256 } from '@scenebook/core';
import {
  BaselineSchema,
  BuildArtifactSchema,
  RunArtifactSchema,
  SceneSchema,
} from '@scenebook/schema';
import sharp from 'sharp';

import ScenebookReporter from '../../src/reporter.js';
import type { CapturedBeatMetadata } from '../../src/types.js';

export interface ReporterArtifactFixtureOptions {
  readonly root: string;
  readonly now: Date;
  readonly projectId: string;
  readonly repository: string;
  readonly commit: string;
  readonly runTargetId?: string;
}

/** Invoke the first-party Reporter hooks and read back only files it emitted. */
export async function writeReporterArtifactFixture(options: ReporterArtifactFixtureOptions) {
  const sourcePath = join(options.root, 'invite.spec.ts');
  await writeFile(sourcePath, 'test("Invite a teammate", async () => {});');
  const screenshot = await sharp({
    create: {
      width: 24,
      height: 16,
      channels: 4,
      background: { r: 34, g: 197, b: 94, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const screenshotHash = sha256(screenshot);
  const screenshotName = `scenebook-state-invite-after-${screenshotHash.slice(0, 12)}.png`;
  const beat: CapturedBeatMetadata = {
    version: 1,
    sceneId: 'invite-member',
    stepId: 'submit-invite',
    title: 'Submit invite',
    instruction: 'Submit the invitation form.',
    states: [
      {
        version: 1,
        sceneId: 'invite-member',
        stepId: 'submit-invite',
        phase: 'after',
        capturedAt: options.now.toISOString(),
        route: '/settings/members',
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false },
        screenshotHash,
        screenshotAttachment: screenshotName,
        masksApplied: ['automatic-sensitive-fields'],
        privacy: {
          status: 'clear',
          scannedAt: options.now.toISOString(),
          scannerVersion: 'reporter-fixture-ocr:1.0.0',
          counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
          findings: [],
        },
      },
    ],
  };
  const test = {
    id: 'invite-test',
    title: 'Invite a teammate',
    annotations: [
      {
        type: 'scenebook:scene',
        description: JSON.stringify({
          id: 'invite-member',
          title: 'Invite a teammate',
          criticality: 'critical',
          audience: ['developers'],
        }),
      },
    ],
    location: { file: sourcePath, line: 1, column: 1 },
    parent: { project: () => ({ name: 'chromium' }) },
  } as unknown as TestCase;
  const testStep = {
    category: 'test.step',
    title: 'Submit invite',
    startTime: options.now,
    duration: 200,
    location: test.location,
    steps: [
      {
        category: 'pw:api',
        title: 'locator.click',
        startTime: options.now,
        duration: 75,
        location: test.location,
        steps: [],
      },
      {
        category: 'expect',
        title: 'expect(success message).toBeVisible',
        startTime: new Date(options.now.getTime() + 100),
        duration: 50,
        location: test.location,
        steps: [],
      },
    ],
  } as unknown as TestStep;
  const result = {
    status: 'passed',
    retry: 0,
    startTime: options.now,
    duration: 250,
    errors: [],
    steps: [testStep],
    attachments: [
      { name: screenshotName, contentType: 'image/png', body: screenshot },
      {
        name: 'scenebook-beat-0001-submit-invite.json',
        contentType: 'application/vnd.scenebook.beat+json',
        body: Buffer.from(JSON.stringify(beat)),
      },
    ],
  } as unknown as TestResult;
  const reporter = new ScenebookReporter({
    outputDirectory: '.scenebook/runs',
    projectId: options.projectId,
    runTargetId: options.runTargetId ?? 'primary',
    repository: options.repository,
    commit: options.commit,
    branch: 'main',
    quiet: true,
  });
  reporter.onBegin(
    { rootDir: options.root } as FullConfig,
    { allTests: () => [test] } as unknown as Suite,
  );
  reporter.onTestEnd(test, result);
  await reporter.onEnd({ status: 'passed' } as FullResult);

  const output = join(options.root, '.scenebook/runs');
  const candidateBuild = BuildArtifactSchema.parse(
    JSON.parse(await readFile(join(output, 'build.json'), 'utf8')),
  );
  const candidateRun = RunArtifactSchema.parse(
    JSON.parse(await readFile(join(output, candidateBuild.runs[0]!.run!.path!), 'utf8')),
  );
  const selected = candidateRun.attempts.find(
    (attempt) => attempt.id === candidateRun.selectedAttemptId,
  )!;
  const baseline = BaselineSchema.parse({
    schemaVersion: 1,
    artifactVersion: 1,
    id: 'baseline-reporter-fixture',
    projectId: candidateRun.projectId,
    kind: 'baseline',
    createdAt: options.now.toISOString(),
    producer: { name: 'reporter-fixture', version: '1.0.0' },
    sceneId: candidateRun.sceneId,
    runTargetId: candidateRun.runTargetId,
    sourceRunId: candidateRun.id,
    sourceAttemptId: selected.id,
    sourceRevision: candidateRun.sourceRevision,
    completeness: 'complete',
    sourceRunStatus: 'passed',
    expectedStepIds: candidateRun.expectedStepIds,
    states: selected.states.map((state) => ({
      sceneId: state.sceneId,
      stepId: state.stepId,
      phase: state.phase,
      stateId: state.id,
      screenshot: state.screenshot,
      screenshotHash: state.screenshotHash,
      ...(state.perceptualHash ? { perceptualHash: state.perceptualHash } : {}),
      route: state.route,
      viewport: state.viewport,
      ...(state.target ? { target: state.target } : {}),
      ...(state.semantic ? { semantic: state.semantic } : {}),
      privacy: state.privacy,
    })),
    checks: selected.checks,
    checksHash: canonicalJsonHash(selected.checks),
    approvals: [
      {
        id: 'approval-reporter-fixture',
        kind: 'visual',
        decision: 'approved',
        actorId: 'fixture',
        createdAt: options.now.toISOString(),
        revision: candidateRun.sourceRevision,
      },
    ],
  });
  const baselineDirectory = join(options.root, '.scenebook/baselines', candidateRun.sceneId);
  await mkdir(baselineDirectory, { recursive: true });
  await writeFile(
    join(baselineDirectory, `${candidateRun.runTargetId}.json`),
    JSON.stringify(baseline),
  );
  const baselineReporter = new ScenebookReporter({
    outputDirectory: '.scenebook/runs',
    baselineDirectory: '.scenebook/baselines',
    projectId: options.projectId,
    runTargetId: options.runTargetId ?? 'primary',
    repository: options.repository,
    commit: options.commit,
    branch: 'main',
    quiet: true,
  });
  baselineReporter.onBegin(
    { rootDir: options.root } as FullConfig,
    { allTests: () => [test] } as unknown as Suite,
  );
  baselineReporter.onTestEnd(test, result);
  await baselineReporter.onEnd({ status: 'passed' } as FullResult);

  const build = BuildArtifactSchema.parse(
    JSON.parse(await readFile(join(output, 'build.json'), 'utf8')),
  );
  const run = RunArtifactSchema.parse(
    JSON.parse(await readFile(join(output, build.runs[0]!.run!.path!), 'utf8')),
  );
  const scene = SceneSchema.parse(
    JSON.parse(
      await readFile(join(output, 'scenes', run.sceneId, `${run.sourceRevision}.json`), 'utf8'),
    ),
  );
  return { build, run, scene };
}
