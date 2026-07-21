import { describe, expect, it } from 'vitest';

import { BaselineSchema, RunArtifactSchema, type PrivacySummary } from '@scenebook/schema';

import {
  classifySceneDiff,
  compareRects,
  compareRgbaImages,
  hammingDistanceHex,
  snapshotFromBaseline,
  snapshotFromRun,
  type SceneEvidenceSnapshot,
} from '../src/index.js';

const NOW = '2026-07-20T12:00:00.000Z';

function privacy(status: PrivacySummary['status'] = 'clear'): PrivacySummary {
  return {
    status,
    scannedAt: NOW,
    scannerVersion: '1.0.0',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  };
}

function snapshot(): SceneEvidenceSnapshot {
  return {
    sceneId: 'invite-member',
    functional: {
      status: 'passed',
      checks: [{ id: 'toast-visible', stepId: 'send-invite', status: 'passed' }],
    },
    states: [
      {
        id: 'send-before',
        stepId: 'send-invite',
        phase: 'before',
        visual: {
          contentHash: 'a'.repeat(64),
          perceptualHash: '0000000000000000',
          width: 2,
          height: 1,
          rgba: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]),
        },
        semantic: {
          visibleText: ['Send invitation'],
          nodes: [{ role: 'button', name: 'Send invitation', states: {} }],
          language: 'en',
        },
        geometry: {
          rect: { x: 0.7, y: 0.2, width: 0.2, height: 0.1 },
          visible: true,
          occluded: false,
        },
        privacy: privacy(),
      },
    ],
    narrativeRevision: 'c'.repeat(64),
    narrative: [
      {
        stepId: 'send-invite',
        title: 'Send the invitation',
        instruction: 'Choose Send invitation.',
      },
    ],
    privacy: privacy(),
  };
}

describe('pixel and geometry metrics', () => {
  it('computes normalized RGBA changes and perceptual Hamming distance', () => {
    const left = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255]);
    const right = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]);
    const metrics = compareRgbaImages(left, right, 2, 1, 0.1);
    expect(metrics.changedPixels).toBe(1);
    expect(metrics.changedRatio).toBe(0.5);
    expect(metrics.maximumDelta).toBeGreaterThan(0.8);
    expect(hammingDistanceHex('000f', '0000')).toBe(4);
  });

  it('measures target movement independently from resizing', () => {
    const delta = compareRects(
      { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      { x: 0.2, y: 0.1, width: 0.3, height: 0.2 },
    );
    expect(delta.centerDistance).toBeGreaterThan(0.1);
    expect(delta.widthDelta).toBeCloseTo(0.1);
    expect(delta.heightDelta).toBe(0);
  });
});

describe('artifact snapshot adapters', () => {
  const screenshotHash = 'a'.repeat(64);
  const screenshot = {
    sha256: screenshotHash,
    path: `assets/${screenshotHash}.webp`,
    mediaType: 'image/webp',
    byteLength: 10,
    role: 'screenshot' as const,
    width: 100,
    height: 100,
  };
  const evidence = {
    id: 'send-before',
    sceneId: 'invite-member',
    stepId: 'send-invite',
    phase: 'before' as const,
    capturedAt: NOW,
    route: '/settings/members',
    viewport: { width: 100, height: 100 },
    screenshot,
    screenshotHash,
    target: {
      role: 'button',
      accessibleName: 'Send invitation',
      normalizedRect: { x: 0.7, y: 0.2, width: 0.2, height: 0.1 },
    },
    privacy: privacy(),
  };

  it('preserves approved Check and State evidence from a complete Baseline', () => {
    const baseline = BaselineSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'baseline-1',
      kind: 'baseline',
      projectId: 'acme',
      sceneId: 'invite-member',
      runTargetId: 'primary',
      createdAt: NOW,
      producer: { name: 'scenebook', version: '0.1.0' },
      sourceRunId: 'run-1',
      sourceAttemptId: 'attempt-1',
      sourceRevision: 'b'.repeat(64),
      narrativeRevision: 'c'.repeat(64),
      completeness: 'complete',
      sourceRunStatus: 'passed',
      expectedStepIds: ['send-invite'],
      states: [
        {
          sceneId: evidence.sceneId,
          stepId: evidence.stepId,
          phase: evidence.phase,
          stateId: evidence.id,
          screenshot,
          screenshotHash,
          route: evidence.route,
          viewport: evidence.viewport,
          target: evidence.target,
          privacy: evidence.privacy,
        },
      ],
      checks: [
        {
          checkId: 'toast-visible',
          stepId: 'send-invite',
          status: 'passed',
        },
      ],
      checksHash: 'd'.repeat(64),
      approvals: [
        {
          id: 'approval-1',
          kind: 'visual',
          decision: 'approved',
          actorId: 'reviewer-1',
          createdAt: NOW,
          revision: 'b'.repeat(64),
        },
      ],
    });
    const converted = snapshotFromBaseline(baseline);
    expect(converted.functional.checks).toEqual([
      { id: 'toast-visible', stepId: 'send-invite', status: 'passed', message: undefined },
    ]);
    expect(converted.states[0]).toMatchObject({
      id: 'send-before',
      geometry: { visible: true, occluded: false },
    });
  });

  it('selects exactly one Run attempt and carries its privacy status', () => {
    const run = RunArtifactSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'run-1',
      kind: 'run',
      projectId: 'acme',
      sceneId: 'invite-member',
      runTargetId: 'primary',
      createdAt: NOW,
      producer: { name: 'scenebook', version: '0.1.0' },
      repository: { repository: 'acme/product', commit: 'e'.repeat(40) },
      sourceRevision: 'b'.repeat(64),
      status: 'passed',
      expectedStepIds: ['send-invite'],
      attempts: [
        {
          id: 'attempt-1',
          index: 0,
          status: 'passed',
          startedAt: NOW,
          endedAt: NOW,
          durationMs: 1,
          states: [evidence],
          checks: [{ checkId: 'toast-visible', stepId: 'send-invite', status: 'passed' }],
          privacy: privacy(),
        },
      ],
      selectedAttemptId: 'attempt-1',
      startedAt: NOW,
      endedAt: NOW,
      durationMs: 1,
      privacy: privacy(),
    });
    const converted = snapshotFromRun(run);
    expect(converted.functional.status).toBe('passed');
    expect(converted.states).toHaveLength(1);
    expect(converted.privacy.status).toBe('clear');
  });
});

describe('whole-journey classification', () => {
  it('classifies identical evidence as Passed', () => {
    const before = snapshot();
    const after = snapshot();
    expect(classifySceneDiff(before, after)).toEqual({
      state: 'passed',
      changes: [],
      dimensions: { functional: 0, visual: 0, semantic: 0, geometry: 0, narrative: 0, privacy: 0 },
    });
  });

  it('reports visual, semantic, geometry, and narrative changes independently', () => {
    const before = snapshot();
    const baseState = before.states[0]!;
    const after: SceneEvidenceSnapshot = {
      ...snapshot(),
      narrativeRevision: 'd'.repeat(64),
      narrative: [
        {
          stepId: 'send-invite',
          title: 'Invite your teammate',
          instruction: 'Select Send now.',
        },
      ],
      states: [
        {
          ...baseState,
          id: 'send-candidate-before',
          visual: {
            ...baseState.visual,
            contentHash: 'b'.repeat(64),
            rgba: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]),
          },
          semantic: {
            visibleText: ['Send now'],
            nodes: [{ role: 'button', name: 'Send now', states: {} }],
            language: 'en',
          },
          geometry: {
            rect: { x: 0.4, y: 0.2, width: 0.25, height: 0.1 },
            visible: true,
            occluded: false,
          },
        },
      ],
    };

    const result = classifySceneDiff(before, after);
    expect(result.state).toBe('changed');
    expect(result.dimensions).toMatchObject({ visual: 1, semantic: 1, geometry: 1, narrative: 1 });
    expect(result.changes.map((item) => item.dimension)).toEqual(
      expect.arrayContaining(['visual', 'semantic', 'geometry', 'narrative']),
    );
  });

  it('makes functional failure Broken even when visual evidence also changes', () => {
    const before = snapshot();
    const after: SceneEvidenceSnapshot = {
      ...snapshot(),
      functional: {
        status: 'failed',
        checks: [
          {
            id: 'toast-visible',
            stepId: 'send-invite',
            status: 'failed',
            message: 'Toast missing',
          },
        ],
      },
      states: [
        {
          ...snapshot().states[0]!,
          visual: { ...snapshot().states[0]!.visual, contentHash: 'b'.repeat(64) },
        },
      ],
    };
    const result = classifySceneDiff(before, after);
    expect(result.state).toBe('broken');
    expect(result.dimensions.functional).toBeGreaterThan(0);
  });

  it('makes unknown or newly blocked privacy status Blocked above all other dimensions', () => {
    const before = snapshot();
    const unknown = { ...snapshot(), privacy: privacy('unknown') };
    expect(classifySceneDiff(before, unknown).state).toBe('blocked');

    const blockedFinding = {
      id: 'privacy-token',
      category: 'token' as const,
      severity: 'blocking' as const,
      confidence: 0.99,
      source: 'ocr' as const,
      path: '$assets/a/ocr/0',
      fingerprint: 'f'.repeat(64),
      ruleId: 'jwt-token',
      message: 'Token detected',
      disposition: 'open' as const,
    };
    const blocked: SceneEvidenceSnapshot = {
      ...snapshot(),
      privacy: {
        ...privacy('blocked'),
        counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 1 },
        findings: [blockedFinding],
      },
    };
    const result = classifySceneDiff(before, blocked);
    expect(result.state).toBe('blocked');
    expect(result.dimensions.privacy).toBeGreaterThan(0);
    expect(JSON.stringify(result.changes)).not.toContain('eyJ');
  });
});
