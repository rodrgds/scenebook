import { describe, expect, it } from 'vitest';
import { applyPolicyOverride, evaluateChannelPolicy, type SceneReadiness } from '../src/index.js';

const strictPolicy = {
  requireCriticalPassing: true,
  requireVisualApproval: true,
  requireEditorialApproval: true,
  requireCompleteLocalization: false,
  publication: 'manual' as const,
  nonCriticalFailure: 'carry-forward' as const,
};

function scene(overrides: Partial<SceneReadiness> = {}): SceneReadiness {
  return {
    sceneId: 'invite-member',
    criticality: 'important',
    status: 'passed',
    visualApproved: true,
    editorialApproved: true,
    localizationComplete: true,
    candidateRevision: 'run-123',
    previousReleaseRevision: 'run-122',
    ...overrides,
  };
}

describe('Channel policy', () => {
  it('includes an approved candidate', () => {
    const decision = evaluateChannelPolicy(strictPolicy, [scene()]);
    expect(decision.allowed).toBe(true);
    expect(decision.scenes[0]).toMatchObject({ action: 'include-candidate', revision: 'run-123' });
  });

  it('carries forward a noncritical failure without constructing mixed evidence', () => {
    const decision = evaluateChannelPolicy(strictPolicy, [scene({ status: 'broken' })]);
    expect(decision.allowed).toBe(true);
    expect(decision.scenes[0]).toMatchObject({ action: 'carry-forward', revision: 'run-122' });
  });

  it('blocks a critical failure even when noncritical policy permits carry-forward', () => {
    const decision = evaluateChannelPolicy(strictPolicy, [
      scene({ criticality: 'critical', status: 'broken' }),
    ]);
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.map((candidate) => candidate.code)).toContain('critical-not-passing');
  });

  it('never allows an ordinary policy override to bypass privacy quarantine', () => {
    const decision = evaluateChannelPolicy(strictPolicy, [scene({ status: 'blocked' })]);
    expect(() =>
      applyPolicyOverride(decision, {
        actorId: 'reviewer-1',
        reason: 'The test environment contains approved synthetic data.',
        approvedAt: '2026-07-20T12:00:00.000Z',
        reasonCodes: ['privacy-blocked'],
      }),
    ).toThrow(/cannot bypass a privacy quarantine/i);
  });
});
