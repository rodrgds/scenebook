import { buildGitHubCheckPayloads, type GitHubReviewChange } from '@scenebook/adapters/github';
import { artifactHash, createDeterministicId, stableStringify } from '@scenebook/core';
import { classifyRunAgainstBaseline, type DiffOptions } from '@scenebook/diff';
import {
  ARTIFACT_VERSION,
  BuildArtifactSchema,
  ReviewSchema,
  RunArtifactSchema,
  SCHEMA_VERSION,
  type Baseline,
  type BuildArtifact,
  type Review,
  type ReviewChange,
  type RunArtifact,
  type SourceLocation,
} from '@scenebook/schema';

export interface ReviewedRunEvidence {
  readonly run: RunArtifact;
  readonly review: Review;
}

function sourceForChange(run: RunArtifact, change: ReviewChange): SourceLocation | undefined {
  const selected = run.attempts.find((attempt) => attempt.id === run.selectedAttemptId);
  if (!selected) return undefined;
  if (change.stateId) {
    const stateSource = selected.states.find((state) => state.id === change.stateId)?.source;
    if (stateSource) return stateSource;
  }
  if (!change.stepId) return undefined;
  return (
    selected.checks.find((check) => check.stepId === change.stepId)?.source ??
    selected.actions.find((action) => action.stepId === change.stepId)?.source ??
    selected.states.find((state) => state.stepId === change.stepId)?.source
  );
}

function enrichedChanges(run: RunArtifact, changes: readonly ReviewChange[]): ReviewChange[] {
  return changes.map((change) => {
    const source = change.source ?? sourceForChange(run, change);
    return { ...change, ...(source ? { source } : {}) };
  });
}

/** Bind deterministic diff truth to the exact final Run artifact and Baseline. */
export function reviewRunEvidence(
  input: RunArtifact,
  baseline?: Baseline,
  options: { readonly diff?: DiffOptions; readonly detailsUrl?: string } = {},
): ReviewedRunEvidence {
  const unclassified = RunArtifactSchema.parse(input);
  const diff = classifyRunAgainstBaseline(unclassified, baseline, options.diff);
  const run = RunArtifactSchema.parse({ ...unclassified, changeState: diff.state });
  const changes = enrichedChanges(run, diff.changes);
  const revision = artifactHash(run);
  const review = ReviewSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: createDeterministicId(
      'review',
      `${run.id}:${baseline?.id ?? 'no-baseline'}:${run.selectedAttemptId}`,
    ),
    projectId: run.projectId,
    kind: 'review',
    createdAt: run.endedAt,
    producer: { name: '@scenebook/playwright', version: '0.1.0', runtime: process.version },
    subject: { kind: 'run', id: run.id, revision },
    status: 'open',
    changeState: diff.state,
    changes,
    comments: [],
    decisions: [],
    ...(baseline
      ? {
          baseline: {
            id: baseline.id,
            kind: 'baseline' as const,
            sha256: artifactHash(baseline),
          },
        }
      : {}),
    ...(run.status === 'passed' && diff.state !== 'blocked'
      ? {
          baselineCandidate: {
            id: run.id,
            kind: 'run' as const,
            sha256: revision,
          },
        }
      : {}),
    assignedTo: [],
    openedAt: run.endedAt,
  });
  return { run, review };
}

function githubSeverity(change: ReviewChange): GitHubReviewChange['severity'] {
  if (change.severity === 'blocking') return 'blocked';
  if (change.severity === 'error') return 'broken';
  if (change.severity === 'warning') return 'changed';
  return 'info';
}

export function githubChangesFromReviews(
  reviews: readonly Review[],
): readonly GitHubReviewChange[] {
  return reviews.flatMap((review) =>
    review.changes.map((change) => ({
      dimension: change.dimension,
      severity: githubSeverity(change),
      summary: change.summary,
      details: stableStringify({
        kind: change.kind,
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
        metrics: change.metrics,
      }),
      sceneId: change.sceneId,
      ...(change.stepId ? { stepId: change.stepId } : {}),
      ...(change.source
        ? {
            path: change.source.path,
            startLine: change.source.line,
            endLine: change.source.line,
          }
        : {}),
    })),
  );
}

export function githubCheckPayloadsForReviews(options: {
  readonly headSha: string;
  readonly reviews: readonly Review[];
  readonly detailsUrl?: string;
}) {
  return buildGitHubCheckPayloads({
    headSha: options.headSha,
    changes: githubChangesFromReviews(options.reviews),
    ...(options.detailsUrl ? { detailsUrl: options.detailsUrl } : {}),
  });
}

/** Rebind a Build after exact evidence attestation changes Run hashes/statuses. */
export function rebuildBuildEvidence(
  input: BuildArtifact,
  runs: readonly RunArtifact[],
): BuildArtifact {
  const build = BuildArtifactSchema.parse(input);
  const byPlan = new Map(runs.map((run) => [`${run.sceneId}\u0000${run.runTargetId}`, run]));
  const references = build.expectedRunPlan.flatMap((planned) => {
    const run = byPlan.get(`${planned.sceneId}\u0000${planned.runTargetId}`);
    if (!run) return [];
    return [
      {
        sceneId: run.sceneId,
        runTargetId: run.runTargetId,
        required: planned.required,
        run: {
          id: run.id,
          kind: 'run' as const,
          sha256: artifactHash(run),
          path:
            build.runs.find(
              (reference) =>
                reference.sceneId === run.sceneId && reference.runTargetId === run.runTargetId,
            )?.run?.path ?? `runs/${run.id}.json`,
        },
        status: run.status,
        changeState: run.changeState,
      },
    ];
  });
  const summary = {
    total: build.expectedRunPlan.length,
    passed: 0,
    changed: 0,
    broken: 0,
    blocked: 0,
    pending: build.expectedRunPlan.length - references.length,
  };
  for (const reference of references) {
    if (
      reference.status === 'skipped' ||
      reference.status === 'cancelled' ||
      reference.changeState === undefined
    ) {
      summary.pending += 1;
    } else if (reference.changeState === 'passed') summary.passed += 1;
    else if (reference.changeState === 'changed') summary.changed += 1;
    else if (reference.changeState === 'broken') summary.broken += 1;
    else summary.blocked += 1;
  }
  const status =
    summary.broken > 0 || summary.pending > 0
      ? ('failed' as const)
      : summary.blocked > 0
        ? ('blocked' as const)
        : summary.changed > 0
          ? ('changed' as const)
          : ('passed' as const);
  return BuildArtifactSchema.parse({ ...build, status, runs: references, summary });
}

/**
 * Finalize an exact set of reporter shard fragments. Missing, duplicate, or
 * provenance-mismatched shards fail rather than producing a deceptively green
 * partial Build.
 */
export function mergeShardBuildEvidence(fragments: readonly BuildArtifact[]): BuildArtifact {
  if (fragments.length === 0) throw new Error('At least one shard Build fragment is required.');
  const parsed = fragments.map((fragment) => BuildArtifactSchema.parse(fragment));
  const total = parsed[0]!.shard?.total;
  if (!total || parsed.some((fragment) => fragment.completeness !== 'partial' || !fragment.shard)) {
    throw new Error('Every merged Build must be an explicit partial shard fragment.');
  }
  if (parsed.length !== total || parsed.some((fragment) => fragment.shard!.total !== total)) {
    throw new Error(`Shard merge requires exactly ${total} fragments; received ${parsed.length}.`);
  }
  const current = new Set(parsed.map((fragment) => fragment.shard!.current));
  if (current.size !== total || [...current].some((index) => index < 1 || index > total)) {
    throw new Error('Shard merge contains a missing or duplicate shard index.');
  }
  const first = parsed[0]!;
  for (const fragment of parsed.slice(1)) {
    if (
      fragment.projectId !== first.projectId ||
      fragment.trigger !== first.trigger ||
      stableStringify(fragment.repository) !== stableStringify(first.repository)
    ) {
      throw new Error(
        'Shard Builds do not share exact Project, trigger, and repository provenance.',
      );
    }
  }
  const plans = new Map<string, BuildArtifact['expectedRunPlan'][number]>();
  const runs = new Map<string, BuildArtifact['runs'][number]>();
  for (const fragment of parsed) {
    for (const plan of fragment.expectedRunPlan) {
      const key = `${plan.sceneId}\u0000${plan.runTargetId}`;
      if (plans.has(key))
        throw new Error(`Shard plan contains duplicate Scene/Target: ${plan.sceneId}.`);
      plans.set(key, plan);
    }
    for (const run of fragment.runs) {
      const key = `${run.sceneId}\u0000${run.runTargetId}`;
      if (runs.has(key))
        throw new Error(`Shard evidence contains duplicate Scene/Target: ${run.sceneId}.`);
      runs.set(key, run);
    }
  }
  const expectedRunPlan = [...plans.values()].sort(
    (left, right) =>
      left.sceneId.localeCompare(right.sceneId) ||
      left.runTargetId.localeCompare(right.runTargetId),
  );
  const references = [...runs.values()].sort(
    (left, right) =>
      left.sceneId.localeCompare(right.sceneId) ||
      left.runTargetId.localeCompare(right.runTargetId),
  );
  const summary = {
    total: expectedRunPlan.length,
    passed: 0,
    changed: 0,
    broken: 0,
    blocked: 0,
    pending: expectedRunPlan.length - references.length,
  };
  for (const reference of references) {
    if (
      reference.status === 'skipped' ||
      reference.status === 'cancelled' ||
      reference.changeState === undefined
    ) {
      summary.pending += 1;
    } else if (reference.changeState === 'passed') summary.passed += 1;
    else if (reference.changeState === 'changed') summary.changed += 1;
    else if (reference.changeState === 'broken') summary.broken += 1;
    else summary.blocked += 1;
  }
  const status =
    summary.broken > 0 || summary.pending > 0
      ? ('failed' as const)
      : summary.blocked > 0
        ? ('blocked' as const)
        : summary.changed > 0
          ? ('changed' as const)
          : ('passed' as const);
  const startedAt = parsed.reduce(
    (earliest, fragment) => (fragment.startedAt < earliest ? fragment.startedAt : earliest),
    first.startedAt,
  );
  const endedAt = parsed.reduce(
    (latest, fragment) =>
      fragment.endedAt && fragment.endedAt > latest ? fragment.endedAt : latest,
    first.endedAt!,
  );
  return BuildArtifactSchema.parse({
    ...first,
    id: createDeterministicId(
      'build',
      `${first.repository.commit}:${parsed
        .map((fragment) => `${fragment.shard!.current}:${artifactHash(fragment)}`)
        .sort()
        .join('|')}`,
    ),
    createdAt: endedAt,
    completeness: 'complete',
    shard: undefined,
    status,
    expectedRunPlan,
    runs: references,
    startedAt,
    endedAt,
    summary,
  });
}
