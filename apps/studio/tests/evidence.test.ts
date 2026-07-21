import {
  ARTIFACT_VERSION,
  BaselineSchema,
  ReviewSchema,
  RunArtifactSchema,
  SCHEMA_VERSION,
  SceneSchema,
  type Review,
  type RunArtifact,
} from '@scenebook/schema';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import {
  EvidenceImportError,
  assertEvidenceExpandedBudget,
  attachEvidenceToScene,
  canonicalEvidenceHash,
  inspectEvidenceFiles,
  inspectEvidenceInputs,
} from '../src/lib/evidence';
import { toEditorScene } from '../src/lib/portable';
import {
  compactStoredSceneRecord,
  hydrateStoredSceneRecord,
  MemoryRecoveryJournal,
  MemorySceneStorage,
  releaseLocalMediaUrls,
  SceneLibrary,
} from '../src/lib/scene-library';

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwO0GQAAAABJRU5ErkJggg==',
  ),
  (character) => character.charCodeAt(0),
);
const AT = '2026-07-21T05:00:00.000Z';

function privacy(status: 'clear' | 'unknown' = 'clear') {
  return {
    status,
    scannedAt: AT,
    scannerVersion: 'test-scanner/1.0.0',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  } as const;
}

async function fixture() {
  const portable = SceneSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'checkout',
    title: 'Checkout',
    slug: 'checkout',
    steps: [
      {
        id: 'confirm-order',
        title: 'Confirm order',
        states: {
          before: {
            id: 'source-checkout-before',
            route: '/checkout',
            viewport: { width: 1280, height: 720 },
          },
        },
      },
    ],
  });
  const scene = toEditorScene(portable, {}, {});
  const screenshotHash = await canonicalEvidenceHash([...PNG]);
  // canonicalEvidenceHash is the artifact contract, not the raw-byte contract. Use Web Crypto for
  // the exact screenshot identity declared by AssetRef.
  const rawDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', PNG));
  const rawHash = [...rawDigest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  expect(screenshotHash).not.toBe(rawHash);
  const sourceRevision = await canonicalEvidenceHash(portable);
  const run = RunArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: 'run-checkout-1',
    projectId: 'shop',
    kind: 'run',
    createdAt: AT,
    producer: { name: '@scenebook/playwright', version: '0.1.0', runtime: 'test' },
    sceneId: portable.id,
    runTargetId: 'desktop-chromium',
    repository: {
      provider: 'github',
      repository: 'example/shop',
      commit: 'abcdef1234567890',
      dirty: false,
    },
    sourceRevision,
    status: 'passed',
    changeState: 'changed',
    expectedStepIds: ['confirm-order'],
    attempts: [
      {
        id: 'attempt-checkout-1',
        index: 0,
        status: 'passed',
        startedAt: AT,
        endedAt: AT,
        durationMs: 240,
        actions: [],
        checks: [
          {
            checkId: 'check-receipt-visible',
            stepId: 'confirm-order',
            status: 'passed',
            message: 'Receipt is visible',
          },
        ],
        states: [
          {
            id: 'state-checkout-after',
            sceneId: portable.id,
            stepId: 'confirm-order',
            phase: 'after',
            capturedAt: AT,
            route: '/checkout/complete',
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false },
            screenshot: {
              sha256: rawHash,
              path: `assets/${rawHash}.png`,
              mediaType: 'image/png',
              byteLength: PNG.byteLength,
              role: 'screenshot',
              width: 1,
              height: 1,
            },
            screenshotHash: rawHash,
            masksApplied: [],
            privacy: privacy(),
          },
        ],
        errors: [],
        attachments: [],
        privacy: privacy(),
      },
    ],
    selectedAttemptId: 'attempt-checkout-1',
    startedAt: AT,
    endedAt: AT,
    durationMs: 240,
    privacy: privacy(),
  });
  const revision = await canonicalEvidenceHash(run);
  const baselineAssetHash = 'b'.repeat(64);
  const baseline = BaselineSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: 'baseline-checkout-1',
    projectId: run.projectId,
    kind: 'baseline',
    createdAt: AT,
    producer: { name: '@scenebook/playwright', version: '0.1.0', runtime: 'test' },
    sceneId: run.sceneId,
    runTargetId: run.runTargetId,
    sourceRunId: run.id,
    sourceRunRevision: revision,
    sourceAttemptId: run.selectedAttemptId,
    sourceRevision: run.sourceRevision,
    completeness: 'complete',
    sourceRunStatus: 'passed',
    expectedStepIds: run.expectedStepIds,
    states: [
      {
        sceneId: run.sceneId,
        stepId: 'confirm-order',
        phase: 'after',
        stateId: 'baseline-checkout-after',
        screenshot: {
          sha256: baselineAssetHash,
          path: `assets/${baselineAssetHash}.png`,
          mediaType: 'image/png',
          byteLength: PNG.byteLength,
          role: 'screenshot',
          width: 1,
          height: 1,
        },
        screenshotHash: baselineAssetHash,
        route: '/checkout/complete',
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false },
        privacy: privacy(),
      },
    ],
    checks: [],
    checksHash: 'c'.repeat(64),
    approvals: [
      {
        id: 'approval-checkout-1',
        kind: 'visual',
        decision: 'approved',
        actorId: 'reviewer-1',
        createdAt: AT,
        revision,
      },
    ],
  });
  const baselineRevision = await canonicalEvidenceHash(baseline);
  const review = ReviewSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: 'review-checkout-1',
    projectId: run.projectId,
    kind: 'review',
    createdAt: AT,
    producer: { name: '@scenebook/playwright', version: '0.1.0', runtime: 'test' },
    subject: { kind: 'run', id: run.id, revision },
    status: 'open',
    changeState: 'changed',
    changes: [
      {
        id: 'diff-checkout-visual',
        dimension: 'visual',
        severity: 'warning',
        kind: 'modified',
        sceneId: run.sceneId,
        stepId: 'confirm-order',
        stateId: 'state-checkout-after',
        summary: 'Receipt layout changed',
        metrics: { changedRatio: 0.04 },
      },
    ],
    comments: [],
    decisions: [],
    baseline: { kind: 'baseline', id: baseline.id, sha256: baselineRevision },
    assignedTo: [],
    openedAt: AT,
  });
  return { scene, portable, run, review, baseline, revision, rawHash, baselineAssetHash };
}

function jsonInput(name: string, value: unknown) {
  return {
    name,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
    mediaType: 'application/json',
  };
}

describe('Studio Run evidence importer', () => {
  it('binds exact Run/Review/source revisions and persists verified screenshots out of line', async () => {
    const { scene, run, review, revision, rawHash } = await fixture();
    const inspection = await inspectEvidenceInputs(
      [
        jsonInput(`runs/${run.id}.json`, run),
        jsonInput(`reviews/${review.id}.json`, review),
        { name: `assets/${rawHash}.png`, bytes: PNG, mediaType: 'image/png' },
      ],
      () => new Date('2026-07-21T05:01:00.000Z'),
    );

    expect(inspection.candidates).toHaveLength(1);
    expect(inspection.candidates[0]?.evidence).toMatchObject({
      runRevision: revision,
      verifiedAssetHashes: [rawHash],
      missingAssetHashes: [],
      review: { id: review.id },
    });
    const attached = await attachEvidenceToScene(scene, inspection.candidates[0]!);
    expect(attached.scene.verified).toEqual({
      status: 'changed',
      commit: run.repository.commit,
      environment: run.runTargetId,
      at: run.endedAt,
    });
    expect(attached.scene.runEvidenceAssets?.[rawHash]).toMatch(/^blob:/u);

    const compacted = await compactStoredSceneRecord({
      id: scene.id,
      scene: attached.scene,
      savedAt: 1,
      revision: 1,
    });
    expect(compacted.record.payloadRefs).toContainEqual(
      expect.objectContaining({ slot: 'run-evidence-asset', key: rawHash, sha256: rawHash }),
    );
    expect(JSON.stringify(compacted.record)).not.toContain('iVBOR');
    const hydrated = await hydrateStoredSceneRecord(compacted.record, async (reference) =>
      compacted.payloads.find(
        (payload) =>
          payload.sha256 === reference.sha256 && payload.mediaType === reference.mediaType,
      ),
    );
    expect(hydrated.scene.runEvidence?.[0]?.review?.changes[0]?.summary).toBe(
      'Receipt layout changed',
    );
    expect(hydrated.scene.runEvidenceAssets?.[rawHash]).toMatch(/^blob:/u);
    releaseLocalMediaUrls(attached.scene, hydrated);
  });

  it('rejects wrong Review revisions, tampered screenshots, and stale Scene source', async () => {
    const { scene, run, review, rawHash } = await fixture();
    const wrongReview = {
      ...review,
      subject: { ...review.subject, revision: 'f'.repeat(64) },
    } as Review;
    await expect(
      inspectEvidenceInputs([
        jsonInput(`runs/${run.id}.json`, run),
        jsonInput(`reviews/${review.id}.json`, wrongReview),
      ]),
    ).rejects.toMatchObject({ message: 'A Review targets the Run ID but not its exact revision.' });

    const tampered = new Uint8Array(PNG);
    tampered[tampered.length - 1] ^= 1;
    await expect(
      inspectEvidenceInputs([
        jsonInput(`runs/${run.id}.json`, run),
        { name: `assets/${rawHash}.png`, bytes: tampered, mediaType: 'image/png' },
      ]),
    ).rejects.toBeInstanceOf(EvidenceImportError);

    const inspection = await inspectEvidenceInputs([jsonInput(`runs/${run.id}.json`, run)]);
    scene.portableSource!.title = 'A newer checkout source';
    await expect(attachEvidenceToScene(scene, inspection.candidates[0]!)).rejects.toMatchObject({
      message: 'Run evidence was produced from a different Scene revision.',
    });
  });

  it('accepts a bounded generated evidence ZIP and reports missing local screenshots honestly', async () => {
    const { run } = await fixture();
    const zip = zipSync({
      '.scenebook/runs/runs/run.json': new TextEncoder().encode(JSON.stringify(run)),
    });
    const inspection = await inspectEvidenceInputs([{ name: 'evidence.zip', bytes: zip }]);
    expect(inspection.candidates[0]?.evidence.missingAssetHashes).toHaveLength(1);
    expect(inspection.warnings.join(' ')).toMatch(/metadata-complete/iu);
    expect(inspection.warnings.join(' ')).toMatch(/no exact Review/iu);
  });

  it('aborts a multi-Scene attachment without a partial commit', async () => {
    const { scene, run, review } = await fixture();
    const inspection = await inspectEvidenceInputs([
      jsonInput(`runs/${run.id}.json`, run),
      jsonInput(`reviews/${review.id}.json`, review),
    ]);
    const storage = new MemorySceneStorage();
    const library = new SceneLibrary(storage, new MemoryRecoveryJournal());
    await library.importScenes([scene], 'replace');

    await expect(
      library.importRunEvidence([
        inspection.candidates[0]!,
        { ...inspection.candidates[0]!, sceneId: 'missing-scene' },
      ]),
    ).rejects.toThrow(/not in this workspace/iu);
    expect((await storage.get(scene.id))?.scene.runEvidence).toBeUndefined();
  });

  it('preserves verified local screenshots and exact Review data on metadata-only reimport', async () => {
    const { scene, run, review, baseline, rawHash, baselineAssetHash } = await fixture();
    const complete = await inspectEvidenceInputs([
      jsonInput(`runs/${run.id}.json`, run),
      jsonInput(`reviews/${review.id}.json`, review),
      jsonInput(`baselines/${baseline.id}.json`, baseline),
      { name: `assets/${rawHash}.png`, bytes: PNG },
    ]);
    const first = await attachEvidenceToScene(scene, complete.candidates[0]!);
    const metadataOnly = await inspectEvidenceInputs([jsonInput(`runs/${run.id}.json`, run)]);
    const second = await attachEvidenceToScene(first.scene, metadataOnly.candidates[0]!);

    expect(second.replacedRevision).toBe(true);
    expect(second.scene.runEvidence?.[0]).toMatchObject({
      review: { id: review.id },
      baseline: { id: baseline.id },
      verifiedAssetHashes: [rawHash],
      missingAssetHashes: [baselineAssetHash],
    });
    expect(second.scene.runEvidenceAssets?.[rawHash]).toBe(
      first.scene.runEvidenceAssets?.[rawHash],
    );
    releaseLocalMediaUrls(first.scene, second.scene);
  });

  it('enforces declared and combined expanded limits before reading file bodies', async () => {
    expect(() => assertEvidenceExpandedBudget([260 * 1024 * 1024, 260 * 1024 * 1024])).toThrow(
      /combined evidence selection/iu,
    );

    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const oversized = {
      name: 'oversized.zip',
      type: 'application/zip',
      size: 151 * 1024 * 1024,
      arrayBuffer,
    } as unknown as File;
    await expect(inspectEvidenceFiles([oversized])).rejects.toThrow(/150 MB input limit/iu);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
