import { z } from 'zod';

import {
  ARTIFACT_VERSION,
  BaselineSchema,
  BuildArtifactSchema,
  ChannelPolicySchema,
  IdSchema,
  JsonValueSchema,
  NormalizedRectSchema,
  PrivacySummarySchema,
  ProducerSchema,
  ReleasePublicationSchema,
  ReleaseSceneSchema,
  ReviewSchema,
  RunArtifactSchema,
  SCHEMA_VERSION,
  SceneSchema,
  Sha256Schema,
  SlugSchema,
} from '@scenebook/schema';

import { ALLOWED_OBJECT_MEDIA_TYPES } from './media-policy.js';
import { artifactObjectIdentity } from './object-identity.js';
import { assertSafeGitHubSourcePath } from './github-app.js';

export const IdentityScopeSchema = z.enum([
  'workspace:read',
  'workspace:admin',
  'project:read',
  'project:write',
  'review:read',
  'review:write',
  'channel:read',
  'channel:write',
  'release:write',
  'schedule:read',
  'schedule:write',
  'runner:admin',
  'analytics:read',
  'audit:read',
]);

export const CreateIdentityUserRequestSchema = z
  .object({
    id: IdSchema.optional(),
    email: z.string().trim().toLowerCase().email().max(320),
    displayName: z.string().trim().min(1).max(200),
  })
  .strict();

export const PutWorkspaceMembershipRequestSchema = z
  .object({ userId: IdSchema, role: z.enum(['owner', 'editor', 'reviewer', 'viewer']) })
  .strict();

export const CreateIdentityApiTokenRequestSchema = z
  .object({
    userId: IdSchema.optional(),
    name: z.string().trim().min(1).max(200),
    scopes: z.array(IdentityScopeSchema).min(1).max(14),
    projectId: IdSchema.optional(),
    channelId: IdSchema.optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.scopes).size !== value.scopes.length) {
      context.addIssue({
        code: 'custom',
        message: 'API token scopes must be unique',
        path: ['scopes'],
      });
    }
    if (value.channelId && !value.projectId) {
      context.addIssue({
        code: 'custom',
        message: 'A Channel-scoped API token must also be Project-scoped',
        path: ['channelId'],
      });
    }
  });

export const CreateUserSessionRequestSchema = z.object({}).strict();

export const CreatePortalGrantRequestSchema = z
  .object({
    id: IdSchema.optional(),
    subject: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('user'), userId: IdSchema }).strict(),
      z.object({ kind: z.literal('link'), label: z.string().trim().min(1).max(200) }).strict(),
    ]),
    permission: z.enum(['view', 'review']),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.subject.kind === 'link' && value.permission !== 'view') {
      context.addIssue({
        code: 'custom',
        message: 'Anonymous share grants are view-only; review attribution requires a User',
        path: ['permission'],
      });
    }
  });

export const CreatePrivateShareLinkRequestSchema = z
  .object({ grantId: IdSchema, expiresAt: z.string().datetime({ offset: true }) })
  .strict();

export const ResolvePrivateShareRequestSchema = z
  .object({ token: z.string().min(100).max(20_000) })
  .strict();

export const CreateWorkspaceRequestSchema = z
  .object({ id: IdSchema.optional(), slug: SlugSchema, name: z.string().min(1).max(200) })
  .strict();

export const CreateProjectRequestSchema = z
  .object({ id: IdSchema.optional(), slug: SlugSchema, name: z.string().min(1).max(200) })
  .strict();

export const BindRepositoryRequestSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
      .max(300),
    workflowRefPattern: z.string().min(1).max(500).default('*'),
  })
  .strict();

const GitHubSha1Schema = z.string().regex(/^[a-f0-9]{40}$/u);
const GitHubInstallationIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const GitHubSourcePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => {
    try {
      assertSafeGitHubSourcePath(path);
      return true;
    } catch {
      return false;
    }
  }, 'Source edits are limited to safe authored Scene paths');

export const BindGitHubInstallationRequestSchema = z
  .object({
    repositoryBindingId: IdSchema,
    installationId: GitHubInstallationIdSchema,
  })
  .strict();

export const RevokeGitHubInstallationRequestSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export const ReadGitHubSourceRequestSchema = z
  .object({
    installationBindingId: IdSchema,
    commitSha: GitHubSha1Schema,
    path: GitHubSourcePathSchema,
  })
  .strict();

const GitHubPatchOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('locator'),
      before: z.string().min(1).max(2_000),
      after: z
        .string()
        .max(2_000)
        .refine((value) => !/[\r\n\u0000]/u.test(value)),
    })
    .strict(),
  z
    .object({
      kind: z.literal('narrative'),
      before: z.string().min(1).max(10_000),
      after: z
        .string()
        .max(10_000)
        .refine((value) => !value.includes('\0')),
    })
    .strict(),
  z
    .object({
      kind: z.literal('presentation'),
      before: z.string().min(1).max(2_000),
      after: z
        .string()
        .max(2_000)
        .refine((value) => !/[\r\n\u0000]/u.test(value)),
    })
    .strict(),
]);

const GitHubChangeEvidenceBindingSchema = z
  .object({
    runId: IdSchema.optional(),
    runArtifactHash: Sha256Schema.optional(),
    buildId: IdSchema.optional(),
    buildArtifactHash: Sha256Schema.optional(),
    reviewId: IdSchema.optional(),
    reviewHash: Sha256Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [idKey, hashKey] of [
      ['runId', 'runArtifactHash'],
      ['buildId', 'buildArtifactHash'],
      ['reviewId', 'reviewHash'],
    ] as const) {
      if ((value[idKey] === undefined) !== (value[hashKey] === undefined)) {
        context.addIssue({
          code: 'custom',
          message: `${idKey} and ${hashKey} must be provided together`,
          path: [hashKey],
        });
      }
    }
    if (!value.runId && !value.buildId && !value.reviewId) {
      context.addIssue({
        code: 'custom',
        message: 'At least one exact evidence binding is required',
      });
    }
  });

export const CreateGitHubSourceChangeRequestSchema = z
  .object({
    installationBindingId: IdSchema,
    baseCommitSha: GitHubSha1Schema,
    expectedBlobSha: GitHubSha1Schema,
    path: GitHubSourcePathSchema,
    operations: z.array(GitHubPatchOperationSchema).min(1).max(50),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/u.test(value),
        'Title cannot contain control characters',
      ),
    createReviewIssue: z.boolean().default(false),
    evidence: GitHubChangeEvidenceBindingSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, operation] of value.operations.entries()) {
      if (operation.before === operation.after) {
        context.addIssue({
          code: 'custom',
          message: 'Patch before and after values must differ',
          path: ['operations', index],
        });
      }
    }
  });

const GitSourceRefSchema = z
  .string()
  .min(12)
  .max(500)
  .regex(/^refs\/(?:heads|tags)\/[\x21-\x7e]+$/u)
  .refine(
    (value) =>
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.includes('\\') &&
      !value.includes('//') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.endsWith('.lock'),
    'sourceRef must be a canonical Git branch or tag ref',
  );

const UniqueRunTargetIdsSchema = z
  .array(IdSchema)
  .min(1)
  .max(1_000)
  .refine((values) => new Set(values).size === values.length, 'Run Target IDs must be unique');

export const CreateVerificationScheduleRequestSchema = z
  .object({
    id: IdSchema.optional(),
    repositoryBindingId: IdSchema,
    name: z.string().trim().min(1).max(200),
    sourceRef: GitSourceRefSchema,
    environmentId: IdSchema,
    runTargetIds: UniqueRunTargetIdsSchema,
    intervalSeconds: z.number().int().min(300).max(31_536_000),
    freshnessTargetSeconds: z.number().int().min(300).max(31_536_000),
    maxRuntimeSeconds: z.number().int().min(60).max(86_400).default(3_600),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    startsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((value) => value.freshnessTargetSeconds >= value.intervalSeconds, {
    message: 'freshnessTargetSeconds cannot be shorter than intervalSeconds',
    path: ['freshnessTargetSeconds'],
  });

export const UpdateVerificationScheduleRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    sourceRef: GitSourceRefSchema.optional(),
    environmentId: IdSchema.optional(),
    runTargetIds: UniqueRunTargetIdsSchema.optional(),
    intervalSeconds: z.number().int().min(300).max(31_536_000).optional(),
    freshnessTargetSeconds: z.number().int().min(300).max(31_536_000).optional(),
    maxRuntimeSeconds: z.number().int().min(60).max(86_400).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedVersion'),
    'At least one schedule field must be updated',
  );

export const ResumeVerificationScheduleRequestSchema = z
  .object({ nextDueAt: z.string().datetime({ offset: true }).optional() })
  .strict();

export const CreateVerificationRunnerRequestSchema = z
  .object({
    id: IdSchema.optional(),
    name: z.string().trim().min(1).max(200),
    scheduleIds: z
      .array(IdSchema)
      .min(1)
      .max(500)
      .refine((values) => new Set(values).size === values.length, 'Schedule IDs must be unique'),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const RunnerClaimRequestSchema = z.object({}).strict();

export const RunnerLeaseRequestSchema = z.object({ leaseId: IdSchema }).strict();

export const CompleteVerificationJobRequestSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('verified'), leaseId: IdSchema, buildId: IdSchema }).strict(),
  z
    .object({
      outcome: z.literal('runner-failed'),
      leaseId: IdSchema,
      failureCode: z.enum([
        'checkout-failed',
        'environment-unavailable',
        'runner-error',
        'timed-out',
      ]),
      failureDetail: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

export const CancelVerificationJobRequestSchema = z
  .object({ reason: z.string().trim().min(3).max(2_000) })
  .strict();

export const CreateSceneRevisionRequestSchema = z
  .object({
    scene: SceneSchema,
    privacy: PrivacySummarySchema,
  })
  .strict();

export const CreateReviewRequestSchema = z.object({ review: ReviewSchema }).strict();

export const AddReviewCommentRequestSchema = z
  .object({
    id: IdSchema.optional(),
    body: z.string().trim().min(1).max(20_000),
    stepId: IdSchema.optional(),
    stateId: IdSchema.optional(),
    region: NormalizedRectSchema.optional(),
  })
  .strict();

const ReviewAssigneeIdsSchema = z
  .array(IdSchema)
  .max(1_000)
  .refine((values) => new Set(values).size === values.length, 'Review assignees must be unique');

export const SetReviewAssigneesRequestSchema = z
  .object({
    expectedAssignedTo: ReviewAssigneeIdsSchema,
    assignedTo: ReviewAssigneeIdsSchema,
  })
  .strict();

export const SetReviewCommentResolutionRequestSchema = z
  .object({
    status: z.enum(['open', 'resolved']),
    expectedResolvedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const AddReviewDecisionRequestSchema = z
  .object({
    id: IdSchema.optional(),
    changeId: IdSchema.optional(),
    decision: z.enum(['approve', 'reject', 'dismiss', 'request-change']),
    reason: z.string().trim().max(5_000).optional(),
  })
  .strict();

export const RecordVerificationRunRequestSchema = z.object({ run: RunArtifactSchema }).strict();

export const RecordVerificationBuildRequestSchema = z
  .object({ build: BuildArtifactSchema })
  .strict();

export const RecordVerificationBaselineRequestSchema = z
  .object({ baseline: BaselineSchema })
  .strict();

export const ReleaseCandidateSceneSchema = ReleaseSceneSchema.omit({
  baselineId: true,
  carriedForward: true,
});

export const ReleaseCandidateSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    artifactVersion: z.literal(ARTIFACT_VERSION),
    id: IdSchema,
    kind: z.literal('release'),
    projectId: IdSchema,
    createdAt: z.string().datetime({ offset: true }),
    producer: ProducerSchema,
    channelId: IdSchema,
    sourceBuildId: IdSchema,
    scenes: z.array(ReleaseCandidateSceneSchema).min(1).max(100_000),
    manifestHash: Sha256Schema,
    publication: ReleasePublicationSchema,
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
    }
  });

export const RecordReviewApprovalRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: IdSchema.optional(),
      kind: z.enum(['visual', 'editorial']),
      decision: z.enum(['approved', 'rejected']),
      baselineId: IdSchema,
      reason: z.string().trim().max(5_000).optional(),
    })
    .strict(),
  z
    .object({
      id: IdSchema.optional(),
      kind: z.literal('release'),
      decision: z.enum(['approved', 'rejected']),
      release: ReleaseCandidateSchema,
      reason: z.string().trim().max(5_000).optional(),
    })
    .strict(),
]);

export const ArtifactObjectSpecSchema = z
  .object({
    sha256: Sha256Schema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
    mediaType: z.enum(ALLOWED_OBJECT_MEDIA_TYPES),
  })
  .strict();

const ArtifactObjectSpecListSchema = z
  .array(ArtifactObjectSpecSchema)
  .min(1)
  .max(10_000)
  .superRefine((objects, context) => {
    const identities = new Set<string>();
    for (const [index, object] of objects.entries()) {
      const identity = artifactObjectIdentity(object.sha256, object.mediaType);
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          message: 'Object hash and media type pairs must be unique',
          path: [index, 'mediaType'],
        });
      }
      identities.add(identity);
    }
  });

export const BeginUploadRequestSchema = z
  .object({
    objects: ArtifactObjectSpecListSchema,
  })
  .strict();

export const FinalizeUploadRequestSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.literal(1),
        objects: ArtifactObjectSpecListSchema,
        metadata: z.record(z.string(), JsonValueSchema).default({}),
      })
      .strict(),
  })
  .strict();

export const CreateChannelRequestSchema = z
  .object({
    id: IdSchema.optional(),
    slug: SlugSchema,
    name: z.string().min(1).max(200),
    kind: z.enum(['public-catalog', 'private-portal', 'docs-sync', 'embed', 'static', 'offline']),
    policy: ChannelPolicySchema,
    webhookIds: z.array(IdSchema).max(100).default([]),
  })
  .strict();

export const CreateCustomDomainRequestSchema = z
  .object({
    id: IdSchema.optional(),
    hostname: z.string().trim().min(1).max(1_024),
  })
  .strict();

export const CustomDomainMutationRequestSchema = z
  .object({ expectedVersion: z.number().int().positive().max(2_147_483_646) })
  .strict();

export const PromoteReleaseRequestSchema = z
  .object({
    release: ReleaseCandidateSchema,
    expectedCurrentReleaseId: IdSchema.optional(),
    evidence: z
      .object({
        releaseApprovalId: IdSchema,
        scenes: z
          .array(
            z
              .object({
                sceneId: IdSchema,
                runId: IdSchema,
                baselineId: IdSchema.optional(),
                visualApprovalId: IdSchema.optional(),
                editorialApprovalId: IdSchema.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const sceneIds = new Set<string>();
    for (const [index, evidence] of request.evidence.scenes.entries()) {
      if (sceneIds.has(evidence.sceneId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate Scene evidence: ${evidence.sceneId}`,
          path: ['evidence', 'scenes', index, 'sceneId'],
        });
      }
      sceneIds.add(evidence.sceneId);
    }
  });

export const RollbackReleaseRequestSchema = z
  .object({
    targetReleaseId: IdSchema,
    expectedCurrentReleaseId: IdSchema,
    reason: z.string().trim().min(10).max(5_000),
  })
  .strict();

export const AnalyticsEventRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    releaseId: IdSchema,
    sceneId: IdSchema,
    stepId: IdSchema.optional(),
    type: z.enum(['view', 'start', 'step', 'complete', 'cta', 'error']),
    occurredAt: z.string().datetime({ offset: true }),
    anonymousId: z.string().min(8).max(500).optional(),
    sessionId: z.string().min(8).max(500).optional(),
    properties: z
      .record(z.string(), z.union([z.boolean(), z.number().finite(), z.string().max(500)]))
      .default({}),
  })
  .strict();

export const AnalyticsFunnelQuerySchema = z
  .object({
    releaseId: IdSchema.optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const CtaSubmissionRequestSchema = z
  .object({
    id: IdSchema.optional(),
    releaseId: IdSchema,
    sceneId: IdSchema,
    stepId: IdSchema,
    /** Optional only for deprecated Step.cta publications compiled before CTA identity shipped. */
    ctaId: IdSchema.optional(),
    webhookId: IdSchema,
    fields: z
      .record(z.string().max(100), z.union([z.boolean(), z.string().max(5_000)]))
      .refine((fields) => Object.keys(fields).length <= 20, 'At most 20 fields are allowed'),
  })
  .strict();

export const OidcExchangeRequestSchema = z
  .object({
    workspaceId: IdSchema,
    projectId: IdSchema,
    oidcToken: z.string().min(100).max(20_000),
  })
  .strict();

export type BeginUploadRequest = z.infer<typeof BeginUploadRequestSchema>;
export type PromoteReleaseRequest = z.infer<typeof PromoteReleaseRequestSchema>;
