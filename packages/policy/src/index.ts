import type { ChannelPolicy } from '@scenebook/schema';

export type HealthStatus = 'passed' | 'changed' | 'broken' | 'blocked' | 'unverified';
export type PublicationAction = 'include-candidate' | 'carry-forward' | 'exclude' | 'block';

export interface SceneReadiness {
  readonly sceneId: string;
  readonly criticality: 'low' | 'normal' | 'important' | 'critical';
  readonly status: HealthStatus;
  readonly visualApproved: boolean;
  readonly editorialApproved: boolean;
  readonly localizationComplete: boolean;
  readonly candidateRevision?: string;
  readonly previousReleaseRevision?: string;
}

export interface PolicyReason {
  readonly code:
    | 'critical-not-passing'
    | 'privacy-blocked'
    | 'functional-failure'
    | 'unverified'
    | 'visual-approval-required'
    | 'editorial-approval-required'
    | 'localization-incomplete'
    | 'candidate-missing'
    | 'carry-forward-missing';
  readonly message: string;
  readonly blocking: boolean;
}

export interface ScenePublicationDecision {
  readonly sceneId: string;
  readonly action: PublicationAction;
  readonly revision?: string;
  readonly reasons: readonly PolicyReason[];
}

export interface PublicationDecision {
  readonly allowed: boolean;
  readonly scenes: readonly ScenePublicationDecision[];
  readonly blockers: readonly PolicyReason[];
  readonly evaluatedAt?: string;
}

function reason(code: PolicyReason['code'], message: string, blocking = true): PolicyReason {
  return { code, message, blocking };
}

function failureReason(scene: SceneReadiness): PolicyReason | undefined {
  if (scene.status === 'blocked') {
    return reason('privacy-blocked', `${scene.sceneId} is quarantined by the privacy gate.`);
  }
  if (scene.status === 'broken') {
    return reason('functional-failure', `${scene.sceneId} did not complete its executable checks.`);
  }
  if (scene.status === 'unverified') {
    return reason('unverified', `${scene.sceneId} has no successful candidate Run.`);
  }
  return undefined;
}

export function evaluateChannelPolicy(
  policy: ChannelPolicy,
  readiness: readonly SceneReadiness[],
): PublicationDecision {
  const decisions: ScenePublicationDecision[] = [];

  for (const scene of readiness) {
    let reasons: PolicyReason[] = [];
    const failed = failureReason(scene);
    const critical = scene.criticality === 'critical';

    if (failed) reasons.push(failed);
    if (
      critical &&
      policy.requireCriticalPassing &&
      scene.status !== 'passed' &&
      scene.status !== 'changed'
    ) {
      reasons.push(
        reason(
          'critical-not-passing',
          `Critical Scene ${scene.sceneId} must pass before publication.`,
        ),
      );
    }
    if (
      policy.requireVisualApproval &&
      (scene.status === 'changed' || scene.status === 'passed') &&
      !scene.visualApproved
    ) {
      reasons.push(
        reason('visual-approval-required', `${scene.sceneId} is waiting for visual approval.`),
      );
    }
    if (policy.requireEditorialApproval && !scene.editorialApproved) {
      reasons.push(
        reason(
          'editorial-approval-required',
          `${scene.sceneId} is waiting for editorial approval.`,
        ),
      );
    }
    if (policy.requireCompleteLocalization && !scene.localizationComplete) {
      reasons.push(
        reason(
          'localization-incomplete',
          `${scene.sceneId} is missing required localized narrative.`,
        ),
      );
    }

    const hardBlock = critical && reasons.some((candidate) => candidate.blocking);
    const hasFailure =
      scene.status === 'blocked' || scene.status === 'broken' || scene.status === 'unverified';
    let action: PublicationAction = 'include-candidate';
    let revision = scene.candidateRevision;

    if (hardBlock || (!critical && hasFailure && policy.nonCriticalFailure === 'block')) {
      action = 'block';
      revision = undefined;
    } else if (!critical && hasFailure && policy.nonCriticalFailure === 'carry-forward') {
      if (scene.previousReleaseRevision) {
        action = 'carry-forward';
        revision = scene.previousReleaseRevision;
        reasons = reasons.map((candidate) => ({ ...candidate, blocking: false }));
      } else {
        action = 'block';
        revision = undefined;
        reasons.push(
          reason(
            'carry-forward-missing',
            `${scene.sceneId} has no prior approved Release to carry forward.`,
          ),
        );
      }
    } else if (!critical && hasFailure && policy.nonCriticalFailure === 'exclude') {
      action = 'exclude';
      revision = undefined;
      reasons = reasons.map((candidate) => ({ ...candidate, blocking: false }));
    } else if (reasons.some((candidate) => candidate.blocking)) {
      action = 'block';
      revision = undefined;
    } else if (!scene.candidateRevision) {
      action = 'block';
      revision = undefined;
      reasons.push(
        reason('candidate-missing', `${scene.sceneId} has no immutable candidate revision.`),
      );
    }

    decisions.push({ sceneId: scene.sceneId, action, ...(revision ? { revision } : {}), reasons });
  }

  const blockers = decisions.flatMap((decision) =>
    decision.reasons.filter((candidate) => candidate.blocking),
  );
  return {
    allowed: blockers.length === 0 && decisions.every((decision) => decision.action !== 'block'),
    scenes: decisions,
    blockers,
  };
}

export interface PolicyOverride {
  readonly actorId: string;
  readonly reason: string;
  readonly approvedAt: string;
  readonly reasonCodes: readonly PolicyReason['code'][];
}

export function applyPolicyOverride(
  decision: PublicationDecision,
  override: PolicyOverride,
): PublicationDecision & { readonly override: PolicyOverride } {
  if (!override.actorId.trim() || override.reason.trim().length < 10) {
    throw new Error('A policy override requires an attributed actor and a meaningful reason.');
  }
  if (override.reasonCodes.includes('privacy-blocked')) {
    throw new Error(
      'A Channel policy override cannot bypass a privacy quarantine. Resolve or explicitly review the finding.',
    );
  }
  const allowedCodes = new Set(override.reasonCodes);
  const scenes = decision.scenes.map((scene) => {
    const reasons = scene.reasons.map((candidate) =>
      allowedCodes.has(candidate.code) ? { ...candidate, blocking: false } : candidate,
    );
    const remainsBlocked = reasons.some((candidate) => candidate.blocking);
    return remainsBlocked || scene.action !== 'block' || !scene.revision
      ? { ...scene, reasons }
      : { ...scene, action: 'include-candidate' as const, reasons };
  });
  const blockers = scenes.flatMap((scene) =>
    scene.reasons.filter((candidate) => candidate.blocking),
  );
  return {
    ...decision,
    allowed: blockers.length === 0 && scenes.every((scene) => scene.action !== 'block'),
    scenes,
    blockers,
    override,
  };
}
