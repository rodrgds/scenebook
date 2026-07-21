import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { artifactHash, canonicalJsonHash, sha256 } from '@scenebook/core';
import { hammingDistanceHex } from '@scenebook/diff';
import {
  BaselineSchema,
  BuildArtifactSchema,
  RunArtifactSchema,
  type Baseline,
  type BuildArtifact,
  type PrivacySummary,
  type RunArtifact,
} from '@scenebook/schema';

import { mergeShardBuildEvidence, reviewRunEvidence } from '../src/evidence.js';
import { fingerprintScreenshot } from '../src/image.js';

const NOW = '2026-07-20T12:00:00.000Z';
const COMMIT = 'a'.repeat(40);

function privacy(): PrivacySummary {
  return {
    status: 'clear',
    scannedAt: NOW,
    scannerVersion: 'test-ocr:1.0.0',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  };
}

function runForImage(options: {
  readonly sceneId?: string;
  readonly hash: string;
  readonly perceptualHash: string;
  readonly width: number;
  readonly height: number;
}): RunArtifact {
  const sceneId = options.sceneId ?? 'image-scene';
  const screenshot = {
    sha256: options.hash,
    path: `assets/${options.hash}.png`,
    mediaType: 'image/png',
    byteLength: 100,
    role: 'screenshot' as const,
    width: options.width,
    height: options.height,
  };
  return RunArtifactSchema.parse({
    schemaVersion: 1,
    artifactVersion: 1,
    id: `run-${sceneId}`,
    projectId: 'project',
    kind: 'run',
    createdAt: NOW,
    producer: { name: 'test', version: '1.0.0' },
    sceneId,
    runTargetId: 'primary',
    repository: { repository: 'acme/product', commit: COMMIT },
    sourceRevision: 'b'.repeat(64),
    status: 'passed',
    expectedStepIds: ['step'],
    attempts: [
      {
        id: `attempt-${sceneId}`,
        index: 0,
        retry: 0,
        repeat: 0,
        status: 'passed',
        startedAt: NOW,
        endedAt: NOW,
        durationMs: 1,
        states: [
          {
            id: `state-${sceneId}`,
            sceneId,
            stepId: 'step',
            phase: 'after',
            capturedAt: NOW,
            route: '/',
            viewport: { width: options.width, height: options.height },
            screenshot,
            screenshotHash: options.hash,
            perceptualHash: options.perceptualHash,
            privacy: privacy(),
          },
        ],
        checks: [{ checkId: 'check', stepId: 'step', status: 'passed' }],
        privacy: privacy(),
      },
    ],
    selectedAttemptId: `attempt-${sceneId}`,
    startedAt: NOW,
    endedAt: NOW,
    durationMs: 1,
    privacy: privacy(),
  });
}

function baselineForRun(run: RunArtifact): Baseline {
  const selected = run.attempts[0]!;
  const state = selected.states[0]!;
  return BaselineSchema.parse({
    schemaVersion: 1,
    artifactVersion: 1,
    id: `baseline-${run.sceneId}`,
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
        perceptualHash: state.perceptualHash,
        route: state.route,
        viewport: state.viewport,
        privacy: state.privacy,
      },
    ],
    checks: selected.checks,
    checksHash: canonicalJsonHash(selected.checks),
    approvals: [
      {
        id: 'approval',
        kind: 'visual',
        decision: 'approved',
        actorId: 'reviewer',
        createdAt: NOW,
        revision: run.sourceRevision,
      },
    ],
  });
}

function shardBuild(options: {
  readonly current: number;
  readonly total?: number;
  readonly run: RunArtifact;
  readonly commit?: string;
}): BuildArtifact {
  const run = reviewRunEvidence(options.run).run;
  return BuildArtifactSchema.parse({
    schemaVersion: 1,
    artifactVersion: 1,
    id: `build-shard-${options.current}`,
    projectId: run.projectId,
    kind: 'build',
    createdAt: NOW,
    producer: { name: 'test', version: '1.0.0' },
    repository: { repository: 'acme/product', commit: options.commit ?? COMMIT },
    trigger: 'push',
    completeness: 'partial',
    shard: { current: options.current, total: options.total ?? 2 },
    status: 'changed',
    expectedRunPlan: [{ sceneId: run.sceneId, runTargetId: run.runTargetId, required: true }],
    runs: [
      {
        sceneId: run.sceneId,
        runTargetId: run.runTargetId,
        required: true,
        run: { id: run.id, kind: 'run', sha256: artifactHash(run), path: `runs/${run.id}.json` },
        status: run.status,
        changeState: run.changeState,
      },
    ],
    startedAt: NOW,
    endedAt: NOW,
    summary: { total: 1, passed: 0, changed: 1, broken: 0, blocked: 0, pending: 0 },
  });
}

describe('retry evidence classification', () => {
  it('keeps a retry-recovered Run changed even when its selected evidence matches the Baseline', () => {
    const original = runForImage({
      hash: '1'.repeat(64),
      perceptualHash: '2'.repeat(64),
      width: 1280,
      height: 720,
    });
    const selected = original.attempts[0]!;
    const recovered = RunArtifactSchema.parse({
      ...original,
      id: 'run-retry-recovered',
      attempts: [
        {
          ...selected,
          id: 'attempt-initial-failure',
          index: 0,
          retry: 0,
          status: 'failed',
          checks: selected.checks.map((check) => ({ ...check, status: 'failed' as const })),
        },
        {
          ...selected,
          id: 'attempt-retry-pass',
          index: 1,
          retry: 1,
        },
      ],
      selectedAttemptId: 'attempt-retry-pass',
    });

    const reviewed = reviewRunEvidence(recovered, baselineForRun(original));

    expect(reviewed.run.status).toBe('passed');
    expect(reviewed.run.selectedAttemptId).toBe('attempt-retry-pass');
    expect(reviewed.run.changeState).toBe('changed');
    expect(reviewed.review.changeState).toBe('changed');
    expect(reviewed.review.changes).toContainEqual(
      expect.objectContaining({
        dimension: 'functional',
        severity: 'warning',
        summary: 'Scene includes non-passing attempt history despite a selected pass',
        metrics: { nonPassingAttempts: 1 },
      }),
    );
  });
});

describe('decoded screenshot fingerprints', () => {
  it('treats different PNG encodings of identical decoded pixels as the same evidence', async () => {
    const source = sharp({
      create: {
        width: 32,
        height: 24,
        channels: 4,
        background: { r: 245, g: 108, b: 66, alpha: 1 },
      },
    });
    const [fast, compact] = await Promise.all([
      source.clone().png({ compressionLevel: 0 }).toBuffer(),
      source.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
    ]);
    expect(sha256(fast)).not.toBe(sha256(compact));
    const [left, right] = await Promise.all([
      fingerprintScreenshot(fast),
      fingerprintScreenshot(compact),
    ]);
    expect(left).toEqual(right);

    const baselineRun = runForImage({ ...left, hash: sha256(fast) });
    const candidate = runForImage({ ...right, hash: sha256(compact) });
    expect(reviewRunEvidence(candidate, baselineForRun(baselineRun)).run.changeState).toBe(
      'passed',
    );
  });

  it('detects a flat-color pixel change that an edge-only dHash would miss', async () => {
    const [black, white] = await Promise.all([
      sharp({
        create: { width: 32, height: 24, channels: 4, background: '#000000' },
      })
        .png()
        .toBuffer(),
      sharp({
        create: { width: 32, height: 24, channels: 4, background: '#ffffff' },
      })
        .png()
        .toBuffer(),
    ]);
    const [left, right] = await Promise.all([
      fingerprintScreenshot(black),
      fingerprintScreenshot(white),
    ]);
    expect(hammingDistanceHex(left.perceptualHash, right.perceptualHash)).toBeGreaterThan(4);
    const baselineRun = runForImage({ ...left, hash: sha256(black) });
    const candidate = runForImage({ ...right, hash: sha256(white) });
    const reviewed = reviewRunEvidence(candidate, baselineForRun(baselineRun));
    expect(reviewed.run.changeState).toBe('changed');
    expect(reviewed.review.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ dimension: 'visual' })]),
    );
  });
});

describe('shard evidence finalization', () => {
  it('merges only an exact, provenance-compatible shard set', () => {
    const firstRun = runForImage({
      sceneId: 'scene-a',
      hash: '1'.repeat(64),
      perceptualHash: '0'.repeat(16),
      width: 1,
      height: 1,
    });
    const secondRun = runForImage({
      sceneId: 'scene-b',
      hash: '2'.repeat(64),
      perceptualHash: '0'.repeat(16),
      width: 1,
      height: 1,
    });
    const first = shardBuild({ current: 1, run: firstRun });
    const second = shardBuild({ current: 2, run: secondRun });
    const merged = mergeShardBuildEvidence([second, first]);
    expect(merged).toMatchObject({
      completeness: 'complete',
      status: 'changed',
      summary: { total: 2, changed: 2, pending: 0 },
    });
    expect(merged.shard).toBeUndefined();
    expect(merged.runs.map((reference) => reference.sceneId)).toEqual(['scene-a', 'scene-b']);

    expect(() => mergeShardBuildEvidence([first])).toThrow(/exactly 2 fragments/u);
    expect(() => mergeShardBuildEvidence([first, first])).toThrow(/missing or duplicate/u);
    expect(() =>
      mergeShardBuildEvidence([
        first,
        shardBuild({ current: 2, run: secondRun, commit: 'b'.repeat(40) }),
      ]),
    ).toThrow(/provenance/u);
    expect(() =>
      mergeShardBuildEvidence([
        first,
        shardBuild({
          current: 2,
          run: runForImage({
            sceneId: 'scene-a',
            hash: '3'.repeat(64),
            perceptualHash: '0'.repeat(16),
            width: 1,
            height: 1,
          }),
        }),
      ]),
    ).toThrow(/duplicate Scene\/Target/u);
  });
});
