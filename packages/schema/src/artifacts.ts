import { z } from 'zod';

import {
  ARTIFACT_VERSION,
  ArtifactHashSchema,
  AssetRefSchema,
  AssetRoleSchema,
  IdSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  NormalizedRectSchema,
  PrivacySummarySchema,
  ProducerSchema,
  RepositoryRevisionSchema,
  RelativePathSchema,
  RouteSchema,
  SCHEMA_VERSION,
  SceneSourceRevisionSchema,
  SemanticProjectionSchema,
  Sha256Schema,
  SourceLocationSchema,
  TargetSchema,
  ViewportSchema,
} from './common.js';
import { ReleasePublicationSchema } from './publication.js';
import {
  ApprovalAttestationSchema,
  PublicationCandidateSchema,
  PublicationEventSchema,
  PublicationReleaseSchema,
} from './local-publication.js';

const ArtifactBaseShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  artifactVersion: z.literal(ARTIFACT_VERSION),
  id: IdSchema,
  projectId: IdSchema,
  createdAt: IsoDateTimeSchema,
  producer: ProducerSchema,
};

export const ArtifactReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: IdSchema,
      kind: z.enum(['run', 'build', 'baseline', 'release', 'review']),
      sha256: ArtifactHashSchema,
      path: z.string().min(1).max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      id: IdSchema,
      kind: z.literal('asset'),
      sha256: Sha256Schema,
      path: z.string().min(1).max(2_000).optional(),
    })
    .strict(),
]);

export const ExecutionStatusSchema = z.enum([
  'passed',
  'failed',
  'blocked',
  'cancelled',
  'skipped',
]);
export const SceneChangeStateSchema = z.enum(['passed', 'changed', 'broken', 'blocked']);

export const ActionResultSchema = z
  .object({
    actionId: IdSchema,
    stepId: IdSchema,
    status: ExecutionStatusSchema,
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
    durationMs: z.number().int().nonnegative(),
    error: z.string().max(20_000).optional(),
    source: SourceLocationSchema.optional(),
  })
  .strict();

export const CheckResultSchema = z
  .object({
    checkId: IdSchema,
    stepId: IdSchema,
    status: ExecutionStatusSchema,
    expected: JsonValueSchema.optional(),
    actual: JsonValueSchema.optional(),
    message: z.string().max(20_000).optional(),
    source: SourceLocationSchema.optional(),
  })
  .strict();

export const StateEvidenceSchema = z
  .object({
    id: IdSchema,
    sceneId: IdSchema,
    stepId: IdSchema,
    phase: z.enum(['before', 'after']),
    capturedAt: IsoDateTimeSchema,
    route: RouteSchema,
    viewport: ViewportSchema,
    screenshot: AssetRefSchema,
    target: TargetSchema.optional(),
    semantic: SemanticProjectionSchema.optional(),
    screenshotHash: Sha256Schema,
    perceptualHash: z
      .string()
      .regex(/^[a-f0-9]{16,256}$/u)
      .optional(),
    masksApplied: z.array(IdSchema).max(10_000).default([]),
    privacy: PrivacySummarySchema,
    source: SourceLocationSchema.optional(),
  })
  .strict()
  .refine((evidence) => evidence.screenshot.sha256 === evidence.screenshotHash, {
    message: 'screenshotHash must match the content-addressed screenshot',
    path: ['screenshotHash'],
  });

export const RunErrorSchema = z
  .object({
    class: z.enum([
      'execution',
      'assertion',
      'selector',
      'navigation',
      'fixture',
      'environment',
      'privacy',
      'infrastructure',
    ]),
    message: z.string().min(1).max(20_000),
    stepId: IdSchema.optional(),
    actionId: IdSchema.optional(),
    checkId: IdSchema.optional(),
    source: SourceLocationSchema.optional(),
    retryable: z.boolean().default(false),
    stack: z.string().max(100_000).optional(),
  })
  .strict();

export const RunAttemptSchema = z
  .object({
    id: IdSchema,
    index: z.number().int().nonnegative(),
    retry: z.number().int().nonnegative().optional(),
    repeat: z.number().int().nonnegative().optional(),
    status: ExecutionStatusSchema,
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
    durationMs: z.number().int().nonnegative(),
    shard: z
      .object({ current: z.number().int().positive(), total: z.number().int().positive() })
      .strict()
      .optional(),
    actions: z.array(ActionResultSchema).max(100_000).default([]),
    checks: z.array(CheckResultSchema).max(100_000).default([]),
    states: z.array(StateEvidenceSchema).max(100_000).default([]),
    errors: z.array(RunErrorSchema).max(10_000).default([]),
    attachments: z.array(AssetRefSchema).max(10_000).default([]),
    trace: AssetRefSchema.optional(),
    privacy: PrivacySummarySchema,
  })
  .strict()
  .superRefine((attempt, context) => {
    if (Date.parse(attempt.endedAt) < Date.parse(attempt.startedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'endedAt cannot precede startedAt',
        path: ['endedAt'],
      });
    }
    if (attempt.shard && attempt.shard.current > attempt.shard.total) {
      context.addIssue({
        code: 'custom',
        message: 'Shard current cannot exceed total',
        path: ['shard', 'current'],
      });
    }
    const stateIds = new Set<string>();
    for (const [index, state] of attempt.states.entries()) {
      if (stateIds.has(state.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate State evidence id: ${state.id}`,
          path: ['states', index, 'id'],
        });
      }
      stateIds.add(state.id);
    }
    if (
      attempt.status === 'passed' &&
      (attempt.errors.length > 0 || attempt.checks.some((check) => check.status === 'failed'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A passed attempt cannot contain errors or failed Checks',
        path: ['status'],
      });
    }
    if (
      attempt.status === 'blocked' &&
      attempt.privacy.status !== 'blocked' &&
      attempt.privacy.status !== 'quarantined'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A blocked attempt requires blocked or quarantined privacy status',
        path: ['privacy', 'status'],
      });
    }
  });

export const RunPlanEntrySchema = z
  .object({
    sceneId: IdSchema,
    runTargetId: IdSchema,
    required: z.boolean().default(true),
  })
  .strict();

export const RunArtifactSchema = z
  .object({
    ...ArtifactBaseShape,
    kind: z.literal('run'),
    sceneId: IdSchema,
    runTargetId: IdSchema,
    buildId: IdSchema.optional(),
    repository: RepositoryRevisionSchema,
    sourceRevision: SceneSourceRevisionSchema,
    narrativeRevision: Sha256Schema.optional(),
    themeRevision: Sha256Schema.optional(),
    status: ExecutionStatusSchema,
    changeState: SceneChangeStateSchema.optional(),
    expectedStepIds: z.array(IdSchema).min(1).max(100_000),
    attempts: z.array(RunAttemptSchema).min(1).max(100),
    selectedAttemptId: IdSchema,
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
    durationMs: z.number().int().nonnegative(),
    privacy: PrivacySummarySchema,
  })
  .strict()
  .superRefine((run, context) => {
    const attemptIds = new Set<string>();
    const expectedStepIds = new Set(run.expectedStepIds);
    for (const [index, attempt] of run.attempts.entries()) {
      if (attemptIds.has(attempt.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate attempt id: ${attempt.id}`,
          path: ['attempts', index, 'id'],
        });
      }
      attemptIds.add(attempt.id);
      for (const [actionIndex, action] of attempt.actions.entries()) {
        if (!expectedStepIds.has(action.stepId)) {
          context.addIssue({
            code: 'custom',
            message: 'Action result references a Step outside expectedStepIds',
            path: ['attempts', index, 'actions', actionIndex, 'stepId'],
          });
        }
      }
      for (const [checkIndex, check] of attempt.checks.entries()) {
        if (!expectedStepIds.has(check.stepId)) {
          context.addIssue({
            code: 'custom',
            message: 'Check result references a Step outside expectedStepIds',
            path: ['attempts', index, 'checks', checkIndex, 'stepId'],
          });
        }
      }
      for (const [stateIndex, state] of attempt.states.entries()) {
        if (state.sceneId !== run.sceneId) {
          context.addIssue({
            code: 'custom',
            message: 'State evidence belongs to another Scene',
            path: ['attempts', index, 'states', stateIndex, 'sceneId'],
          });
        }
        if (!expectedStepIds.has(state.stepId)) {
          context.addIssue({
            code: 'custom',
            message: 'State evidence references a Step outside expectedStepIds',
            path: ['attempts', index, 'states', stateIndex, 'stepId'],
          });
        }
      }
    }
    if (!attemptIds.has(run.selectedAttemptId)) {
      context.addIssue({
        code: 'custom',
        message: 'selectedAttemptId does not exist',
        path: ['selectedAttemptId'],
      });
    }
    const selected = run.attempts.find((attempt) => attempt.id === run.selectedAttemptId);
    if (selected && selected.status !== run.status) {
      context.addIssue({
        code: 'custom',
        message: 'Run status must match selected attempt status',
        path: ['status'],
      });
    }
    if (run.status === 'passed' && selected?.status !== 'passed') {
      context.addIssue({
        code: 'custom',
        message: 'A passed Run must select a passed attempt',
        path: ['selectedAttemptId'],
      });
    }
    if (new Set(run.expectedStepIds).size !== run.expectedStepIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'expectedStepIds must be unique',
        path: ['expectedStepIds'],
      });
    }
  });

// Compatibility alias used by adapters that call the evidence layer simply Run.
export const RunSchema = RunArtifactSchema;

export const BuildRunReferenceSchema = z
  .object({
    sceneId: IdSchema,
    runTargetId: IdSchema,
    required: z.boolean(),
    run: ArtifactReferenceSchema.optional(),
    status: ExecutionStatusSchema.optional(),
    changeState: SceneChangeStateSchema.optional(),
  })
  .strict();

export const BuildArtifactSchema = z
  .object({
    ...ArtifactBaseShape,
    kind: z.literal('build'),
    repository: RepositoryRevisionSchema,
    trigger: z.enum(['local', 'push', 'pull-request', 'schedule', 'manual', 'release']),
    completeness: z.enum(['complete', 'partial']).default('complete'),
    shard: z
      .object({ current: z.number().int().positive(), total: z.number().int().positive() })
      .strict()
      .optional(),
    status: z.enum(['pending', 'running', 'passed', 'changed', 'failed', 'blocked', 'cancelled']),
    expectedRunPlan: z.array(RunPlanEntrySchema).min(1).max(100_000),
    runs: z.array(BuildRunReferenceSchema).max(100_000),
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema.optional(),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        changed: z.number().int().nonnegative(),
        broken: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((build, context) => {
    if (build.shard && build.shard.current > build.shard.total) {
      context.addIssue({
        code: 'custom',
        message: 'Build shard current cannot exceed total',
        path: ['shard', 'current'],
      });
    }
    if ((build.completeness === 'partial') !== (build.shard !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Only shard Build fragments may be partial',
        path: ['completeness'],
      });
    }
    const summaryTotal =
      build.summary.passed +
      build.summary.changed +
      build.summary.broken +
      build.summary.blocked +
      build.summary.pending;
    if (
      summaryTotal !== build.summary.total ||
      build.summary.total !== build.expectedRunPlan.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Build summary must account for every expected Run',
        path: ['summary'],
      });
    }
    const planKeys = new Set<string>();
    for (const [index, item] of build.expectedRunPlan.entries()) {
      const key = `${item.sceneId}\u0000${item.runTargetId}`;
      if (planKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'Expected Run Plan entries must be unique',
          path: ['expectedRunPlan', index],
        });
      }
      planKeys.add(key);
    }
    for (const [index, run] of build.runs.entries()) {
      if (!planKeys.has(`${run.sceneId}\u0000${run.runTargetId}`)) {
        context.addIssue({
          code: 'custom',
          message: 'Run is not present in expected Run Plan',
          path: ['runs', index],
        });
      }
    }
  });

export const BaselineStateSchema = z
  .object({
    sceneId: IdSchema,
    stepId: IdSchema,
    phase: z.enum(['before', 'after']),
    stateId: IdSchema,
    screenshot: AssetRefSchema,
    screenshotHash: Sha256Schema,
    perceptualHash: z
      .string()
      .regex(/^[a-f0-9]{16,256}$/u)
      .optional(),
    route: RouteSchema,
    viewport: ViewportSchema,
    target: TargetSchema.optional(),
    semantic: SemanticProjectionSchema.optional(),
    narrativeHash: Sha256Schema.optional(),
    privacy: PrivacySummarySchema,
  })
  .strict()
  .refine((state) => state.screenshot.sha256 === state.screenshotHash, {
    message: 'screenshotHash must match screenshot content hash',
    path: ['screenshotHash'],
  });

export const ApprovalSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(['visual', 'editorial', 'privacy', 'release', 'override']),
    decision: z.enum(['approved', 'rejected']),
    actorId: IdSchema,
    createdAt: IsoDateTimeSchema,
    revision: Sha256Schema,
    reason: z.string().max(5_000).optional(),
  })
  .strict();

export const BaselineSchema = z
  .object({
    ...ArtifactBaseShape,
    kind: z.literal('baseline'),
    sceneId: IdSchema,
    runTargetId: IdSchema,
    sourceRunId: IdSchema,
    /** Exact canonical Run identity. Required by local immutable publication; optional for v1 compatibility. */
    sourceRunRevision: ArtifactHashSchema.optional(),
    sourceAttemptId: IdSchema,
    sourceRevision: SceneSourceRevisionSchema,
    narrativeRevision: Sha256Schema.optional(),
    completeness: z.literal('complete'),
    sourceRunStatus: z.literal('passed'),
    expectedStepIds: z.array(IdSchema).min(1).max(100_000),
    states: z.array(BaselineStateSchema).min(1).max(100_000),
    checks: z.array(CheckResultSchema).max(100_000).default([]),
    checksHash: Sha256Schema,
    approvals: z.array(ApprovalSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((baseline, context) => {
    const stateIds = new Set<string>();
    const coveredSteps = new Set<string>();
    for (const [index, state] of baseline.states.entries()) {
      if (state.sceneId !== baseline.sceneId) {
        context.addIssue({
          code: 'custom',
          message: 'Baseline State belongs to another Scene',
          path: ['states', index, 'sceneId'],
        });
      }
      if (stateIds.has(state.stateId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate baseline State: ${state.stateId}`,
          path: ['states', index, 'stateId'],
        });
      }
      stateIds.add(state.stateId);
      coveredSteps.add(state.stepId);
    }
    for (const [index, stepId] of baseline.expectedStepIds.entries()) {
      if (!coveredSteps.has(stepId)) {
        context.addIssue({
          code: 'custom',
          message: `Complete baseline is missing evidence for Step: ${stepId}`,
          path: ['expectedStepIds', index],
        });
      }
    }
    if (!baseline.approvals.some((approval) => approval.decision === 'approved')) {
      context.addIssue({
        code: 'custom',
        message: 'A Baseline requires at least one approving decision',
        path: ['approvals'],
      });
    }
  });

export const ReleaseOutputSchema = z
  .object({
    format: z.enum([
      'catalog',
      'standalone-html',
      'web-component',
      'iframe',
      'markdown',
      'mdx',
      'html-guide',
      'pdf',
      'mp4',
      'webm',
      'gif',
      'readme-card',
      'og-image',
      'social-carousel',
      'source',
      'evidence',
      'ci-report',
    ]),
    locale: z.string().min(2).max(35).optional(),
    asset: z
      .object({
        sha256: Sha256Schema,
        path: RelativePathSchema,
        mediaType: z.string().min(3).max(255),
        byteLength: z.number().int().nonnegative(),
        role: AssetRoleSchema.default('other'),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .superRefine((asset, context) => {
        if ((asset.width === undefined) !== (asset.height === undefined)) {
          context.addIssue({
            code: 'custom',
            message: 'width and height must either both be present or both be absent',
            path: ['width'],
          });
        }
      }),
    entrypoint: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export const ReleaseSceneSchema = z
  .object({
    sceneId: IdSchema,
    baselineId: IdSchema.optional(),
    sourceRevision: SceneSourceRevisionSchema,
    narrativeRevision: Sha256Schema.optional(),
    themeRevision: Sha256Schema.optional(),
    localeRevisions: z.record(z.string(), Sha256Schema).default({}),
    carriedForward: z.boolean().default(false),
    outputs: z.array(ReleaseOutputSchema).min(1).max(10_000),
  })
  .strict();

export const ReleaseSchema = z
  .object({
    ...ArtifactBaseShape,
    kind: z.literal('release'),
    channelId: IdSchema,
    sequence: z.number().int().positive(),
    status: z.enum(['staged', 'published', 'superseded', 'rolled-back']),
    sourceBuildId: IdSchema.optional(),
    scenes: z.array(ReleaseSceneSchema).min(1).max(100_000),
    approvals: z.array(ApprovalSchema).min(1).max(10_000),
    manifestHash: Sha256Schema,
    /** Required by hosted promotion; optional here for v1 portable artifact compatibility. */
    publication: ReleasePublicationSchema.optional(),
    publishedAt: IsoDateTimeSchema.optional(),
    supersedesReleaseId: IdSchema.optional(),
  })
  .strict()
  .superRefine((release, context) => {
    const sceneIds = new Set<string>();
    for (const [index, scene] of release.scenes.entries()) {
      if (sceneIds.has(scene.sceneId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate Release Scene: ${scene.sceneId}`,
          path: ['scenes', index, 'sceneId'],
        });
      }
      sceneIds.add(scene.sceneId);
      if (!scene.carriedForward && scene.baselineId === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A newly built Release Scene requires an approved baseline',
          path: ['scenes', index, 'baselineId'],
        });
      }
    }
    if (release.status === 'published' && release.publishedAt === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A published Release requires publishedAt',
        path: ['publishedAt'],
      });
    }
    if (
      !release.approvals.some(
        (approval) => approval.kind === 'release' && approval.decision === 'approved',
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A Release requires an explicit release approval',
        path: ['approvals'],
      });
    }
  });

export const ChangeDimensionSchema = z.enum([
  'functional',
  'visual',
  'semantic',
  'geometry',
  'narrative',
  'privacy',
]);
export const ChangeSeveritySchema = z.enum(['info', 'warning', 'error', 'blocking']);

export const ReviewChangeSchema = z
  .object({
    id: IdSchema,
    dimension: ChangeDimensionSchema,
    severity: ChangeSeveritySchema,
    kind: z.enum(['added', 'removed', 'modified', 'failed', 'resolved']),
    sceneId: IdSchema,
    stepId: IdSchema.optional(),
    stateId: IdSchema.optional(),
    summary: z.string().min(1).max(2_000),
    before: JsonValueSchema.optional(),
    after: JsonValueSchema.optional(),
    metrics: z.record(z.string(), z.number().finite()).default({}),
    source: SourceLocationSchema.optional(),
  })
  .strict();

export const ReviewCommentSchema = z
  .object({
    id: IdSchema,
    actorId: IdSchema,
    createdAt: IsoDateTimeSchema,
    body: z.string().min(1).max(20_000),
    stepId: IdSchema.optional(),
    stateId: IdSchema.optional(),
    region: NormalizedRectSchema.optional(),
    resolvedAt: IsoDateTimeSchema.optional(),
    resolvedBy: IdSchema.optional(),
  })
  .strict()
  .superRefine((comment, context) => {
    if ((comment.resolvedAt === undefined) !== (comment.resolvedBy === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'resolvedAt and resolvedBy must be set together',
        path: ['resolvedAt'],
      });
    }
  });

export const ReviewDecisionSchema = z
  .object({
    id: IdSchema,
    changeId: IdSchema.optional(),
    actorId: IdSchema,
    decision: z.enum(['approve', 'reject', 'dismiss', 'request-change']),
    createdAt: IsoDateTimeSchema,
    reason: z.string().max(5_000).optional(),
  })
  .strict();

export const ReviewSchema = z
  .object({
    ...ArtifactBaseShape,
    kind: z.literal('review'),
    subject: z
      .object({
        kind: z.enum(['build', 'run', 'release']),
        id: IdSchema,
        revision: Sha256Schema,
      })
      .strict(),
    status: z.enum(['open', 'approved', 'changes-requested', 'rejected', 'closed']),
    changeState: SceneChangeStateSchema,
    changes: z.array(ReviewChangeSchema).max(100_000).default([]),
    comments: z.array(ReviewCommentSchema).max(100_000).default([]),
    decisions: z.array(ReviewDecisionSchema).max(100_000).default([]),
    baseline: ArtifactReferenceSchema.refine((reference) => reference.kind === 'baseline', {
      message: 'Review baseline must reference a Baseline artifact',
    }).optional(),
    baselineCandidate: ArtifactReferenceSchema.optional(),
    assignedTo: z.array(IdSchema).max(1_000).default([]),
    openedAt: IsoDateTimeSchema,
    closedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((review, context) => {
    const changeIds = new Set(review.changes.map((change) => change.id));
    for (const [index, decision] of review.decisions.entries()) {
      if (decision.changeId !== undefined && !changeIds.has(decision.changeId)) {
        context.addIssue({
          code: 'custom',
          message: 'Decision references an unknown change',
          path: ['decisions', index, 'changeId'],
        });
      }
    }
    if (review.status === 'approved' && review.changeState === 'broken') {
      context.addIssue({
        code: 'custom',
        message: 'A broken review cannot be approved',
        path: ['status'],
      });
    }
    if (review.status === 'approved' && review.changeState === 'blocked') {
      context.addIssue({
        code: 'custom',
        message: 'A privacy-blocked review cannot be approved',
        path: ['status'],
      });
    }
    if (
      review.status === 'approved' &&
      !review.decisions.some((decision) => decision.decision === 'approve')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An approved Review requires an approving decision',
        path: ['decisions'],
      });
    }
    const closed = ['approved', 'rejected', 'closed'].includes(review.status);
    if (closed !== (review.closedAt !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Closed review states require closedAt',
        path: ['closedAt'],
      });
    }
  });

/** Artifacts whose identity is the canonical hash of their schema-normalized payload. */
export const CanonicalArtifactSchema = z.union([
  RunArtifactSchema,
  BuildArtifactSchema,
  BaselineSchema,
  ReleaseSchema,
  ReviewSchema,
  PublicationCandidateSchema,
  ApprovalAttestationSchema,
  PublicationReleaseSchema,
  PublicationEventSchema,
]);

export type ActionResult = z.infer<typeof ActionResultSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Baseline = z.infer<typeof BaselineSchema>;
export type BaselineState = z.infer<typeof BaselineStateSchema>;
export type BuildArtifact = z.infer<typeof BuildArtifactSchema>;
export type CanonicalArtifact = z.infer<typeof CanonicalArtifactSchema>;
export type ChangeDimension = z.infer<typeof ChangeDimensionSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type Release = z.infer<typeof ReleaseSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type ReviewChange = z.infer<typeof ReviewChangeSchema>;
export type Run = z.infer<typeof RunSchema>;
export type RunArtifact = z.infer<typeof RunArtifactSchema>;
export type RunAttempt = z.infer<typeof RunAttemptSchema>;
export type StateEvidence = z.infer<typeof StateEvidenceSchema>;
