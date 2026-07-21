import { createDeterministicId, stableStringify } from '@scenebook/core';
import type {
  Baseline,
  JsonValue,
  NormalizedRect,
  ReviewChange,
  RunArtifact,
  SemanticProjection,
} from '@scenebook/schema';

import { compareRgbaImages, hammingDistanceHex } from './pixel.js';
import type {
  DiffOptions,
  EvidenceStateSnapshot,
  NarrativeStepSnapshot,
  RectDelta,
  SceneDiffResult,
  SceneEvidenceSnapshot,
} from './types.js';
import { snapshotFromBaseline, snapshotFromRun } from './snapshot.js';

const DEFAULTS: Required<DiffOptions> = {
  pixelThreshold: 0.1,
  changedPixelRatio: 0.005,
  perceptualDistance: 4,
  geometryDistance: 0.01,
  narrativeSimilarity: 0.98,
};

function optionsWithDefaults(options: DiffOptions): Required<DiffOptions> {
  return { ...DEFAULTS, ...options };
}

function change(
  sceneId: string,
  dimension: ReviewChange['dimension'],
  kind: ReviewChange['kind'],
  severity: ReviewChange['severity'],
  summary: string,
  context: {
    readonly stepId?: string;
    readonly stateId?: string;
    readonly before?: JsonValue;
    readonly after?: JsonValue;
    readonly metrics?: Readonly<Record<string, number>>;
  } = {},
): ReviewChange {
  const fingerprint = `${sceneId}\u0000${dimension}\u0000${kind}\u0000${context.stepId ?? ''}\u0000${context.stateId ?? ''}\u0000${summary}`;
  return {
    id: createDeterministicId('diff', fingerprint, 20),
    sceneId,
    dimension,
    kind,
    severity,
    summary,
    ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
    ...(context.stateId === undefined ? {} : { stateId: context.stateId }),
    ...(context.before === undefined ? {} : { before: context.before }),
    ...(context.after === undefined ? {} : { after: context.after }),
    metrics: { ...(context.metrics ?? {}) },
  };
}

function stateKey(state: EvidenceStateSnapshot): string {
  return `${state.stepId}\u0000${state.phase}`;
}

function mapStates(states: readonly EvidenceStateSnapshot[]): Map<string, EvidenceStateSnapshot> {
  const mapped = new Map<string, EvidenceStateSnapshot>();
  for (const state of states) {
    const key = stateKey(state);
    if (mapped.has(key))
      throw new TypeError(`Duplicate evidence State for ${state.stepId}/${state.phase}`);
    mapped.set(key, state);
  }
  return mapped;
}

function functionalChanges(
  baseline: SceneEvidenceSnapshot,
  candidate: SceneEvidenceSnapshot,
): ReviewChange[] {
  const changes: ReviewChange[] = [];
  if (candidate.functional.status === 'failed' || candidate.functional.status === 'cancelled') {
    changes.push(
      change(
        candidate.sceneId,
        'functional',
        'failed',
        'error',
        `Scene execution ${candidate.functional.status}`,
        {
          before: baseline.functional.status,
          after: candidate.functional.status,
        },
      ),
    );
  } else if (baseline.functional.status !== candidate.functional.status) {
    changes.push(
      change(
        candidate.sceneId,
        'functional',
        candidate.functional.status === 'passed' ? 'resolved' : 'modified',
        'warning',
        'Scene execution status changed',
        {
          before: baseline.functional.status,
          after: candidate.functional.status,
        },
      ),
    );
  }
  const beforeChecks = new Map(baseline.functional.checks.map((check) => [check.id, check]));
  const afterChecks = new Map(candidate.functional.checks.map((check) => [check.id, check]));
  for (const id of new Set([...beforeChecks.keys(), ...afterChecks.keys()])) {
    const before = beforeChecks.get(id);
    const after = afterChecks.get(id);
    if (!after && before) {
      changes.push(
        change(candidate.sceneId, 'functional', 'removed', 'warning', `Check removed: ${id}`, {
          stepId: before.stepId,
        }),
      );
    } else if (after && !before) {
      changes.push(
        change(
          candidate.sceneId,
          'functional',
          'added',
          after.status === 'failed' ? 'error' : 'info',
          `Check added: ${id}`,
          {
            stepId: after.stepId,
            after: after.status,
          },
        ),
      );
    } else if (before && after && before.status !== after.status) {
      changes.push(
        change(
          candidate.sceneId,
          'functional',
          after.status === 'failed'
            ? 'failed'
            : after.status === 'passed'
              ? 'resolved'
              : 'modified',
          after.status === 'failed' ? 'error' : 'warning',
          `Check ${id} changed from ${before.status} to ${after.status}`,
          { stepId: after.stepId, before: before.status, after: after.status },
        ),
      );
    }
  }
  return changes;
}

function visualChanges(
  baseline: SceneEvidenceSnapshot,
  candidate: SceneEvidenceSnapshot,
  options: Required<DiffOptions>,
): ReviewChange[] {
  const changes: ReviewChange[] = [];
  const beforeStates = mapStates(baseline.states);
  const afterStates = mapStates(candidate.states);
  for (const key of new Set([...beforeStates.keys(), ...afterStates.keys()])) {
    const before = beforeStates.get(key);
    const after = afterStates.get(key);
    const common = after ?? before;
    if (!common) continue;
    if (!before) {
      changes.push(
        change(
          candidate.sceneId,
          'visual',
          'added',
          'warning',
          `Visual State added (${common.phase})`,
          { stepId: common.stepId, stateId: common.id },
        ),
      );
      continue;
    }
    if (!after) {
      changes.push(
        change(
          candidate.sceneId,
          'visual',
          'removed',
          'error',
          `Visual State removed (${common.phase})`,
          { stepId: common.stepId, stateId: common.id },
        ),
      );
      continue;
    }
    if (before.visual.contentHash === after.visual.contentHash) continue;
    if (
      before.visual.width !== after.visual.width ||
      before.visual.height !== after.visual.height
    ) {
      changes.push(
        change(
          candidate.sceneId,
          'visual',
          'modified',
          'warning',
          'Screenshot dimensions changed',
          {
            stepId: after.stepId,
            stateId: after.id,
            before: { width: before.visual.width, height: before.visual.height },
            after: { width: after.visual.width, height: after.visual.height },
          },
        ),
      );
      continue;
    }
    if (before.visual.rgba && after.visual.rgba) {
      const metrics = compareRgbaImages(
        before.visual.rgba,
        after.visual.rgba,
        after.visual.width,
        after.visual.height,
        options.pixelThreshold,
      );
      if (metrics.changedRatio > options.changedPixelRatio) {
        changes.push(
          change(
            candidate.sceneId,
            'visual',
            'modified',
            'warning',
            'Screenshot changed visually',
            {
              stepId: after.stepId,
              stateId: after.id,
              metrics: { ...metrics },
            },
          ),
        );
      }
      continue;
    }
    if (before.visual.perceptualHash && after.visual.perceptualHash) {
      const distance = hammingDistanceHex(
        before.visual.perceptualHash,
        after.visual.perceptualHash,
      );
      if (distance <= options.perceptualDistance) continue;
      changes.push(
        change(
          candidate.sceneId,
          'visual',
          'modified',
          'warning',
          'Screenshot changed perceptually',
          {
            stepId: after.stepId,
            stateId: after.id,
            metrics: { perceptualDistance: distance },
          },
        ),
      );
      continue;
    }
    changes.push(
      change(
        candidate.sceneId,
        'visual',
        'modified',
        'warning',
        'Screenshot content hash changed',
        {
          stepId: after.stepId,
          stateId: after.id,
        },
      ),
    );
  }
  return changes;
}

function semanticSignature(value: SemanticProjection): string {
  return stableStringify({
    visibleText: value.visibleText.map((text) => text.replace(/\s+/gu, ' ').trim()),
    nodes: value.nodes.map((node) => ({
      role: node.role,
      name: node.name.replace(/\s+/gu, ' ').trim(),
      states: node.states,
      ...(node.value === undefined ? {} : { value: node.value }),
      ...(node.level === undefined ? {} : { level: node.level }),
    })),
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.language === undefined ? {} : { language: value.language }),
  });
}

function semanticChanges(
  baseline: SceneEvidenceSnapshot,
  candidate: SceneEvidenceSnapshot,
): ReviewChange[] {
  const changes: ReviewChange[] = [];
  const beforeStates = mapStates(baseline.states);
  const afterStates = mapStates(candidate.states);
  for (const key of new Set([...beforeStates.keys(), ...afterStates.keys()])) {
    const before = beforeStates.get(key);
    const after = afterStates.get(key);
    const common = after ?? before;
    if (!common || (!before?.semantic && !after?.semantic)) continue;
    if (!before?.semantic && after?.semantic) {
      changes.push(
        change(candidate.sceneId, 'semantic', 'added', 'info', 'Semantic evidence added', {
          stepId: after.stepId,
          stateId: after.id,
        }),
      );
    } else if (before?.semantic && !after?.semantic) {
      changes.push(
        change(candidate.sceneId, 'semantic', 'removed', 'warning', 'Semantic evidence removed', {
          stepId: common.stepId,
          stateId: common.id,
        }),
      );
    } else if (
      before?.semantic &&
      after?.semantic &&
      semanticSignature(before.semantic) !== semanticSignature(after.semantic)
    ) {
      const beforeText = new Set(before.semantic.visibleText);
      const afterText = new Set(after.semantic.visibleText);
      const addedText = [...afterText].filter((text) => !beforeText.has(text)).length;
      const removedText = [...beforeText].filter((text) => !afterText.has(text)).length;
      changes.push(
        change(
          candidate.sceneId,
          'semantic',
          'modified',
          'warning',
          'Visible text or accessibility structure changed',
          {
            stepId: after.stepId,
            stateId: after.id,
            metrics: {
              addedText,
              removedText,
              beforeNodes: before.semantic.nodes.length,
              afterNodes: after.semantic.nodes.length,
            },
          },
        ),
      );
    }
  }
  return changes;
}

export function compareRects(before: NormalizedRect, after: NormalizedRect): RectDelta {
  const beforeCenterX = before.x + before.width / 2;
  const beforeCenterY = before.y + before.height / 2;
  const afterCenterX = after.x + after.width / 2;
  const afterCenterY = after.y + after.height / 2;
  const beforeArea = before.width * before.height;
  const afterArea = after.width * after.height;
  return {
    centerDistance: Math.hypot(afterCenterX - beforeCenterX, afterCenterY - beforeCenterY),
    widthDelta: Math.abs(after.width - before.width),
    heightDelta: Math.abs(after.height - before.height),
    areaRatio: beforeArea === 0 ? Number.POSITIVE_INFINITY : afterArea / beforeArea,
  };
}

function geometryChanges(
  baseline: SceneEvidenceSnapshot,
  candidate: SceneEvidenceSnapshot,
  options: Required<DiffOptions>,
): ReviewChange[] {
  const changes: ReviewChange[] = [];
  const beforeStates = mapStates(baseline.states);
  const afterStates = mapStates(candidate.states);
  for (const key of new Set([...beforeStates.keys(), ...afterStates.keys()])) {
    const before = beforeStates.get(key);
    const after = afterStates.get(key);
    const common = after ?? before;
    if (!common || (!before?.geometry && !after?.geometry)) continue;
    if (!before?.geometry && after?.geometry) {
      changes.push(
        change(candidate.sceneId, 'geometry', 'added', 'info', 'Primary target geometry added', {
          stepId: after.stepId,
          stateId: after.id,
        }),
      );
      continue;
    }
    if (before?.geometry && !after?.geometry) {
      changes.push(
        change(candidate.sceneId, 'geometry', 'removed', 'error', 'Primary target disappeared', {
          stepId: common.stepId,
          stateId: common.id,
        }),
      );
      continue;
    }
    if (!before?.geometry || !after?.geometry || !after) continue;
    if (before.geometry.visible && !after.geometry.visible) {
      changes.push(
        change(
          candidate.sceneId,
          'geometry',
          'failed',
          'error',
          'Primary target is no longer visible',
          { stepId: after.stepId, stateId: after.id },
        ),
      );
    }
    if (!before.geometry.occluded && after.geometry.occluded) {
      changes.push(
        change(candidate.sceneId, 'geometry', 'failed', 'error', 'Primary target became occluded', {
          stepId: after.stepId,
          stateId: after.id,
        }),
      );
    }
    if (before.geometry.rect && after.geometry.rect) {
      const delta = compareRects(before.geometry.rect, after.geometry.rect);
      if (
        delta.centerDistance > options.geometryDistance ||
        delta.widthDelta > options.geometryDistance ||
        delta.heightDelta > options.geometryDistance
      ) {
        changes.push(
          change(
            candidate.sceneId,
            'geometry',
            'modified',
            'warning',
            'Primary target moved or resized',
            {
              stepId: after.stepId,
              stateId: after.id,
              metrics: { ...delta },
            },
          ),
        );
      }
    }
  }
  return changes;
}

function normalizeNarrative(value: NarrativeStepSnapshot): string {
  return [value.title, value.instruction, value.caption, value.altText]
    .filter((part): part is string => part !== undefined)
    .join('\n')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function levenshteinSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  if (left.length * right.length > 2_000_000) {
    const lengthSimilarity =
      Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return Math.min(lengthSimilarity, 0.97);
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return (
    1 -
    (previous[right.length] ?? Math.max(left.length, right.length)) /
      Math.max(left.length, right.length)
  );
}

function narrativeChanges(
  baseline: SceneEvidenceSnapshot,
  candidate: SceneEvidenceSnapshot,
  options: Required<DiffOptions>,
): ReviewChange[] {
  const changes: ReviewChange[] = [];
  if (
    baseline.narrativeRevision &&
    candidate.narrativeRevision &&
    baseline.narrativeRevision === candidate.narrativeRevision
  ) {
    return changes;
  }
  const beforeSteps = new Map(baseline.narrative.map((step) => [step.stepId, step]));
  const afterSteps = new Map(candidate.narrative.map((step) => [step.stepId, step]));
  for (const id of new Set([...beforeSteps.keys(), ...afterSteps.keys()])) {
    const before = beforeSteps.get(id);
    const after = afterSteps.get(id);
    if (!before && after) {
      changes.push(
        change(candidate.sceneId, 'narrative', 'added', 'info', 'Narrative added', { stepId: id }),
      );
    } else if (before && !after) {
      changes.push(
        change(candidate.sceneId, 'narrative', 'removed', 'warning', 'Narrative removed', {
          stepId: id,
        }),
      );
    } else if (before && after) {
      if (before.hash && after.hash && before.hash === after.hash) continue;
      const beforeText = normalizeNarrative(before);
      const afterText = normalizeNarrative(after);
      const similarity = levenshteinSimilarity(beforeText, afterText);
      if (similarity < options.narrativeSimilarity || before.hash !== after.hash) {
        changes.push(
          change(
            candidate.sceneId,
            'narrative',
            'modified',
            'warning',
            'Approved narrative changed',
            {
              stepId: id,
              metrics: { similarity },
            },
          ),
        );
      }
    }
  }
  if (changes.length === 0 && baseline.narrativeRevision !== candidate.narrativeRevision) {
    changes.push(
      change(candidate.sceneId, 'narrative', 'modified', 'warning', 'Narrative revision changed'),
    );
  }
  return changes;
}

function privacyChanges(
  baseline: SceneEvidenceSnapshot,
  candidate: SceneEvidenceSnapshot,
): ReviewChange[] {
  const changes: ReviewChange[] = [];
  const before = new Set(baseline.privacy.findings.map((finding) => finding.fingerprint));
  const after = new Set(candidate.privacy.findings.map((finding) => finding.fingerprint));
  const added = candidate.privacy.findings.filter((finding) => !before.has(finding.fingerprint));
  for (const finding of added) {
    changes.push(
      change(
        candidate.sceneId,
        'privacy',
        'added',
        finding.severity === 'blocking' || finding.severity === 'high' ? 'blocking' : 'warning',
        `New ${finding.category} privacy finding (${finding.ruleId})`,
        {
          after: {
            category: finding.category,
            severity: finding.severity,
            confidence: finding.confidence,
            ruleId: finding.ruleId,
            path: finding.path,
          },
        },
      ),
    );
  }
  for (const finding of baseline.privacy.findings.filter(
    (finding) => !after.has(finding.fingerprint),
  )) {
    changes.push(
      change(
        candidate.sceneId,
        'privacy',
        'resolved',
        'info',
        `Resolved ${finding.category} privacy finding (${finding.ruleId})`,
        {
          before: {
            category: finding.category,
            severity: finding.severity,
            confidence: finding.confidence,
            ruleId: finding.ruleId,
            path: finding.path,
          },
        },
      ),
    );
  }
  if (candidate.privacy.status === 'unknown' && baseline.privacy.status !== 'unknown') {
    changes.push(
      change(
        candidate.sceneId,
        'privacy',
        'modified',
        'blocking',
        'Candidate privacy status is unknown',
      ),
    );
  }
  if (candidate.privacy.status === 'blocked' || candidate.privacy.status === 'quarantined') {
    if (!changes.some((candidateChange) => candidateChange.severity === 'blocking')) {
      changes.push(
        change(
          candidate.sceneId,
          'privacy',
          'failed',
          'blocking',
          `Candidate privacy status is ${candidate.privacy.status}`,
        ),
      );
    }
  }
  if (candidate.privacy.status !== baseline.privacy.status && changes.length === 0) {
    changes.push(
      change(candidate.sceneId, 'privacy', 'modified', 'warning', 'Privacy scan status changed', {
        before: baseline.privacy.status,
        after: candidate.privacy.status,
      }),
    );
  }
  return changes;
}

export function classifySceneDiff(
  baseline: SceneEvidenceSnapshot,
  candidate: SceneEvidenceSnapshot,
  options: DiffOptions = {},
): SceneDiffResult {
  if (baseline.sceneId !== candidate.sceneId)
    throw new TypeError('Cannot compare evidence from different Scenes');
  const configured = optionsWithDefaults(options);
  const changes = [
    ...functionalChanges(baseline, candidate),
    ...visualChanges(baseline, candidate, configured),
    ...semanticChanges(baseline, candidate),
    ...geometryChanges(baseline, candidate, configured),
    ...narrativeChanges(baseline, candidate, configured),
    ...privacyChanges(baseline, candidate),
  ];
  const dimensions = {
    functional: changes.filter((item) => item.dimension === 'functional').length,
    visual: changes.filter((item) => item.dimension === 'visual').length,
    semantic: changes.filter((item) => item.dimension === 'semantic').length,
    geometry: changes.filter((item) => item.dimension === 'geometry').length,
    narrative: changes.filter((item) => item.dimension === 'narrative').length,
    privacy: changes.filter((item) => item.dimension === 'privacy').length,
  };
  const state =
    candidate.functional.status === 'blocked' ||
    candidate.privacy.status === 'blocked' ||
    candidate.privacy.status === 'quarantined' ||
    candidate.privacy.status === 'unknown' ||
    changes.some((item) => item.dimension === 'privacy' && item.severity === 'blocking')
      ? 'blocked'
      : candidate.functional.status === 'failed' ||
          candidate.functional.status === 'cancelled' ||
          changes.some((item) => item.dimension === 'functional' && item.severity === 'error')
        ? 'broken'
        : changes.length > 0
          ? 'changed'
          : 'passed';
  return { state, changes, dimensions };
}

/**
 * Compare one immutable Run with its approved Baseline. A successful execution
 * without a Baseline is intentionally `changed`, never `passed`: there is no
 * approved visual truth to call unchanged yet. Unknown privacy is fail-closed.
 */
export function classifyRunAgainstBaseline(
  run: RunArtifact,
  baseline?: Baseline,
  options: DiffOptions = {},
): SceneDiffResult {
  const candidate = snapshotFromRun(run);
  const withAttemptHistory = (result: SceneDiffResult): SceneDiffResult => {
    const selected = run.attempts.find((attempt) => attempt.id === run.selectedAttemptId);
    const nonPassingAttempts = run.attempts.filter(
      (attempt) => attempt.id !== selected?.id && attempt.status !== 'passed',
    );
    if (selected?.status !== 'passed' || nonPassingAttempts.length === 0) return result;
    return {
      ...result,
      state: result.state === 'passed' ? 'changed' : result.state,
      changes: [
        ...result.changes,
        change(
          run.sceneId,
          'functional',
          'modified',
          'warning',
          'Scene includes non-passing attempt history despite a selected pass',
          { metrics: { nonPassingAttempts: nonPassingAttempts.length } },
        ),
      ],
      dimensions: {
        ...result.dimensions,
        functional: result.dimensions.functional + 1,
      },
    };
  };
  if (baseline) {
    if (baseline.projectId !== run.projectId) {
      throw new TypeError('Cannot compare a Run with a Baseline from another Project');
    }
    if (baseline.sceneId !== run.sceneId || baseline.runTargetId !== run.runTargetId) {
      throw new TypeError('Cannot compare a Run with a Baseline from another Scene or Run Target');
    }
    return withAttemptHistory(
      classifySceneDiff(snapshotFromBaseline(baseline), candidate, options),
    );
  }

  const privacyBlocked =
    candidate.privacy.status === 'unknown' ||
    candidate.privacy.status === 'blocked' ||
    candidate.privacy.status === 'quarantined';
  const executionBroken =
    candidate.functional.status === 'failed' ||
    candidate.functional.status === 'cancelled' ||
    candidate.functional.status === 'skipped';
  const dimension = privacyBlocked ? ('privacy' as const) : ('visual' as const);
  const state = privacyBlocked
    ? ('blocked' as const)
    : executionBroken
      ? ('broken' as const)
      : 'changed';
  const changes = [
    change(
      run.sceneId,
      dimension,
      privacyBlocked || executionBroken ? 'failed' : 'added',
      privacyBlocked ? 'blocking' : executionBroken ? 'error' : 'warning',
      privacyBlocked
        ? `Candidate privacy status is ${candidate.privacy.status}; no approved Baseline is available`
        : executionBroken
          ? `Scene execution is ${candidate.functional.status}; no approved Baseline is available`
          : 'No approved Baseline exists for this Scene and Run Target',
    ),
  ];
  return withAttemptHistory({
    state,
    changes,
    dimensions: {
      functional: executionBroken ? 1 : 0,
      visual: !privacyBlocked && !executionBroken ? 1 : 0,
      semantic: 0,
      geometry: 0,
      narrative: 0,
      privacy: privacyBlocked ? 1 : 0,
    },
  });
}
