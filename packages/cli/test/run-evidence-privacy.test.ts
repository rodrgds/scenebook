import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactHash, canonicalJsonHash, sha256 } from '@scenebook/core';
import {
  BaselineSchema,
  BuildArtifactSchema,
  RunArtifactSchema,
  type PrivacySummary,
  type RunArtifact,
} from '@scenebook/schema';
import { afterEach, describe, expect, it } from 'vitest';

import { attestRunEvidence, refreshEvidenceBuilds, type OcrProvider } from '../src/privacy-scan.js';

const NOW = '2026-07-20T12:00:00.000Z';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function privacy(status: PrivacySummary['status'] = 'unknown'): PrivacySummary {
  return {
    status,
    scannedAt: NOW,
    scannerVersion: 'reporter-capture:1.0.0',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-run-privacy-'));
  roots.push(root);
  const evidenceDirectory = join(root, '.scenebook/runs');
  const baselineDirectory = join(root, '.scenebook/baselines');
  const assessmentDirectory = join(root, '.scenebook/privacy/evidence');
  const hash = sha256(PNG);
  const assetPath = `assets/${hash}.png`;
  await mkdir(join(evidenceDirectory, 'assets'), { recursive: true });
  await mkdir(join(evidenceDirectory, 'runs'), { recursive: true });
  await writeFile(join(evidenceDirectory, assetPath), PNG);
  const screenshot = {
    sha256: hash,
    path: assetPath,
    mediaType: 'image/png',
    byteLength: PNG.byteLength,
    role: 'screenshot' as const,
    width: 1,
    height: 1,
  };
  const run = RunArtifactSchema.parse({
    schemaVersion: 1,
    artifactVersion: 1,
    id: 'run-private-pixels',
    projectId: 'project',
    kind: 'run',
    createdAt: NOW,
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    sceneId: 'privacy-scene',
    runTargetId: 'primary',
    repository: { repository: 'acme/product', commit: 'a'.repeat(40) },
    sourceRevision: 'b'.repeat(64),
    status: 'passed',
    changeState: 'blocked',
    expectedStepIds: ['outcome'],
    attempts: [
      {
        id: 'attempt-private-pixels',
        index: 0,
        retry: 0,
        repeat: 0,
        status: 'passed',
        startedAt: NOW,
        endedAt: NOW,
        durationMs: 1,
        states: [
          {
            id: 'state-private-pixels',
            sceneId: 'privacy-scene',
            stepId: 'outcome',
            phase: 'after',
            capturedAt: NOW,
            route: '/',
            viewport: { width: 1, height: 1 },
            screenshot,
            screenshotHash: hash,
            privacy: privacy(),
          },
        ],
        checks: [{ checkId: 'outcome-check', stepId: 'outcome', status: 'passed' }],
        privacy: privacy(),
      },
    ],
    selectedAttemptId: 'attempt-private-pixels',
    startedAt: NOW,
    endedAt: NOW,
    durationMs: 1,
    privacy: privacy(),
  });
  const runPath = join(evidenceDirectory, 'runs', `${run.id}.json`);
  await writeFile(runPath, JSON.stringify(run));
  const build = BuildArtifactSchema.parse({
    schemaVersion: 1,
    artifactVersion: 1,
    id: 'build-private-pixels',
    projectId: run.projectId,
    kind: 'build',
    createdAt: NOW,
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    repository: run.repository,
    trigger: 'local',
    status: 'blocked',
    expectedRunPlan: [{ sceneId: run.sceneId, runTargetId: run.runTargetId, required: true }],
    runs: [
      {
        sceneId: run.sceneId,
        runTargetId: run.runTargetId,
        required: true,
        run: {
          id: run.id,
          kind: 'run',
          sha256: artifactHash(run),
          path: `runs/${run.id}.json`,
        },
        status: run.status,
        changeState: run.changeState,
      },
    ],
    startedAt: NOW,
    endedAt: NOW,
    summary: { total: 1, passed: 0, changed: 0, broken: 0, blocked: 1, pending: 0 },
  });
  await writeFile(join(evidenceDirectory, 'build.json'), JSON.stringify(build));
  return { assessmentDirectory, baselineDirectory, build, evidenceDirectory, run, runPath };
}

function baselineForRun(run: RunArtifact) {
  const selected = run.attempts[0]!;
  const state = selected.states[0]!;
  return BaselineSchema.parse({
    schemaVersion: 1,
    artifactVersion: 1,
    id: 'baseline-private-pixels',
    projectId: run.projectId,
    kind: 'baseline',
    createdAt: NOW,
    producer: { name: 'test', version: '1.0.0' },
    sceneId: run.sceneId,
    runTargetId: run.runTargetId,
    sourceRunId: run.id,
    sourceAttemptId: selected.id,
    sourceRevision: run.sourceRevision,
    completeness: 'complete',
    sourceRunStatus: 'passed',
    expectedStepIds: run.expectedStepIds,
    states: [
      {
        sceneId: state.sceneId,
        stepId: state.stepId,
        phase: state.phase,
        stateId: state.id,
        screenshot: state.screenshot,
        screenshotHash: state.screenshotHash,
        route: state.route,
        viewport: state.viewport,
        privacy: state.privacy,
      },
    ],
    checks: selected.checks,
    checksHash: canonicalJsonHash(selected.checks),
    approvals: [
      {
        id: 'privacy-baseline-approval',
        kind: 'visual',
        decision: 'approved',
        actorId: 'reviewer',
        createdAt: NOW,
        revision: run.sourceRevision,
      },
    ],
  });
}

function provider(text: string, paths: string[] = []): OcrProvider {
  return {
    id: 'fixture-ocr',
    version: '1.0.0',
    async scan(input) {
      paths.push(input.path);
      return [{ text, assetHash: input.assetHash }];
    },
  };
}

describe('exact Run screenshot privacy attestation', () => {
  it('rebinds Run, Review, Build, and baseline truth after OCR of a private exact copy', async () => {
    const value = await fixture();
    const scannedPaths: string[] = [];
    const attested = await attestRunEvidence({
      ...value,
      provider: provider('The workflow completed successfully.', scannedPaths),
      policyDigest: 'd'.repeat(64),
    });
    expect(scannedPaths).toHaveLength(1);
    expect(scannedPaths[0]).not.toBe(
      join(value.evidenceDirectory, value.run.attempts[0]!.states[0]!.screenshot.path),
    );
    await expect(readFile(scannedPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(attested.run).toMatchObject({ changeState: 'changed', privacy: { status: 'clear' } });
    expect(attested.run.attempts[0]!.states[0]!.privacy.status).toBe('clear');
    expect(attested.review.subject.revision).toBe(artifactHash(attested.run));

    await refreshEvidenceBuilds(value);
    let build = BuildArtifactSchema.parse(
      JSON.parse(await readFile(join(value.evidenceDirectory, 'build.json'), 'utf8')),
    );
    expect(build).toMatchObject({ status: 'changed', summary: { changed: 1, blocked: 0 } });
    expect(build.runs[0]!.run!.sha256).toBe(artifactHash(attested.run));

    const baseline = baselineForRun(attested.run);
    const baselinePath = join(value.baselineDirectory, baseline.sceneId);
    await mkdir(baselinePath, { recursive: true });
    await writeFile(join(baselinePath, `${baseline.runTargetId}.json`), JSON.stringify(baseline));
    const verified = await attestRunEvidence({
      ...value,
      provider: provider('The workflow completed successfully.'),
      policyDigest: 'd'.repeat(64),
    });
    expect(verified.run.changeState).toBe('passed');
    expect(verified.review).toMatchObject({
      changeState: 'passed',
      baseline: { id: baseline.id, sha256: artifactHash(baseline) },
    });
    await refreshEvidenceBuilds(value);
    build = BuildArtifactSchema.parse(
      JSON.parse(await readFile(join(value.evidenceDirectory, 'build.json'), 'utf8')),
    );
    expect(build).toMatchObject({ status: 'passed', summary: { passed: 1, changed: 0 } });
  });

  it('blocks pixels containing a credential and never persists the raw OCR match', async () => {
    const value = await fixture();
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const attested = await attestRunEvidence({
      ...value,
      provider: provider(`Authorization ${token}`),
      policyDigest: 'd'.repeat(64),
    });
    expect(attested.run).toMatchObject({ changeState: 'blocked', privacy: { status: 'blocked' } });
    expect(attested.review.changeState).toBe('blocked');
    expect(JSON.stringify(attested)).not.toContain(token);
  });

  it('rejects a Run path outside the configured evidence root', async () => {
    const value = await fixture();
    const outside = join(value.evidenceDirectory, '..', 'outside-run.json');
    await writeFile(outside, JSON.stringify(value.run));
    await expect(
      attestRunEvidence({
        ...value,
        runPath: outside,
        provider: provider('clear'),
        policyDigest: 'd'.repeat(64),
      }),
    ).rejects.toThrow(/inside the configured evidence directory/u);
  });

  it('rejects a symlinked screenshot before any bytes reach the OCR provider', async () => {
    const value = await fixture();
    const screenshotPath = join(
      value.evidenceDirectory,
      value.run.attempts[0]!.states[0]!.screenshot.path,
    );
    const outside = join(value.evidenceDirectory, '..', 'outside.png');
    await writeFile(outside, PNG);
    await rm(screenshotPath);
    await symlink(outside, screenshotPath);
    let scanned = false;

    await expect(
      attestRunEvidence({
        ...value,
        provider: {
          id: 'should-not-run',
          version: '1.0.0',
          async scan(input) {
            scanned = true;
            return [{ text: 'clear', assetHash: input.assetHash }];
          },
        },
        policyDigest: 'd'.repeat(64),
      }),
    ).rejects.toMatchObject({ reason: 'symlink' });
    expect(scanned).toBe(false);
  });
});
