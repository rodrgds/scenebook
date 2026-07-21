import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import { artifactHash, sceneSourceRevision, sha256 } from '@scenebook/core';
import { BuildArtifactSchema, RunArtifactSchema, SceneSchema } from '@scenebook/schema';
import ScenebookReporter from '../src/reporter.js';
import type { CapturedBeatMetadata } from '../src/types.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ScenebookReporter', () => {
  it('rejects reporter options that conflict with authoritative CLI bindings', () => {
    const previousProjectId = process.env.SCENEBOOK_PROJECT_ID;
    const previousRunTargetId = process.env.SCENEBOOK_RUN_TARGET_ID;
    process.env.SCENEBOOK_PROJECT_ID = 'bound-project';
    process.env.SCENEBOOK_RUN_TARGET_ID = 'bound-target';
    try {
      expect(() => new ScenebookReporter({ projectId: 'other-project' })).toThrow(
        /conflicts with authoritative SCENEBOOK_PROJECT_ID/u,
      );
      expect(
        () =>
          new ScenebookReporter({
            projectId: 'bound-project',
            runTargetId: 'other-target',
          }),
      ).toThrow(/conflicts with authoritative SCENEBOOK_RUN_TARGET_ID/u);
      expect(
        () => new ScenebookReporter({ projectId: 'bound-project', runTargetId: 'bound-target' }),
      ).not.toThrow();
    } finally {
      if (previousProjectId === undefined) delete process.env.SCENEBOOK_PROJECT_ID;
      else process.env.SCENEBOOK_PROJECT_ID = previousProjectId;
      if (previousRunTargetId === undefined) delete process.env.SCENEBOOK_RUN_TARGET_ID;
      else process.env.SCENEBOOK_RUN_TARGET_ID = previousRunTargetId;
    }
  });

  it('uses the wrapper-captured definition without leaking an external library call site', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-reporter-definition-'));
    directories.push(root);
    const sourcePath = join(root, 'wrapped.spec.ts');
    await writeFile(sourcePath, 'scene("Wrapped", {}, async () => {});');
    const externalLibraryPath = '/opt/scenebook-library/dist/fixture.js';
    const test = {
      id: 'wrapped-test',
      title: 'Wrapped Scene',
      annotations: [
        {
          type: 'scenebook:scene',
          description: JSON.stringify({
            id: 'wrapped-scene',
            title: 'Wrapped Scene',
            definition: { file: sourcePath, line: 1, column: 1 },
          }),
        },
      ],
      location: { file: externalLibraryPath, line: 114, column: 3 },
      parent: { project: () => ({ name: 'chromium' }) },
    } as unknown as TestCase;
    const result = {
      status: 'passed',
      retry: 0,
      startTime: new Date('2026-07-20T12:00:00.000Z'),
      duration: 10,
      errors: [],
      steps: [],
      attachments: [],
    } as unknown as TestResult;
    const reporter = new ScenebookReporter({ outputDirectory: '.scenebook/runs', quiet: true });
    reporter.onBegin(
      { rootDir: root } as FullConfig,
      { allTests: () => [test] } as unknown as Suite,
    );
    reporter.onTestEnd(test, result);
    await reporter.onEnd({ status: 'passed' } as FullResult);

    const output = join(root, '.scenebook/runs');
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
    expect(scene.automation.linkedTest?.path).toBe('wrapped.spec.ts');
    expect(scene.steps[0]!.source).toEqual({ path: 'wrapped.spec.ts', line: 1, column: 1 });
    expect(run.attempts[0]!.checks[0]!.source).toEqual({
      path: 'wrapped.spec.ts',
      line: 1,
      column: 1,
    });
    expect(JSON.stringify({ scene, run })).not.toContain(externalLibraryPath);
  });

  it('preserves supported Playwright evidence for an unmodified test without inventing Scene States', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-reporter-import-mode-'));
    directories.push(root);
    const sourcePath = join(root, 'ordinary.spec.ts');
    await writeFile(sourcePath, 'test("ordinary flow", async () => {});');
    const screenshot = await sharp({
      create: {
        width: 20,
        height: 12,
        channels: 4,
        background: { r: 40, g: 80, b: 120, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const trace = Buffer.from('PK\u0003\u0004scenebook trace fixture');
    const capturedAt = new Date('2026-07-20T12:00:00.000Z');
    const test = {
      id: 'ordinary-test',
      title: 'Ordinary flow',
      location: { file: sourcePath, line: 1, column: 1 },
      parent: { project: () => ({ name: 'chromium' }) },
    } as unknown as TestCase;
    const result = {
      status: 'passed',
      retry: 0,
      startTime: capturedAt,
      duration: 100,
      errors: [],
      steps: [],
      attachments: [
        { name: 'screenshot', contentType: 'image/png', body: screenshot },
        { name: 'trace', contentType: 'application/zip', body: trace },
        { name: 'ignored', contentType: 'text/plain', body: Buffer.from('not evidence') },
      ],
    } as unknown as TestResult;
    const reporter = new ScenebookReporter({ outputDirectory: '.scenebook/runs', quiet: true });
    reporter.onBegin(
      { rootDir: root } as FullConfig,
      { allTests: () => [test] } as unknown as Suite,
    );
    reporter.onTestEnd(test, result);
    await reporter.onEnd({ status: 'passed' } as FullResult);

    const output = join(root, '.scenebook/runs');
    const build = BuildArtifactSchema.parse(
      JSON.parse(await readFile(join(output, 'build.json'), 'utf8')),
    );
    const run = RunArtifactSchema.parse(
      JSON.parse(await readFile(join(output, build.runs[0]!.run!.path!), 'utf8')),
    );
    const attempt = run.attempts[0]!;
    expect(attempt.states).toEqual([]);
    expect(attempt.attachments).toEqual([
      expect.objectContaining({
        sha256: sha256(screenshot),
        role: 'screenshot',
        mediaType: 'image/png',
        width: 20,
        height: 12,
      }),
    ]);
    expect(attempt.trace).toMatchObject({
      sha256: sha256(trace),
      role: 'trace',
      mediaType: 'application/zip',
    });
    await expect(readFile(join(output, attempt.attachments[0]!.path))).resolves.toEqual(screenshot);
    await expect(readFile(join(output, attempt.trace!.path))).resolves.toEqual(trace);
    expect(run.privacy.status).toBe('unknown');
    expect(run.changeState).toBe('blocked');
  });

  it('assembles content-addressed state evidence and a schema-valid build from supported reporter attachments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-reporter-test-'));
    directories.push(root);
    const sourcePath = join(root, 'invite.spec.ts');
    await writeFile(sourcePath, 'test("Invite a teammate", async () => {});');
    const screenshot = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 245, g: 108, b: 66, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const hash = sha256(screenshot);
    const screenshotName = `scenebook-state-invite-before-${hash.slice(0, 12)}.png`;
    const capturedAt = '2026-07-20T12:00:00.000Z';
    const beat: CapturedBeatMetadata = {
      version: 1,
      sceneId: 'invite-member',
      stepId: 'open-form',
      title: 'Open form',
      states: [
        {
          version: 1,
          sceneId: 'invite-member',
          stepId: 'open-form',
          phase: 'before',
          capturedAt,
          route: '/settings/members',
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false },
          screenshotHash: hash,
          screenshotAttachment: screenshotName,
          masksApplied: ['automatic-sensitive-fields'],
        },
      ],
    };
    const test = {
      id: 'invite-test',
      title: 'Invite a teammate',
      annotations: [
        {
          type: 'scenebook:scene',
          description: JSON.stringify({ id: 'invite-member', title: 'Invite a teammate' }),
        },
      ],
      location: { file: sourcePath, line: 1, column: 1 },
      parent: { project: () => ({ name: 'chromium' }) },
    } as unknown as TestCase;
    const semanticStep = {
      category: 'test.step',
      title: 'Open form',
      startTime: new Date(capturedAt),
      duration: 200,
      location: { file: sourcePath, line: 1, column: 1 },
      steps: [
        {
          category: 'pw:api',
          title: 'page.goto',
          startTime: new Date(capturedAt),
          duration: 100,
          location: { file: sourcePath, line: 1, column: 1 },
          steps: [],
        },
        {
          category: 'expect',
          title: 'expect(locator).toBeVisible',
          startTime: new Date(new Date(capturedAt).getTime() + 100),
          duration: 50,
          location: { file: sourcePath, line: 1, column: 1 },
          steps: [],
        },
      ],
    } as unknown as TestStep;
    const result = {
      status: 'passed',
      retry: 0,
      startTime: new Date(capturedAt),
      duration: 250,
      errors: [],
      steps: [semanticStep],
      attachments: [
        { name: screenshotName, contentType: 'image/png', body: screenshot },
        {
          name: 'scenebook-beat-0001-open-form.json',
          contentType: 'application/vnd.scenebook.beat+json',
          body: Buffer.from(JSON.stringify(beat)),
        },
      ],
    } as unknown as TestResult;
    const reporter = new ScenebookReporter({ outputDirectory: '.scenebook/runs', quiet: true });
    reporter.onBegin(
      { rootDir: root } as FullConfig,
      { allTests: () => [test] } as unknown as Suite,
    );
    reporter.onTestEnd(test, result);
    await reporter.onEnd({ status: 'passed' } as FullResult);

    const build = BuildArtifactSchema.parse(
      JSON.parse(await readFile(join(root, '.scenebook/runs/build.json'), 'utf8')),
    );
    const runPath = join(root, '.scenebook/runs', build.runs[0]!.run!.path!);
    const runContents = await readFile(runPath, 'utf8');
    const run = RunArtifactSchema.parse(JSON.parse(runContents));
    const scene = SceneSchema.parse(
      JSON.parse(
        await readFile(
          join(root, '.scenebook/runs/scenes', run.sceneId, `${run.sourceRevision}.json`),
          'utf8',
        ),
      ),
    );
    const state = run.attempts[0]!.states[0]!;
    expect(run.sourceRevision).toBe(sceneSourceRevision(scene));
    expect(build.runs[0]!.run!.sha256).toBe(artifactHash(run));
    expect(build.runs[0]!.run!.sha256).not.toBe(sha256(runContents));
    expect(build.runs[0]!.changeState).toBe(run.changeState);
    expect(run.attempts[0]!.actions).toHaveLength(2);
    expect(run.attempts[0]!.checks).toHaveLength(1);
    expect(run.attempts[0]!.checks[0]).toMatchObject({
      stepId: 'open-form',
      status: 'passed',
      source: { path: 'invite.spec.ts', line: 1, column: 1 },
    });
    expect(state.screenshotHash).toBe(hash);
    expect(state.masksApplied).toEqual(['automatic-sensitive-fields']);
    expect(await readFile(join(root, '.scenebook/runs', state.screenshot.path))).toEqual(
      screenshot,
    );
    expect(run.changeState).toBe('blocked');
    expect(state.privacy.status).toBe('unknown');
    expect(build.summary).toMatchObject({ total: 1, passed: 0, broken: 0, blocked: 1 });
  });
});
