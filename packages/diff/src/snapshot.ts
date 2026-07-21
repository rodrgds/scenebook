import type { Baseline, PrivacySummary, RunArtifact } from '@scenebook/schema';

import type { EvidenceStateSnapshot, SceneEvidenceSnapshot } from './types.js';
import { geometryFromTarget } from './types.js';

function aggregatePrivacy(
  summaries: readonly PrivacySummary[],
  fallback: PrivacySummary,
): PrivacySummary {
  const rank = { clear: 0, warning: 1, unknown: 2, blocked: 3, quarantined: 4 } as const;
  const mostSevere = [fallback, ...summaries].reduce((current, candidate) =>
    rank[candidate.status] > rank[current.status] ? candidate : current,
  );
  const findings = [fallback, ...summaries].flatMap((summary) => summary.findings);
  return {
    ...mostSevere,
    counts: {
      info: findings.filter((finding) => finding.severity === 'info').length,
      low: findings.filter((finding) => finding.severity === 'low').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      high: findings.filter((finding) => finding.severity === 'high').length,
      blocking: findings.filter((finding) => finding.severity === 'blocking').length,
    },
    findings,
  };
}

export function snapshotFromBaseline(baseline: Baseline): SceneEvidenceSnapshot {
  const states: EvidenceStateSnapshot[] = baseline.states.map((state) => ({
    id: state.stateId,
    stepId: state.stepId,
    phase: state.phase,
    visual: {
      contentHash: state.screenshotHash,
      perceptualHash: state.perceptualHash,
      width: state.screenshot.width ?? state.viewport.width,
      height: state.screenshot.height ?? state.viewport.height,
    },
    semantic: state.semantic,
    geometry: geometryFromTarget(state.target),
    privacy: state.privacy,
  }));
  const fallback = baseline.states[0]?.privacy;
  if (!fallback) throw new TypeError('A complete Baseline requires State evidence');
  return {
    sceneId: baseline.sceneId,
    functional: {
      status: 'passed',
      checks: baseline.checks.map((check) => ({
        id: check.checkId,
        stepId: check.stepId,
        status: check.status,
        message: check.message,
      })),
    },
    states,
    narrativeRevision: baseline.narrativeRevision,
    narrative: baseline.expectedStepIds.map((stepId) => ({
      stepId,
      hash: baseline.states.find((state) => state.stepId === stepId)?.narrativeHash,
    })),
    privacy: aggregatePrivacy(
      baseline.states.map((state) => state.privacy),
      fallback,
    ),
  };
}

export function snapshotFromRun(run: RunArtifact): SceneEvidenceSnapshot {
  const attempt = run.attempts.find((candidate) => candidate.id === run.selectedAttemptId);
  if (!attempt) throw new TypeError(`Selected attempt ${run.selectedAttemptId} is missing`);
  return {
    sceneId: run.sceneId,
    functional: {
      status: run.status,
      checks: attempt.checks.map((check) => ({
        id: check.checkId,
        stepId: check.stepId,
        status: check.status,
        message: check.message,
      })),
    },
    states: attempt.states.map((state) => ({
      id: state.id,
      stepId: state.stepId,
      phase: state.phase,
      visual: {
        contentHash: state.screenshotHash,
        perceptualHash: state.perceptualHash,
        width: state.screenshot.width ?? state.viewport.width,
        height: state.screenshot.height ?? state.viewport.height,
      },
      semantic: state.semantic,
      geometry: geometryFromTarget(state.target),
      privacy: state.privacy,
    })),
    narrativeRevision: run.narrativeRevision,
    narrative: run.expectedStepIds.map((stepId) => ({ stepId })),
    privacy: aggregatePrivacy(
      attempt.states.map((state) => state.privacy),
      run.privacy,
    ),
  };
}
