import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalJsonHash, sha256, stableStringify } from '@scenebook/core';

import {
  ChannelPolicySchema,
  ApprovalSchema,
  BaselineSchema,
  BuildArtifactSchema,
  PrivacySummarySchema,
  ReleaseSchema,
  ReviewCommentSchema,
  ReviewDecisionSchema,
  ReviewSchema,
  RunArtifactSchema,
  SceneSchema,
  type Release,
  type Review,
} from '@scenebook/schema';

import type {
  AnalyticsAggregateRow,
  AnalyticsEventRecord,
  ArtifactObjectRecord,
  ArtifactUploadRecord,
  AuditEventRecord,
  ChannelRecord,
  CustomDomainRecord,
  GitHubInstallationBindingRecord,
  GitHubSourceChangeRecord,
  HostedPublicationRecord,
  CtaSubmissionRecord,
  IdentityApiTokenRecord,
  IdentityScope,
  PortalGrantRecord,
  PrivateShareLinkRecord,
  PublicationLoginHandoffRecord,
  ProjectRecord,
  ReleaseRecord,
  ReleasePromotionEvidence,
  RepositoryBinding,
  ReviewApprovalRecord,
  ReviewRecord,
  SceneRevisionRecord,
  VerificationBaselineRecord,
  VerificationBuildRecord,
  VerificationExecutionContract,
  VerificationJobRecord,
  VerificationJobResult,
  VerificationRunRecord,
  VerificationRunnerRecord,
  VerificationScheduleRecord,
  WebhookDeliveryRecord,
  WorkspaceRecord,
  WorkspaceMembershipRecord,
  WorkspaceRole,
  UserRecord,
  UserSessionRecord,
  EvidenceObjectLifecycleRecord,
  EvidenceRetentionClaimRecord,
  EvidenceRetentionEventRecord,
  EvidenceRetentionEvaluationRecord,
  WorkspaceArtifactInventoryRecord,
} from './domain.js';
import type { StoredObject } from './object-store.js';
import { artifactObjectIdentity } from './object-identity.js';
import {
  RepositoryCapacityError,
  RepositoryConflictError,
  RepositoryNotFoundError,
  type ControlPlaneRepository,
  type DatabasePoolOwner,
} from './repository.js';
import { nextScheduleOccurrence, scheduledJobIdentity } from './schedule.js';
import {
  CustomDomainProvisioningRecordSchema,
  normalizeCustomDomainHostname,
} from './custom-domains.js';

type ReviewComment = Review['comments'][number];
type ReviewDecision = Review['decisions'][number];

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  created_at: Date;
}

interface ProjectRow extends WorkspaceRow {
  workspace_id: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
  disabled_at: Date | null;
}

interface MembershipRow {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

interface IdentityApiTokenRow {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  token_hash: string;
  scopes: IdentityScope[];
  project_id: string | null;
  channel_id: string | null;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

interface UserSessionRow {
  id: string;
  user_id: string;
  source_token_id: string;
  workspace_id: string;
  scopes: IdentityScope[];
  project_id: string | null;
  channel_id: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface PortalGrantRow {
  id: string;
  workspace_id: string;
  project_id: string;
  channel_id: string;
  subject_kind: 'user' | 'link';
  subject_user_id: string | null;
  subject_label: string | null;
  permission: 'view' | 'review';
  created_by: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface PrivateShareLinkRow {
  id: string;
  grant_id: string;
  token_hash: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface PublicationLoginHandoffRow {
  id: string;
  token_hash: string;
  workspace_id: string;
  project_id: string;
  channel_id: string;
  user_id: string;
  source_session_id: string;
  grant_id: string;
  audience_origin: string;
  return_path: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

interface BindingRow {
  id: string;
  workspace_id: string;
  project_id: string;
  repository: string;
  workflow_ref_pattern: string;
  created_at: Date;
}

interface GitHubInstallationBindingRow {
  id: string;
  workspace_id: string;
  project_id: string;
  repository_binding_id: string;
  installation_id: string;
  github_repository_id: string;
  default_branch: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  version: number;
  revoked_at: Date | null;
}

interface GitHubSourceChangeRow {
  id: string;
  workspace_id: string;
  project_id: string;
  installation_binding_id: string;
  idempotency_key: string;
  request_hash: string;
  status: GitHubSourceChangeRecord['status'];
  source_path: string;
  base_commit_sha: string;
  base_blob_sha: string;
  patch_hash: string;
  branch_name: string;
  title: string;
  create_review_issue: boolean;
  evidence_binding_json: Readonly<Record<string, string>>;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  attempts: number;
  lease_id: string | null;
  lease_expires_at: Date | null;
  head_commit_sha: string | null;
  head_blob_sha: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  issue_number: number | null;
  issue_url: string | null;
  failure_code: string | null;
}

interface VerificationScheduleRow {
  id: string;
  workspace_id: string;
  project_id: string;
  repository_binding_id: string;
  name: string;
  source_ref: string;
  environment_id: string;
  run_target_ids: unknown;
  interval_seconds: number;
  freshness_target_seconds: number;
  max_runtime_seconds: number;
  max_attempts: number;
  status: VerificationScheduleRecord['status'];
  next_due_at: Date;
  last_enqueued_at: Date | null;
  last_completed_at: Date | null;
  last_successful_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  version: number;
}

interface VerificationScheduleWithRepositoryRow extends VerificationScheduleRow {
  repository: string;
}

interface VerificationRunnerRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  token_hash: string;
  schedule_ids: string[];
  created_by: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

interface VerificationJobRow {
  id: string;
  workspace_id: string;
  project_id: string;
  schedule_id: string;
  reason: VerificationJobRecord['reason'];
  state: VerificationJobRecord['state'];
  idempotency_key: string;
  execution_json: unknown;
  due_at: Date;
  available_at: Date;
  attempts: number;
  max_attempts: number;
  lease_id: string | null;
  leased_by_runner_id: string | null;
  leased_at: Date | null;
  lease_expires_at: Date | null;
  deadline_at: Date | null;
  result_json: unknown | null;
  result_hash: string | null;
  created_by: string;
  created_at: Date;
  completed_at: Date | null;
}

interface SceneRevisionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  scene_id: string;
  revision_hash: string;
  source_json: unknown;
  privacy_json: unknown;
  created_by: string;
  created_at: Date;
}

interface ReviewRow {
  id: string;
  workspace_id: string;
  project_id: string;
  review_json: unknown;
  status: string;
  change_state: string;
  opened_at: Date;
  closed_at: Date | null;
}

interface CommentRow {
  id: string;
  review_id: string;
  actor_id: string;
  body: string;
  step_id: string | null;
  state_id: string | null;
  region_json: unknown;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Date;
}

interface DecisionRow {
  id: string;
  review_id: string;
  change_id: string | null;
  actor_id: string;
  decision: ReviewDecision['decision'];
  reason: string | null;
  created_at: Date;
}

interface RunEvidenceRow {
  id: string;
  workspace_id: string;
  project_id: string;
  scene_id: string;
  source_revision: string;
  artifact_hash: string;
  artifact_json: unknown;
  idempotency_key: string;
  request_hash: string;
  recorded_by: string;
  recorded_at: Date;
}

interface BuildEvidenceRow {
  id: string;
  workspace_id: string;
  project_id: string;
  artifact_hash: string;
  artifact_json: unknown;
  idempotency_key: string;
  request_hash: string;
  recorded_by: string;
  recorded_at: Date;
}

interface BaselineEvidenceRow extends RunEvidenceRow {
  source_run_id: string;
  source_run_hash: string;
}

interface ApprovalEvidenceRow {
  id: string;
  workspace_id: string;
  project_id: string;
  subject_kind: ReviewApprovalRecord['subjectKind'];
  subject_id: string;
  subject_revision: string;
  artifact_hash: string;
  approval_json: unknown;
  idempotency_key: string;
  request_hash: string;
  recorded_by: string;
  recorded_at: Date;
}

interface UploadRow {
  id: string;
  workspace_id: string;
  project_id: string;
  repository: string;
  commit_sha: string;
  git_ref: string;
  status: ArtifactUploadRecord['status'];
  idempotency_key: string;
  request_hash: string;
  manifest_hash: string | null;
  created_at: Date;
  expires_at: Date;
  finalized_at: Date | null;
  gc_claim_id: string | null;
  gc_claimed_until: Date | null;
  gc_completed_at: Date | null;
}

interface UploadUsageRow {
  upload_count: string | number;
  byte_count: string | number;
}

interface ObjectRow {
  upload_id: string;
  sha256: string;
  byte_length: string | number;
  media_type: string;
  status: ArtifactObjectRecord['status'];
  staging_key: string | null;
  final_key: string | null;
}

interface EvidenceObjectLifecycleRow {
  workspace_id: string;
  sha256: string;
  media_type: string;
  byte_length: string | number;
  retention_class: EvidenceObjectLifecycleRecord['retentionClass'];
  status: EvidenceObjectLifecycleRecord['status'];
  first_finalized_at: Date;
  last_finalized_at: Date;
  claim_id: string | null;
  claimed_until: Date | null;
  deleted_at: Date | null;
  project_ids?: string[];
}

interface ChannelRow {
  id: string;
  workspace_id: string;
  project_id: string;
  slug: string;
  name: string;
  kind: ChannelRecord['kind'];
  policy_json: unknown;
  webhook_ids: unknown;
  analytics_token_hash: string;
  current_release_id: string | null;
  sequence: string | number;
  created_at: Date;
}

interface CustomDomainRow {
  id: string;
  workspace_id: string;
  project_id: string;
  channel_id: string;
  hostname: string;
  routing_target: string;
  status: CustomDomainRecord['status'];
  dns_status: CustomDomainRecord['dnsProof']['status'];
  challenge_name: string;
  challenge_value: string;
  dns_checked_at: Date | null;
  dns_verified_at: Date | null;
  provisioning_json: unknown | null;
  version: string | number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
}

interface ReleaseRow {
  workspace_id: string;
  project_id: string;
  status: Release['status'];
  release_json: unknown;
  idempotency_key: string;
  request_hash: string;
  evidence_json: unknown | null;
}

interface HostedPublicationRow {
  workspace_record: WorkspaceRow;
  project_record: ProjectRow;
  channel_record: ChannelRow;
  release_record: ReleaseRow | null;
  custom_domain_record: CustomDomainRow | null;
}

interface AnalyticsAggregateDatabaseRow {
  scene_id: string | null;
  step_id: string | null;
  event_type: AnalyticsEventRecord['type'];
  scene_grouped: number;
  step_grouped: number;
  event_count: string | number;
  unique_subject_count: string | number;
}

const ReleasePromotionEvidenceSchema: z.ZodType<ReleasePromotionEvidence> = z
  .object({
    buildId: z.string(),
    buildArtifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
    releaseCandidateHash: z.string().regex(/^[a-f0-9]{64}$/u),
    releaseApprovalId: z.string(),
    releaseApprovalArtifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
    artifactUploadId: z.string(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    scenes: z.array(
      z
        .object({
          sceneId: z.string(),
          runId: z.string(),
          runArtifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
          baselineId: z.string().optional(),
          baselineArtifactHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
          visualApprovalId: z.string().optional(),
          visualApprovalArtifactHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
          editorialApprovalId: z.string().optional(),
          editorialApprovalArtifactHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

interface CtaRow {
  id: string;
  workspace_id: string;
  project_id: string;
  channel_id: string;
  release_id: string;
  scene_id: string;
  step_id: string | null;
  cta_id: string;
  webhook_id: string;
  payload_hash: string;
  encrypted_payload: string;
  created_at: Date;
}

interface DeliveryRow {
  id: string;
  submission_id: string;
  webhook_id: string;
  status: WebhookDeliveryRecord['status'];
  attempts: number;
  next_attempt_at: Date;
  last_status: number | null;
  last_error: string | null;
}

interface AuditRow {
  sequence: string | number;
  id: string;
  workspace_id: string | null;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  request_id: string;
  ip_hash: string | null;
  metadata_json: Record<string, unknown>;
  created_at: Date;
}

function workspace(row: WorkspaceRow): WorkspaceRecord {
  return { id: row.id, slug: row.slug, name: row.name, createdAt: iso(row.created_at) };
}

function project(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    createdAt: iso(row.created_at),
  };
}

function user(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: iso(row.created_at),
    ...(row.disabled_at ? { disabledAt: iso(row.disabled_at) } : {}),
  };
}

function membership(row: MembershipRow): WorkspaceMembershipRecord {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function identityApiToken(row: IdentityApiTokenRow): IdentityApiTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    name: row.name,
    tokenHash: row.token_hash,
    scopes: row.scopes,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    ...(row.last_used_at ? { lastUsedAt: iso(row.last_used_at) } : {}),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function userSession(row: UserSessionRow): UserSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    sourceTokenId: row.source_token_id,
    workspaceId: row.workspace_id,
    scopes: row.scopes,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function portalGrant(row: PortalGrantRow): PortalGrantRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    channelId: row.channel_id,
    subject:
      row.subject_kind === 'user'
        ? { kind: 'user', userId: row.subject_user_id! }
        : { kind: 'link', label: row.subject_label! },
    permission: row.permission,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function privateShareLink(row: PrivateShareLinkRow): PrivateShareLinkRecord {
  return {
    id: row.id,
    grantId: row.grant_id,
    tokenHash: row.token_hash,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function publicationLoginHandoff(row: PublicationLoginHandoffRow): PublicationLoginHandoffRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    channelId: row.channel_id,
    userId: row.user_id,
    sourceSessionId: row.source_session_id,
    grantId: row.grant_id,
    audienceOrigin: row.audience_origin,
    returnPath: row.return_path,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
  };
}

function binding(row: BindingRow): RepositoryBinding {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    repository: row.repository,
    workflowRefPattern: row.workflow_ref_pattern,
    createdAt: iso(row.created_at),
  };
}

function githubInstallationBinding(
  row: GitHubInstallationBindingRow,
): GitHubInstallationBindingRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    repositoryBindingId: row.repository_binding_id,
    installationId: row.installation_id,
    githubRepositoryId: row.github_repository_id,
    defaultBranch: row.default_branch,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function githubSourceChange(row: GitHubSourceChangeRow): GitHubSourceChangeRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    installationBindingId: row.installation_binding_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    path: row.source_path,
    baseCommitSha: row.base_commit_sha,
    baseBlobSha: row.base_blob_sha,
    patchHash: row.patch_hash,
    branch: row.branch_name,
    title: row.title,
    createReviewIssue: row.create_review_issue,
    evidenceBinding: row.evidence_binding_json,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    attempts: row.attempts,
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.head_commit_sha ? { headCommitSha: row.head_commit_sha } : {}),
    ...(row.head_blob_sha ? { headBlobSha: row.head_blob_sha } : {}),
    ...(row.pull_request_number ? { pullRequestNumber: row.pull_request_number } : {}),
    ...(row.pull_request_url ? { pullRequestUrl: row.pull_request_url } : {}),
    ...(row.issue_number ? { issueNumber: row.issue_number } : {}),
    ...(row.issue_url ? { issueUrl: row.issue_url } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
  };
}

const VerificationExecutionContractSchema: z.ZodType<VerificationExecutionContract> = z
  .object({
    protocolVersion: z.literal(1),
    repository: z.string(),
    sourceRef: z.string(),
    environmentId: z.string(),
    runTargetIds: z.array(z.string()),
    expectedBuildId: z.string(),
  })
  .strict();

const VerificationJobResultSchema: z.ZodType<VerificationJobResult> = z.discriminatedUnion(
  'outcome',
  [
    z
      .object({
        outcome: z.literal('verified'),
        buildId: z.string(),
        buildArtifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
        buildStatus: z.enum(['passed', 'changed', 'failed', 'blocked', 'cancelled']),
      })
      .strict(),
    z
      .object({
        outcome: z.literal('runner-failed'),
        failureCode: z.enum([
          'checkout-failed',
          'environment-unavailable',
          'runner-error',
          'timed-out',
          'lease-expired',
          'cancelled',
        ]),
        failureDetail: z.string(),
      })
      .strict(),
  ],
);

function verificationSchedule(row: VerificationScheduleRow): VerificationScheduleRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    repositoryBindingId: row.repository_binding_id,
    name: row.name,
    sourceRef: row.source_ref,
    environmentId: row.environment_id,
    runTargetIds: z.array(z.string()).parse(row.run_target_ids),
    intervalSeconds: row.interval_seconds,
    freshnessTargetSeconds: row.freshness_target_seconds,
    maxRuntimeSeconds: row.max_runtime_seconds,
    maxAttempts: row.max_attempts,
    status: row.status,
    nextDueAt: iso(row.next_due_at),
    ...(row.last_enqueued_at ? { lastEnqueuedAt: iso(row.last_enqueued_at) } : {}),
    ...(row.last_completed_at ? { lastCompletedAt: iso(row.last_completed_at) } : {}),
    ...(row.last_successful_at ? { lastSuccessfulAt: iso(row.last_successful_at) } : {}),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  };
}

function verificationRunner(row: VerificationRunnerRow): VerificationRunnerRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    tokenHash: row.token_hash,
    scheduleIds: row.schedule_ids,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    ...(row.last_seen_at ? { lastSeenAt: iso(row.last_seen_at) } : {}),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function verificationJob(row: VerificationJobRow): VerificationJobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    scheduleId: row.schedule_id,
    reason: row.reason,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    execution: VerificationExecutionContractSchema.parse(row.execution_json),
    dueAt: iso(row.due_at),
    availableAt: iso(row.available_at),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.leased_by_runner_id ? { leasedByRunnerId: row.leased_by_runner_id } : {}),
    ...(row.leased_at ? { leasedAt: iso(row.leased_at) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.deadline_at ? { deadlineAt: iso(row.deadline_at) } : {}),
    ...(row.result_json ? { result: VerificationJobResultSchema.parse(row.result_json) } : {}),
    ...(row.result_hash ? { resultHash: row.result_hash } : {}),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
  };
}

function revision(row: SceneRevisionRow): SceneRevisionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    revision: row.revision_hash,
    scene: SceneSchema.parse(row.source_json),
    privacy: PrivacySummarySchema.parse(row.privacy_json),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function objectRecord(row: ObjectRow): ArtifactObjectRecord {
  return {
    uploadId: row.upload_id,
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
    mediaType: row.media_type,
    status: row.status,
    ...(row.staging_key ? { stagingKey: row.staging_key } : {}),
    ...(row.final_key ? { finalKey: row.final_key } : {}),
  };
}

function evidenceObjectLifecycle(row: EvidenceObjectLifecycleRow): EvidenceObjectLifecycleRecord {
  return {
    workspaceId: row.workspace_id,
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
    mediaType: row.media_type,
    retentionClass: row.retention_class,
    status: row.status,
    firstFinalizedAt: iso(row.first_finalized_at),
    lastFinalizedAt: iso(row.last_finalized_at),
    ...(row.claim_id ? { claimId: row.claim_id } : {}),
    ...(row.claimed_until ? { claimedUntil: iso(row.claimed_until) } : {}),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}),
  };
}

function evidenceRetentionClaim(row: EvidenceObjectLifecycleRow): EvidenceRetentionClaimRecord {
  const value = evidenceObjectLifecycle(row);
  if (
    (value.status !== 'claimed' && value.status !== 'deleting') ||
    !value.claimId ||
    !value.claimedUntil
  ) {
    throw new Error('Evidence retention claim row is incomplete');
  }
  return {
    ...value,
    status: value.status,
    claimId: value.claimId,
    claimedUntil: value.claimedUntil,
    projectIds: [...new Set(row.project_ids ?? [])].sort(),
  };
}

function upload(row: UploadRow, objects: readonly ObjectRow[]): ArtifactUploadRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    repository: row.repository,
    commit: row.commit_sha,
    ref: row.git_ref,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    ...(row.manifest_hash ? { manifestHash: row.manifest_hash } : {}),
    objects: objects.map(objectRecord),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    ...(row.finalized_at ? { finalizedAt: iso(row.finalized_at) } : {}),
  };
}

function channel(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    policy: ChannelPolicySchema.parse(row.policy_json),
    webhookIds: z.array(z.string()).parse(row.webhook_ids),
    analyticsTokenHash: row.analytics_token_hash,
    ...(row.current_release_id ? { currentReleaseId: row.current_release_id } : {}),
    sequence: Number(row.sequence),
    createdAt: iso(row.created_at),
  };
}

function customDomain(row: CustomDomainRow): CustomDomainRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    channelId: row.channel_id,
    hostname: row.hostname,
    routingTarget: row.routing_target,
    status: row.status,
    dnsProof: {
      status: row.dns_status,
      challengeName: row.challenge_name,
      challengeValue: row.challenge_value,
      ...(row.dns_checked_at ? { checkedAt: iso(row.dns_checked_at) } : {}),
      ...(row.dns_verified_at ? { verifiedAt: iso(row.dns_verified_at) } : {}),
    },
    ...(row.provisioning_json
      ? { provisioning: CustomDomainProvisioningRecordSchema.parse(row.provisioning_json) }
      : {}),
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.removed_at ? { removedAt: iso(row.removed_at) } : {}),
  };
}

function release(row: ReleaseRow): ReleaseRecord {
  return {
    release: ReleaseSchema.parse({ ...(row.release_json as object), status: row.status }),
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    ...(row.evidence_json
      ? { promotionEvidence: ReleasePromotionEvidenceSchema.parse(row.evidence_json) }
      : {}),
  };
}

function reviewComment(row: CommentRow): ReviewComment {
  return {
    id: row.id,
    actorId: row.actor_id,
    body: row.body,
    createdAt: iso(row.created_at),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.state_id ? { stateId: row.state_id } : {}),
    ...(row.region_json ? { region: row.region_json as ReviewComment['region'] } : {}),
    ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
  };
}

function reviewDecision(row: DecisionRow): ReviewDecision {
  return {
    id: row.id,
    actorId: row.actor_id,
    decision: row.decision,
    createdAt: iso(row.created_at),
    ...(row.change_id ? { changeId: row.change_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

function verificationRun(row: RunEvidenceRow): VerificationRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    sourceRevision: row.source_revision,
    artifactHash: row.artifact_hash,
    run: RunArtifactSchema.parse(row.artifact_json),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    recordedBy: row.recorded_by,
    recordedAt: iso(row.recorded_at),
  };
}

function verificationBuild(row: BuildEvidenceRow): VerificationBuildRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    artifactHash: row.artifact_hash,
    build: BuildArtifactSchema.parse(row.artifact_json),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    recordedBy: row.recorded_by,
    recordedAt: iso(row.recorded_at),
  };
}

function verificationBaseline(row: BaselineEvidenceRow): VerificationBaselineRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    sourceRevision: row.source_revision,
    sourceRunId: row.source_run_id,
    sourceRunHash: row.source_run_hash,
    artifactHash: row.artifact_hash,
    baseline: BaselineSchema.parse(row.artifact_json),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    recordedBy: row.recorded_by,
    recordedAt: iso(row.recorded_at),
  };
}

function reviewApproval(row: ApprovalEvidenceRow): ReviewApprovalRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectRevision: row.subject_revision,
    artifactHash: row.artifact_hash,
    approval: ApprovalSchema.parse(row.approval_json),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    recordedBy: row.recorded_by,
    recordedAt: iso(row.recorded_at),
  };
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    if (began) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function structuredAssetIdentities(value: unknown): readonly {
  readonly sha256: string;
  readonly mediaType: string;
}[] {
  const values = new Map<string, { sha256: string; mediaType: string }>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.sha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(record.sha256) &&
      typeof record.mediaType === 'string'
    ) {
      values.set(`${record.sha256}\0${record.mediaType}`, {
        sha256: record.sha256,
        mediaType: record.mediaType,
      });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...values.values()];
}

export class PostgresControlPlaneRepository implements ControlPlaneRepository, DatabasePoolOwner {
  readonly pool: Pool;

  constructor(databaseUrlOrPool: string | Pool) {
    this.pool =
      typeof databaseUrlOrPool === 'string'
        ? new Pool({
            connectionString: databaseUrlOrPool,
            max: 20,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
          })
        : databaseUrlOrPool;
  }

  async health(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createWorkspace(input: {
    id: string;
    slug: string;
    name: string;
    now: string;
  }): Promise<WorkspaceRecord> {
    const inserted = await this.pool.query<WorkspaceRow>(
      'INSERT INTO workspaces(id, slug, name, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING *',
      [input.id, input.slug, input.name, input.now],
    );
    const row =
      inserted.rows[0] ??
      (await this.pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id=$1', [input.id]))
        .rows[0];
    if (!row) throw new Error('Could not create Workspace');
    if (row.slug !== input.slug || row.name !== input.name)
      throw new RepositoryConflictError('Workspace idempotency conflict');
    return workspace(row);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    const row = (await this.pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id=$1', [id]))
      .rows[0];
    return row ? workspace(row) : undefined;
  }

  async createProject(input: {
    id: string;
    workspaceId: string;
    slug: string;
    name: string;
    now: string;
  }): Promise<ProjectRecord> {
    const inserted = await this.pool.query<ProjectRow>(
      'INSERT INTO projects(id,workspace_id,slug,name,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING *',
      [input.id, input.workspaceId, input.slug, input.name, input.now],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<ProjectRow>(
          'SELECT * FROM projects WHERE id=$1 AND workspace_id=$2',
          [input.id, input.workspaceId],
        )
      ).rows[0];
    if (!row) throw new Error('Could not create Project');
    if (
      row.slug !== input.slug ||
      row.name !== input.name ||
      row.workspace_id !== input.workspaceId
    ) {
      throw new RepositoryConflictError('Project idempotency conflict');
    }
    return project(row);
  }

  async getProject(workspaceId: string, id: string): Promise<ProjectRecord | undefined> {
    const row = (
      await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE workspace_id=$1 AND id=$2', [
        workspaceId,
        id,
      ])
    ).rows[0];
    return row ? project(row) : undefined;
  }

  async listProjects(workspaceId: string, limit: number): Promise<readonly ProjectRecord[]> {
    const result = await this.pool.query<ProjectRow>(
      'SELECT * FROM projects WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',
      [workspaceId, limit],
    );
    return result.rows.map(project);
  }

  async createUser(input: {
    id: string;
    email: string;
    displayName: string;
    now: string;
  }): Promise<UserRecord> {
    const inserted = await this.pool.query<UserRow>(
      `INSERT INTO identity_users(id,email,display_name,created_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [input.id, input.email, input.displayName, input.now],
    );
    const row =
      inserted.rows[0] ??
      (await this.pool.query<UserRow>('SELECT * FROM identity_users WHERE id=$1', [input.id]))
        .rows[0];
    if (!row) throw new Error('Could not create User');
    if (row.email !== input.email || row.display_name !== input.displayName)
      throw new RepositoryConflictError('User idempotency conflict');
    return user(row);
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const row = (await this.pool.query<UserRow>('SELECT * FROM identity_users WHERE id=$1', [id]))
      .rows[0];
    return row ? user(row) : undefined;
  }

  async disableUser(id: string, now: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE identity_users SET disabled_at=$2 WHERE id=$1 AND disabled_at IS NULL',
      [id, now],
    );
    return result.rowCount === 1;
  }

  async putWorkspaceMembership(
    input: WorkspaceMembershipRecord,
  ): Promise<WorkspaceMembershipRecord> {
    const row = (
      await this.pool.query<MembershipRow>(
        `INSERT INTO workspace_memberships(workspace_id,user_id,role,created_at,updated_at,revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workspace_id,user_id) DO UPDATE
         SET role=EXCLUDED.role,updated_at=EXCLUDED.updated_at,revoked_at=EXCLUDED.revoked_at
         RETURNING *`,
        [
          input.workspaceId,
          input.userId,
          input.role,
          input.createdAt,
          input.updatedAt,
          input.revokedAt ?? null,
        ],
      )
    ).rows[0];
    if (!row) throw new Error('Could not write Workspace membership');
    return membership(row);
  }

  async getWorkspaceMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembershipRecord | undefined> {
    const row = (
      await this.pool.query<MembershipRow>(
        'SELECT * FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
        [workspaceId, userId],
      )
    ).rows[0];
    return row ? membership(row) : undefined;
  }

  async listWorkspaceMemberships(
    workspaceId: string,
    limit: number,
  ): Promise<readonly WorkspaceMembershipRecord[]> {
    const rows = await this.pool.query<MembershipRow>(
      `SELECT * FROM workspace_memberships WHERE workspace_id=$1
       ORDER BY created_at DESC,user_id DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return rows.rows.map(membership);
  }

  async revokeWorkspaceMembership(
    workspaceId: string,
    userId: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE workspace_memberships SET revoked_at=$3,updated_at=$3
       WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [workspaceId, userId, now],
    );
    return result.rowCount === 1;
  }

  async createIdentityApiToken(input: IdentityApiTokenRecord): Promise<IdentityApiTokenRecord> {
    const inserted = await this.pool.query<IdentityApiTokenRow>(
      `INSERT INTO identity_api_tokens(
         id,user_id,workspace_id,name,token_hash,scopes,project_id,channel_id,
         created_at,expires_at,last_used_at,revoked_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.id,
        input.userId,
        input.workspaceId,
        input.name,
        input.tokenHash,
        input.scopes,
        input.projectId ?? null,
        input.channelId ?? null,
        input.createdAt,
        input.expiresAt,
        input.lastUsedAt ?? null,
        input.revokedAt ?? null,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<IdentityApiTokenRow>(
          'SELECT * FROM identity_api_tokens WHERE id=$1',
          [input.id],
        )
      ).rows[0];
    if (!row) throw new Error('Could not create API token');
    const value = identityApiToken(row);
    if (stableStringify(value) !== stableStringify(input))
      throw new RepositoryConflictError('API token idempotency conflict');
    return value;
  }

  async getIdentityApiToken(id: string): Promise<IdentityApiTokenRecord | undefined> {
    const row = (
      await this.pool.query<IdentityApiTokenRow>('SELECT * FROM identity_api_tokens WHERE id=$1', [
        id,
      ])
    ).rows[0];
    return row ? identityApiToken(row) : undefined;
  }

  async listIdentityApiTokens(
    workspaceId: string,
    userId: string,
    limit: number,
  ): Promise<readonly IdentityApiTokenRecord[]> {
    const rows = await this.pool.query<IdentityApiTokenRow>(
      `SELECT * FROM identity_api_tokens WHERE workspace_id=$1 AND user_id=$2
       ORDER BY created_at DESC,id DESC LIMIT $3`,
      [workspaceId, userId, limit],
    );
    return rows.rows.map(identityApiToken);
  }

  async touchIdentityApiToken(id: string, now: string): Promise<void> {
    await this.pool.query(
      'UPDATE identity_api_tokens SET last_used_at=$2 WHERE id=$1 AND revoked_at IS NULL',
      [id, now],
    );
  }

  async revokeIdentityApiToken(id: string, userId: string, now: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE identity_api_tokens SET revoked_at=$3
       WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [id, userId, now],
    );
    return result.rowCount === 1;
  }

  async createUserSession(input: UserSessionRecord): Promise<UserSessionRecord> {
    const inserted = await this.pool.query<UserSessionRow>(
      `INSERT INTO user_sessions(
         id,user_id,source_token_id,workspace_id,scopes,project_id,channel_id,
         created_at,expires_at,revoked_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.id,
        input.userId,
        input.sourceTokenId,
        input.workspaceId,
        input.scopes,
        input.projectId ?? null,
        input.channelId ?? null,
        input.createdAt,
        input.expiresAt,
        input.revokedAt ?? null,
      ],
    );
    const row =
      inserted.rows[0] ??
      (await this.pool.query<UserSessionRow>('SELECT * FROM user_sessions WHERE id=$1', [input.id]))
        .rows[0];
    if (!row) throw new Error('Could not create Session');
    const value = userSession(row);
    if (stableStringify(value) !== stableStringify(input))
      throw new RepositoryConflictError('Session idempotency conflict');
    return value;
  }

  async getUserSession(id: string): Promise<UserSessionRecord | undefined> {
    const row = (
      await this.pool.query<UserSessionRow>('SELECT * FROM user_sessions WHERE id=$1', [id])
    ).rows[0];
    return row ? userSession(row) : undefined;
  }

  async revokeUserSession(id: string, userId: string, now: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE user_sessions SET revoked_at=$3 WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',
      [id, userId, now],
    );
    return result.rowCount === 1;
  }

  async createPortalGrant(input: PortalGrantRecord): Promise<PortalGrantRecord> {
    const channelValue = await this.getChannel(input.workspaceId, input.projectId, input.channelId);
    if (!channelValue || channelValue.kind !== 'private-portal')
      throw new RepositoryNotFoundError('Private portal Channel not found');
    const inserted = await this.pool.query<PortalGrantRow>(
      `INSERT INTO portal_grants(
         id,workspace_id,project_id,channel_id,subject_kind,subject_user_id,subject_label,
         permission,created_by,created_at,expires_at,revoked_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.channelId,
        input.subject.kind,
        input.subject.kind === 'user' ? input.subject.userId : null,
        input.subject.kind === 'link' ? input.subject.label : null,
        input.permission,
        input.createdBy,
        input.createdAt,
        input.expiresAt,
        input.revokedAt ?? null,
      ],
    );
    const row =
      inserted.rows[0] ??
      (await this.pool.query<PortalGrantRow>('SELECT * FROM portal_grants WHERE id=$1', [input.id]))
        .rows[0];
    if (!row) throw new Error('Could not create portal grant');
    const value = portalGrant(row);
    if (stableStringify(value) !== stableStringify(input))
      throw new RepositoryConflictError('Portal grant idempotency conflict');
    return value;
  }

  async getPortalGrant(id: string): Promise<PortalGrantRecord | undefined> {
    const row = (
      await this.pool.query<PortalGrantRow>('SELECT * FROM portal_grants WHERE id=$1', [id])
    ).rows[0];
    return row ? portalGrant(row) : undefined;
  }

  async listPortalGrants(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly PortalGrantRecord[]> {
    const rows = await this.pool.query<PortalGrantRow>(
      `SELECT * FROM portal_grants
       WHERE workspace_id=$1 AND project_id=$2 AND channel_id=$3
       ORDER BY created_at DESC,id DESC LIMIT $4`,
      [workspaceId, projectId, channelId, limit],
    );
    return rows.rows.map(portalGrant);
  }

  async findPortalGrantForUser(
    workspaceId: string,
    projectId: string,
    channelId: string,
    userId: string,
    now: string,
  ): Promise<PortalGrantRecord | undefined> {
    const row = (
      await this.pool.query<PortalGrantRow>(
        `SELECT * FROM portal_grants
         WHERE workspace_id=$1 AND project_id=$2 AND channel_id=$3
           AND subject_kind='user' AND subject_user_id=$4
           AND revoked_at IS NULL AND expires_at>$5
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [workspaceId, projectId, channelId, userId, now],
      )
    ).rows[0];
    return row ? portalGrant(row) : undefined;
  }

  async revokePortalGrant(id: string, workspaceId: string, now: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE portal_grants SET revoked_at=$3
       WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL`,
      [id, workspaceId, now],
    );
    return result.rowCount === 1;
  }

  async createPrivateShareLink(input: PrivateShareLinkRecord): Promise<PrivateShareLinkRecord> {
    const inserted = await this.pool.query<PrivateShareLinkRow>(
      `INSERT INTO private_share_links(
         id,grant_id,token_hash,created_by,created_at,expires_at,revoked_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.id,
        input.grantId,
        input.tokenHash,
        input.createdBy,
        input.createdAt,
        input.expiresAt,
        input.revokedAt ?? null,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<PrivateShareLinkRow>(
          'SELECT * FROM private_share_links WHERE id=$1',
          [input.id],
        )
      ).rows[0];
    if (!row) throw new Error('Could not create private share link');
    const value = privateShareLink(row);
    if (stableStringify(value) !== stableStringify(input))
      throw new RepositoryConflictError('Private share idempotency conflict');
    return value;
  }

  async getPrivateShareLink(id: string): Promise<PrivateShareLinkRecord | undefined> {
    const row = (
      await this.pool.query<PrivateShareLinkRow>('SELECT * FROM private_share_links WHERE id=$1', [
        id,
      ])
    ).rows[0];
    return row ? privateShareLink(row) : undefined;
  }

  async listPrivateShareLinks(
    grantId: string,
    limit: number,
  ): Promise<readonly PrivateShareLinkRecord[]> {
    const rows = await this.pool.query<PrivateShareLinkRow>(
      `SELECT * FROM private_share_links WHERE grant_id=$1
       ORDER BY created_at DESC,id DESC LIMIT $2`,
      [grantId, limit],
    );
    return rows.rows.map(privateShareLink);
  }

  async revokePrivateShareLink(id: string, now: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE private_share_links SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL',
      [id, now],
    );
    return result.rowCount === 1;
  }

  async createPublicationLoginHandoff(
    input: PublicationLoginHandoffRecord,
  ): Promise<PublicationLoginHandoffRecord> {
    await this.pool.query(
      `DELETE FROM publication_login_handoffs
       WHERE expires_at < $1::timestamptz - interval '1 day'
          OR consumed_at < $1::timestamptz - interval '1 day'`,
      [input.createdAt],
    );
    const inserted = await this.pool.query<PublicationLoginHandoffRow>(
      `INSERT INTO publication_login_handoffs(
         id,token_hash,workspace_id,project_id,channel_id,user_id,source_session_id,
         grant_id,audience_origin,return_path,created_at,expires_at,consumed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.id,
        input.tokenHash,
        input.workspaceId,
        input.projectId,
        input.channelId,
        input.userId,
        input.sourceSessionId,
        input.grantId,
        input.audienceOrigin,
        input.returnPath,
        input.createdAt,
        input.expiresAt,
        input.consumedAt ?? null,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<PublicationLoginHandoffRow>(
          'SELECT * FROM publication_login_handoffs WHERE id=$1',
          [input.id],
        )
      ).rows[0];
    if (!row) throw new Error('Could not create publication login handoff');
    const value = publicationLoginHandoff(row);
    if (stableStringify(value) !== stableStringify(input)) {
      throw new RepositoryConflictError('Publication login handoff idempotency conflict');
    }
    return value;
  }

  async getActivePublicationLoginHandoff(input: {
    tokenHash: string;
    audienceOrigin: string;
    now: string;
  }): Promise<PublicationLoginHandoffRecord | undefined> {
    const row = (
      await this.pool.query<PublicationLoginHandoffRow>(
        `SELECT * FROM publication_login_handoffs
         WHERE token_hash=$1 AND audience_origin=$2
           AND consumed_at IS NULL AND expires_at>$3`,
        [input.tokenHash, input.audienceOrigin, input.now],
      )
    ).rows[0];
    return row ? publicationLoginHandoff(row) : undefined;
  }

  async consumePublicationLoginHandoffAndAudit(
    input: { tokenHash: string; audienceOrigin: string; now: string },
    audit: AuditEventRecord,
  ): Promise<PublicationLoginHandoffRecord | undefined> {
    return transaction(this.pool, async (client) => {
      const row = (
        await client.query<PublicationLoginHandoffRow>(
          `UPDATE publication_login_handoffs SET consumed_at=$3
           WHERE token_hash=$1 AND audience_origin=$2
             AND consumed_at IS NULL AND expires_at>$3
           RETURNING *`,
          [input.tokenHash, input.audienceOrigin, input.now],
        )
      ).rows[0];
      if (!row) return undefined;
      await client.query(
        `INSERT INTO audit_events(
           id,workspace_id,actor_id,action,target_type,target_id,request_id,ip_hash,metadata_json,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          audit.id,
          audit.workspaceId ?? null,
          audit.actorId,
          audit.action,
          audit.targetType,
          audit.targetId,
          audit.requestId,
          audit.ipHash ?? null,
          audit.metadata,
          audit.createdAt,
        ],
      );
      return publicationLoginHandoff(row);
    });
  }

  async bindRepository(input: RepositoryBinding): Promise<RepositoryBinding> {
    const result = await this.pool.query<BindingRow>(
      `INSERT INTO repository_bindings(id,workspace_id,project_id,repository,workflow_ref_pattern,created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id,repository) DO UPDATE SET workflow_ref_pattern=EXCLUDED.workflow_ref_pattern
       RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.repository,
        input.workflowRefPattern,
        input.createdAt,
      ],
    );
    return binding(result.rows[0]!);
  }

  async getRepositoryBinding(
    workspaceId: string,
    projectId: string,
    repository: string,
  ): Promise<RepositoryBinding | undefined> {
    const row = (
      await this.pool.query<BindingRow>(
        'SELECT * FROM repository_bindings WHERE workspace_id=$1 AND project_id=$2 AND lower(repository)=lower($3)',
        [workspaceId, projectId, repository],
      )
    ).rows[0];
    return row ? binding(row) : undefined;
  }

  async getRepositoryBindingById(
    workspaceId: string,
    projectId: string,
    bindingId: string,
  ): Promise<RepositoryBinding | undefined> {
    const row = (
      await this.pool.query<BindingRow>(
        'SELECT * FROM repository_bindings WHERE workspace_id=$1 AND project_id=$2 AND id=$3',
        [workspaceId, projectId, bindingId],
      )
    ).rows[0];
    return row ? binding(row) : undefined;
  }

  async listRepositoryBindings(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly RepositoryBinding[]> {
    const rows = await this.pool.query<BindingRow>(
      `SELECT * FROM repository_bindings WHERE workspace_id=$1 AND project_id=$2
       ORDER BY created_at DESC,id DESC LIMIT $3`,
      [workspaceId, projectId, limit],
    );
    return rows.rows.map(binding);
  }

  async putGitHubInstallationBinding(
    input: GitHubInstallationBindingRecord,
  ): Promise<GitHubInstallationBindingRecord> {
    const inserted = await this.pool.query<GitHubInstallationBindingRow>(
      `INSERT INTO github_installation_bindings(
         id,workspace_id,project_id,repository_binding_id,installation_id,github_repository_id,
         default_branch,created_by,created_at,updated_at,version,revoked_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.repositoryBindingId,
        input.installationId,
        input.githubRepositoryId,
        input.defaultBranch,
        input.createdBy,
        input.createdAt,
        input.updatedAt,
        input.version,
        input.revokedAt ?? null,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<GitHubInstallationBindingRow>(
          `SELECT * FROM github_installation_bindings
           WHERE workspace_id=$1 AND project_id=$2 AND repository_binding_id=$3
             AND revoked_at IS NULL`,
          [input.workspaceId, input.projectId, input.repositoryBindingId],
        )
      ).rows[0];
    if (!row) throw new Error('Could not bind GitHub App installation');
    const value = githubInstallationBinding(row);
    if (
      value.installationId !== input.installationId ||
      value.githubRepositoryId !== input.githubRepositoryId ||
      value.defaultBranch !== input.defaultBranch
    ) {
      throw new RepositoryConflictError(
        'Repository already has an active GitHub installation binding',
      );
    }
    return value;
  }

  async getGitHubInstallationBinding(
    workspaceId: string,
    projectId: string,
    bindingId: string,
  ): Promise<GitHubInstallationBindingRecord | undefined> {
    const row = (
      await this.pool.query<GitHubInstallationBindingRow>(
        `SELECT * FROM github_installation_bindings
         WHERE id=$1 AND workspace_id=$2 AND project_id=$3`,
        [bindingId, workspaceId, projectId],
      )
    ).rows[0];
    return row ? githubInstallationBinding(row) : undefined;
  }

  async getActiveGitHubInstallationBindingForRepository(
    workspaceId: string,
    projectId: string,
    repositoryBindingId: string,
  ): Promise<GitHubInstallationBindingRecord | undefined> {
    const row = (
      await this.pool.query<GitHubInstallationBindingRow>(
        `SELECT * FROM github_installation_bindings
         WHERE workspace_id=$1 AND project_id=$2 AND repository_binding_id=$3
           AND revoked_at IS NULL`,
        [workspaceId, projectId, repositoryBindingId],
      )
    ).rows[0];
    return row ? githubInstallationBinding(row) : undefined;
  }

  async withGitHubCheckRunLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
    if (lockKey.length < 1 || lockKey.length > 1_000)
      throw new RepositoryConflictError('GitHub Check Run lock key is invalid');
    // Check identity is deliberately NUL-delimited so component boundaries cannot collide.
    // PostgreSQL text rejects NUL bytes, so bind a full cryptographic digest and let PostgreSQL
    // map that stable ASCII identity onto its advisory-lock keyspace.
    const advisoryIdentity = sha256(lockKey);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        advisoryIdentity,
      ]);
      const result = await operation();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listGitHubInstallationBindings(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly GitHubInstallationBindingRecord[]> {
    const rows = await this.pool.query<GitHubInstallationBindingRow>(
      `SELECT * FROM github_installation_bindings
       WHERE workspace_id=$1 AND project_id=$2
       ORDER BY created_at DESC,id DESC LIMIT $3`,
      [workspaceId, projectId, limit],
    );
    return rows.rows.map(githubInstallationBinding);
  }

  async revokeGitHubInstallationBinding(input: {
    workspaceId: string;
    projectId: string;
    bindingId: string;
    expectedVersion: number;
    now: string;
  }): Promise<GitHubInstallationBindingRecord> {
    const row = (
      await this.pool.query<GitHubInstallationBindingRow>(
        `UPDATE github_installation_bindings
         SET revoked_at=$5,updated_at=$5,version=version+1
         WHERE id=$1 AND workspace_id=$2 AND project_id=$3 AND version=$4 AND revoked_at IS NULL
         RETURNING *`,
        [input.bindingId, input.workspaceId, input.projectId, input.expectedVersion, input.now],
      )
    ).rows[0];
    if (row) return githubInstallationBinding(row);
    const existing = await this.getGitHubInstallationBinding(
      input.workspaceId,
      input.projectId,
      input.bindingId,
    );
    if (!existing) throw new RepositoryNotFoundError('GitHub installation binding not found');
    throw new RepositoryConflictError('GitHub installation binding version conflict');
  }

  async claimGitHubSourceChange(input: {
    record: GitHubSourceChangeRecord;
    leaseId: string;
    leaseDurationMs: number;
  }): Promise<{ readonly record: GitHubSourceChangeRecord; readonly claimed: boolean }> {
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1)
      throw new RepositoryConflictError('GitHub source change lease duration is invalid');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO github_source_changes(
           id,workspace_id,project_id,installation_binding_id,idempotency_key,request_hash,status,
           source_path,base_commit_sha,base_blob_sha,patch_hash,branch_name,title,
           create_review_issue,evidence_binding_json,created_by,created_at,updated_at,attempts
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         -- The caller's stable change ID and tenant idempotency key are both unique. Concurrent
         -- replicas can therefore meet either constraint first; ignore either conflict, then lock
         -- and validate the tenant-scoped idempotency row below.
         ON CONFLICT DO NOTHING`,
        [
          input.record.id,
          input.record.workspaceId,
          input.record.projectId,
          input.record.installationBindingId,
          input.record.idempotencyKey,
          input.record.requestHash,
          input.record.status,
          input.record.path,
          input.record.baseCommitSha,
          input.record.baseBlobSha,
          input.record.patchHash,
          input.record.branch,
          input.record.title,
          input.record.createReviewIssue,
          input.record.evidenceBinding,
          input.record.createdBy,
          input.record.createdAt,
          input.record.updatedAt,
          input.record.attempts,
        ],
      );
      const selected = (
        await client.query<GitHubSourceChangeRow>(
          `SELECT * FROM github_source_changes
           WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.record.workspaceId, input.record.idempotencyKey],
        )
      ).rows[0];
      if (!selected) throw new Error('Could not claim GitHub source change');
      if (selected.request_hash !== input.record.requestHash)
        throw new RepositoryConflictError('GitHub source change idempotency conflict');
      if (selected.status === 'succeeded') {
        await client.query('COMMIT');
        return { record: githubSourceChange(selected), claimed: false };
      }
      const claimed = (
        await client.query<GitHubSourceChangeRow>(
          `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
           UPDATE github_source_changes AS change
           SET status='pending',attempts=attempts+1,lease_id=$2,
               lease_expires_at=db_clock.now + ($3::bigint * interval '1 millisecond'),
               failure_code=NULL,updated_at=db_clock.now
           FROM db_clock
           WHERE change.id=$1
             AND (change.lease_expires_at IS NULL OR change.lease_expires_at<=db_clock.now)
           RETURNING change.*`,
          [selected.id, input.leaseId, input.leaseDurationMs],
        )
      ).rows[0];
      if (!claimed) {
        await client.query('COMMIT');
        return { record: githubSourceChange(selected), claimed: false };
      }
      await client.query('COMMIT');
      return { record: githubSourceChange(claimed), claimed: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async renewGitHubSourceChangeLease(input: {
    workspaceId: string;
    projectId: string;
    changeId: string;
    leaseId: string;
    leaseDurationMs: number;
  }): Promise<GitHubSourceChangeRecord> {
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1)
      throw new RepositoryConflictError('GitHub source change lease duration is invalid');
    const row = (
      await this.pool.query<GitHubSourceChangeRow>(
        `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE github_source_changes AS change
            SET lease_expires_at=db_clock.now + ($5::bigint * interval '1 millisecond'),
                updated_at=db_clock.now
           FROM db_clock
          WHERE change.id=$1 AND change.workspace_id=$2 AND change.project_id=$3
            AND change.lease_id=$4 AND change.status='pending'
            AND change.lease_expires_at>db_clock.now
          RETURNING change.*`,
        [input.changeId, input.workspaceId, input.projectId, input.leaseId, input.leaseDurationMs],
      )
    ).rows[0];
    if (!row) throw new RepositoryConflictError('GitHub source change lease was lost');
    return githubSourceChange(row);
  }

  async completeGitHubSourceChange(input: {
    workspaceId: string;
    projectId: string;
    changeId: string;
    leaseId: string;
    result: Pick<
      GitHubSourceChangeRecord,
      | 'headCommitSha'
      | 'headBlobSha'
      | 'pullRequestNumber'
      | 'pullRequestUrl'
      | 'issueNumber'
      | 'issueUrl'
    >;
  }): Promise<GitHubSourceChangeRecord> {
    const row = (
      await this.pool.query<GitHubSourceChangeRow>(
        `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE github_source_changes AS change
         SET status='succeeded',lease_id=NULL,lease_expires_at=NULL,failure_code=NULL,
             updated_at=db_clock.now,head_commit_sha=$5,head_blob_sha=$6,
             pull_request_number=$7,pull_request_url=$8,issue_number=$9,issue_url=$10
         FROM db_clock
         WHERE change.id=$1 AND change.workspace_id=$2 AND change.project_id=$3
           AND change.lease_id=$4 AND change.status='pending'
           AND change.lease_expires_at>db_clock.now
         RETURNING change.*`,
        [
          input.changeId,
          input.workspaceId,
          input.projectId,
          input.leaseId,
          input.result.headCommitSha,
          input.result.headBlobSha,
          input.result.pullRequestNumber,
          input.result.pullRequestUrl,
          input.result.issueNumber ?? null,
          input.result.issueUrl ?? null,
        ],
      )
    ).rows[0];
    if (!row) throw new RepositoryConflictError('GitHub source change lease was lost');
    return githubSourceChange(row);
  }

  async failGitHubSourceChange(input: {
    workspaceId: string;
    projectId: string;
    changeId: string;
    leaseId: string;
    failureCode: string;
  }): Promise<GitHubSourceChangeRecord> {
    const row = (
      await this.pool.query<GitHubSourceChangeRow>(
        `WITH db_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE github_source_changes AS change
         SET status='failed',lease_id=NULL,lease_expires_at=NULL,failure_code=$5,
             updated_at=db_clock.now
         FROM db_clock
         WHERE change.id=$1 AND change.workspace_id=$2 AND change.project_id=$3
           AND change.lease_id=$4 AND change.status='pending'
           AND change.lease_expires_at>db_clock.now
         RETURNING change.*`,
        [input.changeId, input.workspaceId, input.projectId, input.leaseId, input.failureCode],
      )
    ).rows[0];
    if (!row) throw new RepositoryConflictError('GitHub source change lease was lost');
    return githubSourceChange(row);
  }

  async getGitHubSourceChange(
    workspaceId: string,
    projectId: string,
    changeId: string,
  ): Promise<GitHubSourceChangeRecord | undefined> {
    const row = (
      await this.pool.query<GitHubSourceChangeRow>(
        `SELECT * FROM github_source_changes
         WHERE id=$1 AND workspace_id=$2 AND project_id=$3`,
        [changeId, workspaceId, projectId],
      )
    ).rows[0];
    return row ? githubSourceChange(row) : undefined;
  }

  async createVerificationSchedule(
    input: VerificationScheduleRecord,
  ): Promise<VerificationScheduleRecord> {
    const inserted = await this.pool.query<VerificationScheduleRow>(
      `INSERT INTO verification_schedules(
         id,workspace_id,project_id,repository_binding_id,name,source_ref,environment_id,
         run_target_ids,interval_seconds,freshness_target_seconds,max_runtime_seconds,max_attempts,
         status,next_due_at,last_enqueued_at,last_completed_at,last_successful_at,created_by,
         created_at,updated_at,version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.repositoryBindingId,
        input.name,
        input.sourceRef,
        input.environmentId,
        JSON.stringify(input.runTargetIds),
        input.intervalSeconds,
        input.freshnessTargetSeconds,
        input.maxRuntimeSeconds,
        input.maxAttempts,
        input.status,
        input.nextDueAt,
        input.lastEnqueuedAt ?? null,
        input.lastCompletedAt ?? null,
        input.lastSuccessfulAt ?? null,
        input.createdBy,
        input.createdAt,
        input.updatedAt,
        input.version,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<VerificationScheduleRow>(
          'SELECT * FROM verification_schedules WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
          [input.id, input.workspaceId, input.projectId],
        )
      ).rows[0];
    if (!row) throw new RepositoryConflictError('Verification Schedule id is already in use');
    const value = verificationSchedule(row);
    if (stableStringify(value) !== stableStringify(input))
      throw new RepositoryConflictError('Verification Schedule idempotency conflict');
    return value;
  }

  async getVerificationSchedule(
    workspaceId: string,
    projectId: string,
    scheduleId: string,
  ): Promise<VerificationScheduleRecord | undefined> {
    const row = (
      await this.pool.query<VerificationScheduleRow>(
        'SELECT * FROM verification_schedules WHERE workspace_id=$1 AND project_id=$2 AND id=$3',
        [workspaceId, projectId, scheduleId],
      )
    ).rows[0];
    return row ? verificationSchedule(row) : undefined;
  }

  async listVerificationSchedules(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationScheduleRecord[]> {
    const rows = await this.pool.query<VerificationScheduleRow>(
      `SELECT * FROM verification_schedules WHERE workspace_id=$1 AND project_id=$2
       ORDER BY next_due_at,id LIMIT $3`,
      [workspaceId, projectId, limit],
    );
    return rows.rows.map(verificationSchedule);
  }

  async updateVerificationSchedule(
    input: Parameters<ControlPlaneRepository['updateVerificationSchedule']>[0],
  ): Promise<VerificationScheduleRecord> {
    const result = await this.pool.query<VerificationScheduleRow>(
      `UPDATE verification_schedules SET
         name=COALESCE($5,name),source_ref=COALESCE($6,source_ref),
         environment_id=COALESCE($7,environment_id),
         run_target_ids=COALESCE($8::jsonb,run_target_ids),
         interval_seconds=COALESCE($9,interval_seconds),
         freshness_target_seconds=COALESCE($10,freshness_target_seconds),
         max_runtime_seconds=COALESCE($11,max_runtime_seconds),
         max_attempts=COALESCE($12,max_attempts),updated_at=$13,version=version+1
       WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND version=$4 RETURNING *`,
      [
        input.workspaceId,
        input.projectId,
        input.scheduleId,
        input.expectedVersion,
        input.patch.name ?? null,
        input.patch.sourceRef ?? null,
        input.patch.environmentId ?? null,
        input.patch.runTargetIds ? JSON.stringify(input.patch.runTargetIds) : null,
        input.patch.intervalSeconds ?? null,
        input.patch.freshnessTargetSeconds ?? null,
        input.patch.maxRuntimeSeconds ?? null,
        input.patch.maxAttempts ?? null,
        input.now,
      ],
    );
    const row = result.rows[0];
    if (row) return verificationSchedule(row);
    const exists = await this.getVerificationSchedule(
      input.workspaceId,
      input.projectId,
      input.scheduleId,
    );
    if (!exists) throw new RepositoryNotFoundError('Verification Schedule not found');
    throw new RepositoryConflictError('Verification Schedule version conflict');
  }

  async setVerificationScheduleStatus(
    input: Parameters<ControlPlaneRepository['setVerificationScheduleStatus']>[0],
  ): Promise<VerificationScheduleRecord> {
    const result = await this.pool.query<VerificationScheduleRow>(
      `UPDATE verification_schedules SET status=$4,next_due_at=COALESCE($5,next_due_at),
         updated_at=$6,version=version+1
       WHERE workspace_id=$1 AND project_id=$2 AND id=$3
         AND (status<>$4 OR ($5::timestamptz IS NOT NULL AND next_due_at<>$5)) RETURNING *`,
      [
        input.workspaceId,
        input.projectId,
        input.scheduleId,
        input.status,
        input.nextDueAt ?? null,
        input.now,
      ],
    );
    if (result.rows[0]) return verificationSchedule(result.rows[0]);
    const current = await this.getVerificationSchedule(
      input.workspaceId,
      input.projectId,
      input.scheduleId,
    );
    if (!current) throw new RepositoryNotFoundError('Verification Schedule not found');
    return current;
  }

  async materializeDueVerificationJobs(
    now: string,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]> {
    return transaction(this.pool, async (client) => {
      const due = await client.query<VerificationScheduleWithRepositoryRow>(
        `SELECT s.*,b.repository FROM verification_schedules s
         JOIN repository_bindings b ON b.id=s.repository_binding_id
           AND b.workspace_id=s.workspace_id AND b.project_id=s.project_id
         WHERE s.status='active' AND s.next_due_at <= $1
         ORDER BY s.next_due_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      const jobs: VerificationJobRecord[] = [];
      for (const row of due.rows) {
        const schedule = verificationSchedule(row);
        const identity = scheduledJobIdentity(schedule.id, schedule.nextDueAt);
        const execution: VerificationExecutionContract = {
          protocolVersion: 1,
          repository: row.repository,
          sourceRef: schedule.sourceRef,
          environmentId: schedule.environmentId,
          runTargetIds: schedule.runTargetIds,
          expectedBuildId: identity.expectedBuildId,
        };
        const inserted = await client.query<VerificationJobRow>(
          `INSERT INTO verification_jobs(
             id,workspace_id,project_id,schedule_id,reason,state,idempotency_key,execution_json,
             due_at,available_at,attempts,max_attempts,created_by,created_at
           ) VALUES ($1,$2,$3,$4,'schedule','queued',$5,$6,$7,$8,0,$9,'scheduler',$8)
           ON CONFLICT (schedule_id,idempotency_key) DO NOTHING RETURNING *`,
          [
            identity.id,
            schedule.workspaceId,
            schedule.projectId,
            schedule.id,
            identity.idempotencyKey,
            execution,
            schedule.nextDueAt,
            now,
            schedule.maxAttempts,
          ],
        );
        if (inserted.rows[0]) jobs.push(verificationJob(inserted.rows[0]));
        await client.query(
          `UPDATE verification_schedules SET next_due_at=$2,last_enqueued_at=$3,
             updated_at=$3,version=version+1 WHERE id=$1`,
          [
            schedule.id,
            nextScheduleOccurrence(schedule.nextDueAt, now, schedule.intervalSeconds),
            now,
          ],
        );
      }
      return jobs;
    });
  }

  async createManualVerificationJob(input: VerificationJobRecord): Promise<VerificationJobRecord> {
    if (
      input.reason !== 'manual' ||
      input.state !== 'queued' ||
      input.attempts !== 0 ||
      !input.idempotencyKey.startsWith('manual:')
    )
      throw new RepositoryConflictError('Invalid manual Verification Job initial state');
    return transaction(this.pool, async (client) => {
      const scheduleRow = (
        await client.query<VerificationScheduleWithRepositoryRow>(
          `SELECT s.*,b.repository FROM verification_schedules s
           JOIN repository_bindings b ON b.id=s.repository_binding_id
             AND b.workspace_id=s.workspace_id AND b.project_id=s.project_id
           WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.id=$3 FOR SHARE OF s`,
          [input.workspaceId, input.projectId, input.scheduleId],
        )
      ).rows[0];
      if (!scheduleRow) throw new RepositoryNotFoundError('Verification Schedule not found');
      const schedule = verificationSchedule(scheduleRow);
      const expectedExecution = {
        protocolVersion: 1 as const,
        repository: scheduleRow.repository,
        sourceRef: schedule.sourceRef,
        environmentId: schedule.environmentId,
        runTargetIds: schedule.runTargetIds,
        expectedBuildId: input.execution.expectedBuildId,
      };
      if (stableStringify(input.execution) !== stableStringify(expectedExecution))
        throw new RepositoryConflictError('Manual Job execution contract does not match Schedule');
      const inserted = await client.query<VerificationJobRow>(
        `INSERT INTO verification_jobs(
           id,workspace_id,project_id,schedule_id,reason,state,idempotency_key,execution_json,
           due_at,available_at,attempts,max_attempts,created_by,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (schedule_id,idempotency_key) DO NOTHING RETURNING *`,
        [
          input.id,
          input.workspaceId,
          input.projectId,
          input.scheduleId,
          input.reason,
          input.state,
          input.idempotencyKey,
          input.execution,
          input.dueAt,
          input.availableAt,
          input.attempts,
          input.maxAttempts,
          input.createdBy,
          input.createdAt,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query<VerificationJobRow>(
            'SELECT * FROM verification_jobs WHERE schedule_id=$1 AND idempotency_key=$2',
            [input.scheduleId, input.idempotencyKey],
          )
        ).rows[0];
      if (!row) throw new Error('Could not create manual Verification Job');
      const value = verificationJob(row);
      if (stableStringify(value) !== stableStringify(input))
        throw new RepositoryConflictError('Manual Verification Job idempotency conflict');
      return value;
    });
  }

  async getVerificationJob(
    workspaceId: string,
    projectId: string,
    jobId: string,
  ): Promise<VerificationJobRecord | undefined> {
    const row = (
      await this.pool.query<VerificationJobRow>(
        'SELECT * FROM verification_jobs WHERE workspace_id=$1 AND project_id=$2 AND id=$3',
        [workspaceId, projectId, jobId],
      )
    ).rows[0];
    return row ? verificationJob(row) : undefined;
  }

  async listVerificationJobs(
    workspaceId: string,
    projectId: string,
    scheduleId: string | undefined,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]> {
    const rows = await this.pool.query<VerificationJobRow>(
      `SELECT * FROM verification_jobs WHERE workspace_id=$1 AND project_id=$2
         AND ($3::text IS NULL OR schedule_id=$3)
       ORDER BY created_at DESC,id DESC LIMIT $4`,
      [workspaceId, projectId, scheduleId ?? null, limit],
    );
    return rows.rows.map(verificationJob);
  }

  async cancelVerificationJob(
    input: Parameters<ControlPlaneRepository['cancelVerificationJob']>[0],
  ): Promise<VerificationJobRecord> {
    return transaction(this.pool, async (client) => {
      const currentRow = (
        await client.query<VerificationJobRow>(
          `SELECT * FROM verification_jobs WHERE workspace_id=$1 AND project_id=$2 AND id=$3
           FOR UPDATE`,
          [input.workspaceId, input.projectId, input.jobId],
        )
      ).rows[0];
      if (!currentRow) throw new RepositoryNotFoundError('Verification Job not found');
      const current = verificationJob(currentRow);
      if (current.state === 'cancelled' && current.resultHash === input.resultHash) return current;
      if (['succeeded', 'failed', 'cancelled'].includes(current.state))
        throw new RepositoryConflictError('Verification Job is already terminal');
      const row = (
        await client.query<VerificationJobRow>(
          `UPDATE verification_jobs SET state='cancelled',result_json=$2,result_hash=$3,
             completed_at=$4 WHERE id=$1 RETURNING *`,
          [input.jobId, input.result, input.resultHash, input.now],
        )
      ).rows[0]!;
      return verificationJob(row);
    });
  }

  async requeueExpiredVerificationJobs(
    now: string,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]> {
    return transaction(this.pool, async (client) => {
      const expired = await client.query<VerificationJobRow>(
        `SELECT * FROM verification_jobs WHERE state='leased' AND lease_expires_at <= $1
         ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      const values: VerificationJobRecord[] = [];
      for (const row of expired.rows) {
        let updated: VerificationJobRow;
        if (row.attempts >= row.max_attempts) {
          const result: VerificationJobResult = {
            outcome: 'runner-failed',
            failureCode: 'lease-expired',
            failureDetail: 'Runner lease expired after the maximum number of attempts',
          };
          updated = (
            await client.query<VerificationJobRow>(
              `UPDATE verification_jobs SET state='failed',result_json=$2,result_hash=$3,
                 completed_at=$4 WHERE id=$1 RETURNING *`,
              [row.id, result, canonicalJsonHash(result), now],
            )
          ).rows[0]!;
        } else {
          updated = (
            await client.query<VerificationJobRow>(
              `UPDATE verification_jobs SET state='queued',available_at=$2,lease_id=NULL,
                 leased_by_runner_id=NULL,leased_at=NULL,lease_expires_at=NULL,deadline_at=NULL
               WHERE id=$1 RETURNING *`,
              [row.id, now],
            )
          ).rows[0]!;
        }
        values.push(verificationJob(updated));
      }
      return values;
    });
  }

  async createVerificationRunner(
    input: VerificationRunnerRecord,
  ): Promise<VerificationRunnerRecord> {
    return transaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO verification_runners(
           id,workspace_id,project_id,name,token_hash,created_by,created_at,expires_at,
           last_seen_at,revoked_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [
          input.id,
          input.workspaceId,
          input.projectId,
          input.name,
          input.tokenHash,
          input.createdBy,
          input.createdAt,
          input.expiresAt,
          input.lastSeenAt ?? null,
          input.revokedAt ?? null,
        ],
      );
      if (inserted.rowCount === 1) {
        for (const scheduleId of input.scheduleIds) {
          await client.query(
            `INSERT INTO verification_runner_schedules(runner_id,workspace_id,project_id,schedule_id)
             VALUES ($1,$2,$3,$4)`,
            [input.id, input.workspaceId, input.projectId, scheduleId],
          );
        }
      }
      const row = (
        await client.query<VerificationRunnerRow>(
          `SELECT r.*,
             COALESCE(array_agg(rs.schedule_id ORDER BY rs.schedule_id)
               FILTER (WHERE rs.schedule_id IS NOT NULL),ARRAY[]::text[]) AS schedule_ids
           FROM verification_runners r
           LEFT JOIN verification_runner_schedules rs ON rs.runner_id=r.id
           WHERE r.id=$1 GROUP BY r.id`,
          [input.id],
        )
      ).rows[0];
      if (!row) throw new Error('Could not create Verification Runner');
      const value = verificationRunner(row);
      const comparableInput = { ...input, scheduleIds: [...input.scheduleIds].sort() };
      if (stableStringify(value) !== stableStringify(comparableInput))
        throw new RepositoryConflictError('Verification Runner idempotency conflict');
      return value;
    });
  }

  async getVerificationRunner(id: string): Promise<VerificationRunnerRecord | undefined> {
    const row = (
      await this.pool.query<VerificationRunnerRow>(
        `SELECT r.*,
           COALESCE(array_agg(rs.schedule_id ORDER BY rs.schedule_id)
             FILTER (WHERE rs.schedule_id IS NOT NULL),ARRAY[]::text[]) AS schedule_ids
         FROM verification_runners r
         LEFT JOIN verification_runner_schedules rs ON rs.runner_id=r.id
         WHERE r.id=$1 GROUP BY r.id`,
        [id],
      )
    ).rows[0];
    return row ? verificationRunner(row) : undefined;
  }

  async listVerificationRunners(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationRunnerRecord[]> {
    const rows = await this.pool.query<VerificationRunnerRow>(
      `SELECT r.*,
         COALESCE(array_agg(rs.schedule_id ORDER BY rs.schedule_id)
           FILTER (WHERE rs.schedule_id IS NOT NULL),ARRAY[]::text[]) AS schedule_ids
       FROM verification_runners r
       LEFT JOIN verification_runner_schedules rs ON rs.runner_id=r.id
       WHERE r.workspace_id=$1 AND r.project_id=$2 GROUP BY r.id
       ORDER BY r.created_at DESC,r.id DESC LIMIT $3`,
      [workspaceId, projectId, limit],
    );
    return rows.rows.map(verificationRunner);
  }

  async rotateVerificationRunnerToken(
    input: Parameters<ControlPlaneRepository['rotateVerificationRunnerToken']>[0],
  ): Promise<VerificationRunnerRecord> {
    const result = await this.pool.query(
      `UPDATE verification_runners SET token_hash=$4
       WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING id`,
      [input.workspaceId, input.projectId, input.runnerId, input.tokenHash],
    );
    if (result.rowCount !== 1) {
      const existing = await this.getVerificationRunner(input.runnerId);
      if (!existing) throw new RepositoryNotFoundError('Verification Runner not found');
      throw new RepositoryConflictError('Revoked Verification Runner cannot be rotated');
    }
    return (await this.getVerificationRunner(input.runnerId))!;
  }

  async revokeVerificationRunner(
    input: Parameters<ControlPlaneRepository['revokeVerificationRunner']>[0],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE verification_runners SET revoked_at=$4
       WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revoked_at IS NULL`,
      [input.workspaceId, input.projectId, input.runnerId, input.now],
    );
    return result.rowCount === 1;
  }

  async touchVerificationRunner(runnerId: string, now: string): Promise<void> {
    await this.pool.query(
      `UPDATE verification_runners SET last_seen_at=$2
       WHERE id=$1 AND revoked_at IS NULL AND expires_at>$2`,
      [runnerId, now],
    );
  }

  async claimVerificationJob(
    input: Parameters<ControlPlaneRepository['claimVerificationJob']>[0],
  ): Promise<VerificationJobRecord | undefined> {
    return transaction(this.pool, async (client) => {
      const runner = (
        await client.query<{ id: string }>(
          `SELECT id FROM verification_runners WHERE id=$1 AND revoked_at IS NULL
             AND expires_at>$2 FOR UPDATE`,
          [input.runnerId, input.now],
        )
      ).rows[0];
      if (!runner) throw new RepositoryNotFoundError('Active Verification Runner not found');
      const row = (
        await client.query<VerificationJobRow & { max_runtime_seconds: number }>(
          `SELECT j.*,s.max_runtime_seconds FROM verification_jobs j
           JOIN verification_runner_schedules rs ON rs.runner_id=$1
             AND rs.workspace_id=j.workspace_id AND rs.project_id=j.project_id
             AND rs.schedule_id=j.schedule_id
           JOIN verification_schedules s ON s.id=j.schedule_id
           WHERE j.state='queued' AND j.available_at <= $2
           ORDER BY j.due_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
          [input.runnerId, input.now],
        )
      ).rows[0];
      if (!row) {
        await client.query('UPDATE verification_runners SET last_seen_at=$2 WHERE id=$1', [
          input.runnerId,
          input.now,
        ]);
        return undefined;
      }
      const deadlineAt = new Date(
        new Date(input.now).getTime() + row.max_runtime_seconds * 1_000,
      ).toISOString();
      const leaseExpiresAt = new Date(
        Math.min(
          new Date(input.now).getTime() + input.leaseSeconds * 1_000,
          new Date(deadlineAt).getTime(),
        ),
      ).toISOString();
      const updated = (
        await client.query<VerificationJobRow>(
          `UPDATE verification_jobs SET state='leased',attempts=attempts+1,lease_id=$2,
             leased_by_runner_id=$3,leased_at=$4,lease_expires_at=$5,deadline_at=$6
           WHERE id=$1 RETURNING *`,
          [row.id, input.leaseId, input.runnerId, input.now, leaseExpiresAt, deadlineAt],
        )
      ).rows[0]!;
      await client.query('UPDATE verification_runners SET last_seen_at=$2 WHERE id=$1', [
        input.runnerId,
        input.now,
      ]);
      return verificationJob(updated);
    });
  }

  async renewVerificationJobLease(
    input: Parameters<ControlPlaneRepository['renewVerificationJobLease']>[0],
  ): Promise<VerificationJobRecord> {
    return transaction(this.pool, async (client) => {
      const runner = await client.query(
        `SELECT id FROM verification_runners WHERE id=$1 AND revoked_at IS NULL
           AND expires_at>$2 FOR SHARE`,
        [input.runnerId, input.now],
      );
      if (runner.rowCount !== 1)
        throw new RepositoryConflictError('Verification Runner is revoked or expired');
      const currentRow = (
        await client.query<VerificationJobRow>(
          `SELECT * FROM verification_jobs WHERE id=$1 FOR UPDATE`,
          [input.jobId],
        )
      ).rows[0];
      if (!currentRow) throw new RepositoryNotFoundError('Verification Job not found');
      const current = verificationJob(currentRow);
      if (
        current.state !== 'leased' ||
        current.leasedByRunnerId !== input.runnerId ||
        current.leaseId !== input.leaseId ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt <= input.now ||
        !current.deadlineAt ||
        current.deadlineAt <= input.now
      )
        throw new RepositoryConflictError('Verification Job lease is invalid or expired');
      const leaseExpiresAt = new Date(
        Math.min(
          new Date(input.now).getTime() + input.leaseSeconds * 1_000,
          new Date(current.deadlineAt).getTime(),
        ),
      ).toISOString();
      const row = (
        await client.query<VerificationJobRow>(
          'UPDATE verification_jobs SET lease_expires_at=$2 WHERE id=$1 RETURNING *',
          [input.jobId, leaseExpiresAt],
        )
      ).rows[0]!;
      await client.query('UPDATE verification_runners SET last_seen_at=$2 WHERE id=$1', [
        input.runnerId,
        input.now,
      ]);
      return verificationJob(row);
    });
  }

  async completeVerificationJob(
    input: Parameters<ControlPlaneRepository['completeVerificationJob']>[0],
  ): Promise<VerificationJobRecord> {
    return transaction(this.pool, async (client) => {
      const runner = await client.query(
        `SELECT id FROM verification_runners WHERE id=$1 AND revoked_at IS NULL
           AND expires_at>$2 FOR SHARE`,
        [input.runnerId, input.now],
      );
      if (runner.rowCount !== 1)
        throw new RepositoryConflictError('Verification Runner is revoked or expired');
      const currentRow = (
        await client.query<VerificationJobRow>(
          'SELECT * FROM verification_jobs WHERE id=$1 FOR UPDATE',
          [input.jobId],
        )
      ).rows[0];
      if (!currentRow) throw new RepositoryNotFoundError('Verification Job not found');
      const current = verificationJob(currentRow);
      if (
        ['succeeded', 'failed'].includes(current.state) &&
        current.resultHash === input.resultHash
      ) {
        if (current.leasedByRunnerId === input.runnerId && current.leaseId === input.leaseId)
          return current;
        throw new RepositoryConflictError('Verification Job completion lease does not match');
      }
      if (
        current.state !== 'leased' ||
        current.leasedByRunnerId !== input.runnerId ||
        current.leaseId !== input.leaseId ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt <= input.now ||
        !current.deadlineAt ||
        current.deadlineAt <= input.now
      )
        throw new RepositoryConflictError('Verification Job lease is invalid or expired');
      const succeeded =
        input.result.outcome === 'verified' &&
        (input.result.buildStatus === 'passed' || input.result.buildStatus === 'changed');
      const row = (
        await client.query<VerificationJobRow>(
          `UPDATE verification_jobs SET state=$2,result_json=$3,result_hash=$4,completed_at=$5
           WHERE id=$1 RETURNING *`,
          [
            input.jobId,
            succeeded ? 'succeeded' : 'failed',
            input.result,
            input.resultHash,
            input.now,
          ],
        )
      ).rows[0]!;
      await client.query(
        `UPDATE verification_schedules SET last_completed_at=$2,
           last_successful_at=CASE WHEN $3 THEN $2 ELSE last_successful_at END,
           updated_at=$2,version=version+1 WHERE id=$1`,
        [current.scheduleId, input.now, succeeded],
      );
      await client.query('UPDATE verification_runners SET last_seen_at=$2 WHERE id=$1', [
        input.runnerId,
        input.now,
      ]);
      return verificationJob(row);
    });
  }

  async consumeOidcToken(input: {
    tokenId: string;
    repository: string;
    commit: string;
    expiresAt: string;
  }): Promise<boolean> {
    await this.pool.query('DELETE FROM oidc_token_uses WHERE expires_at < now()');
    const result = await this.pool.query(
      'INSERT INTO oidc_token_uses(token_id,repository,commit_sha,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [input.tokenId, input.repository, input.commit, input.expiresAt],
    );
    return result.rowCount === 1;
  }

  async createSceneRevision(input: {
    id: string;
    workspaceId: string;
    projectId: string;
    scene: SceneRevisionRecord['scene'];
    revision: string;
    privacy: SceneRevisionRecord['privacy'];
    createdBy: string;
    now: string;
  }): Promise<SceneRevisionRecord> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${input.workspaceId}`,
      ]);
      const existing = (
        await client.query<SceneRevisionRow>(
          `SELECT * FROM scene_revisions
            WHERE workspace_id=$1 AND project_id=$2 AND scene_id=$3 AND revision_hash=$4`,
          [input.workspaceId, input.projectId, input.scene.id, input.revision],
        )
      ).rows[0];
      if (existing) return revision(existing);
      await this.assertStructuredAssetsActive(client, input.workspaceId, input.scene);
      const row = (
        await client.query<SceneRevisionRow>(
          `INSERT INTO scene_revisions(
             id,workspace_id,project_id,scene_id,revision_hash,source_json,privacy_json,
             created_by,created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (project_id,scene_id,revision_hash) DO NOTHING RETURNING *`,
          [
            input.id,
            input.workspaceId,
            input.projectId,
            input.scene.id,
            input.revision,
            input.scene,
            input.privacy,
            input.createdBy,
            input.now,
          ],
        )
      ).rows[0];
      if (row) return revision(row);
      const raced = (
        await client.query<SceneRevisionRow>(
          `SELECT * FROM scene_revisions
            WHERE workspace_id=$1 AND project_id=$2 AND scene_id=$3 AND revision_hash=$4`,
          [input.workspaceId, input.projectId, input.scene.id, input.revision],
        )
      ).rows[0];
      if (!raced) throw new Error('Could not create Scene revision');
      return revision(raced);
    });
  }

  async getSceneRevision(
    workspaceId: string,
    projectId: string,
    sceneId: string,
    revisionHash: string,
  ): Promise<SceneRevisionRecord | undefined> {
    const row = (
      await this.pool.query<SceneRevisionRow>(
        'SELECT * FROM scene_revisions WHERE workspace_id=$1 AND project_id=$2 AND scene_id=$3 AND revision_hash=$4',
        [workspaceId, projectId, sceneId, revisionHash],
      )
    ).rows[0];
    return row ? revision(row) : undefined;
  }

  async listSceneRevisions(
    workspaceId: string,
    projectId: string,
    sceneId: string,
    limit: number,
  ): Promise<readonly SceneRevisionRecord[]> {
    const rows = await this.pool.query<SceneRevisionRow>(
      'SELECT * FROM scene_revisions WHERE workspace_id=$1 AND project_id=$2 AND scene_id=$3 ORDER BY created_at DESC,id DESC LIMIT $4',
      [workspaceId, projectId, sceneId, limit],
    );
    return rows.rows.map(revision);
  }

  async listSceneHeads(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly SceneRevisionRecord[]> {
    const result = await this.pool.query<SceneRevisionRow>(
      `SELECT * FROM (
         SELECT DISTINCT ON (scene_id) *
           FROM scene_revisions
          WHERE workspace_id=$1 AND project_id=$2
          ORDER BY scene_id,created_at DESC,id DESC
       ) heads
       ORDER BY created_at DESC,id DESC LIMIT $3`,
      [workspaceId, projectId, limit],
    );
    return result.rows.map(revision);
  }

  async createReview(workspaceId: string, projectId: string, value: Review): Promise<ReviewRecord> {
    const reviewValue = ReviewSchema.parse(value);
    await transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO reviews(id,workspace_id,project_id,review_json,status,change_state,opened_at,closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [
          reviewValue.id,
          workspaceId,
          projectId,
          reviewValue,
          reviewValue.status,
          reviewValue.changeState,
          reviewValue.openedAt,
          reviewValue.closedAt ?? null,
        ],
      );
      for (const comment of reviewValue.comments) {
        await client.query(
          `INSERT INTO review_comments(id,review_id,actor_id,body,step_id,state_id,region_json,resolved_at,resolved_by,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [
            comment.id,
            reviewValue.id,
            comment.actorId,
            comment.body,
            comment.stepId ?? null,
            comment.stateId ?? null,
            comment.region ?? null,
            comment.resolvedAt ?? null,
            comment.resolvedBy ?? null,
            comment.createdAt,
          ],
        );
      }
      for (const decision of reviewValue.decisions) {
        await client.query(
          `INSERT INTO review_decisions(id,review_id,change_id,actor_id,decision,reason,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [
            decision.id,
            reviewValue.id,
            decision.changeId ?? null,
            decision.actorId,
            decision.decision,
            decision.reason ?? null,
            decision.createdAt,
          ],
        );
      }
    });
    const result = await this.getReview(workspaceId, projectId, reviewValue.id);
    if (!result) throw new Error('Could not create Review');
    return result;
  }

  async getReview(
    workspaceId: string,
    projectId: string,
    reviewId: string,
  ): Promise<ReviewRecord | undefined> {
    const row = (
      await this.pool.query<ReviewRow>(
        'SELECT * FROM reviews WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
        [reviewId, workspaceId, projectId],
      )
    ).rows[0];
    if (!row) return undefined;
    const comments = await this.pool.query<CommentRow>(
      'SELECT * FROM review_comments WHERE review_id=$1 ORDER BY created_at,id',
      [reviewId],
    );
    const decisions = await this.pool.query<DecisionRow>(
      'SELECT * FROM review_decisions WHERE review_id=$1 ORDER BY created_at,id',
      [reviewId],
    );
    const base = ReviewSchema.parse(row.review_json);
    const reviewValue = ReviewSchema.parse({
      ...base,
      status: row.status,
      changeState: row.change_state,
      openedAt: iso(row.opened_at),
      ...(row.closed_at ? { closedAt: iso(row.closed_at) } : { closedAt: undefined }),
      comments: comments.rows.map(reviewComment),
      decisions: decisions.rows.map(reviewDecision),
    });
    return { workspaceId, projectId, review: reviewValue };
  }

  async listReviews(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ReviewRecord[]> {
    const result = await this.pool.query<ReviewRow>(
      'SELECT * FROM reviews WHERE workspace_id=$1 AND project_id=$2 ORDER BY opened_at DESC,id DESC LIMIT $3',
      [workspaceId, projectId, limit],
    );
    if (result.rows.length === 0) return [];
    const reviewIds = result.rows.map((row) => row.id);
    const [comments, decisions] = await Promise.all([
      this.pool.query<CommentRow>(
        'SELECT * FROM review_comments WHERE review_id=ANY($1::text[]) ORDER BY created_at,id',
        [reviewIds],
      ),
      this.pool.query<DecisionRow>(
        'SELECT * FROM review_decisions WHERE review_id=ANY($1::text[]) ORDER BY created_at,id',
        [reviewIds],
      ),
    ]);
    const commentsByReview = new Map<string, CommentRow[]>();
    for (const comment of comments.rows) {
      const values = commentsByReview.get(comment.review_id) ?? [];
      values.push(comment);
      commentsByReview.set(comment.review_id, values);
    }
    const decisionsByReview = new Map<string, DecisionRow[]>();
    for (const decision of decisions.rows) {
      const values = decisionsByReview.get(decision.review_id) ?? [];
      values.push(decision);
      decisionsByReview.set(decision.review_id, values);
    }
    return result.rows.map((row) => {
      const base = ReviewSchema.parse(row.review_json);
      const reviewValue = ReviewSchema.parse({
        ...base,
        status: row.status,
        changeState: row.change_state,
        openedAt: iso(row.opened_at),
        ...(row.closed_at ? { closedAt: iso(row.closed_at) } : { closedAt: undefined }),
        comments: (commentsByReview.get(row.id) ?? []).map(reviewComment),
        decisions: (decisionsByReview.get(row.id) ?? []).map(reviewDecision),
      });
      return { workspaceId, projectId, review: reviewValue };
    });
  }

  async addReviewComment(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    comment: ReviewComment,
  ): Promise<ReviewRecord> {
    const existing = await this.getReview(workspaceId, projectId, reviewId);
    if (!existing) throw new RepositoryNotFoundError('Review not found');
    const inserted = await this.pool.query<CommentRow>(
      `INSERT INTO review_comments(id,review_id,actor_id,body,step_id,state_id,region_json,resolved_at,resolved_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        comment.id,
        reviewId,
        comment.actorId,
        comment.body,
        comment.stepId ?? null,
        comment.stateId ?? null,
        comment.region ?? null,
        comment.resolvedAt ?? null,
        comment.resolvedBy ?? null,
        comment.createdAt,
      ],
    );
    if (!inserted.rows[0]) {
      const stored = (
        await this.pool.query<CommentRow>('SELECT * FROM review_comments WHERE id=$1', [comment.id])
      ).rows[0];
      if (
        !stored ||
        stableStringify(reviewComment(stored)) !==
          stableStringify(ReviewCommentSchema.parse(comment))
      ) {
        throw new RepositoryConflictError('Review comment idempotency conflict');
      }
    }
    return (await this.getReview(workspaceId, projectId, reviewId))!;
  }

  async setReviewCommentResolution(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    commentId: string,
    expectedResolvedAt: string | undefined,
    resolution: { readonly resolvedAt?: string; readonly resolvedBy?: string },
  ): Promise<ReviewRecord> {
    const updated = await this.pool.query<CommentRow>(
      `UPDATE review_comments AS comment
          SET resolved_at=$5,resolved_by=$6
         FROM reviews AS review
        WHERE comment.id=$4 AND comment.review_id=review.id
          AND review.workspace_id=$1 AND review.project_id=$2 AND review.id=$3
          AND comment.resolved_at IS NOT DISTINCT FROM $7::timestamptz
        RETURNING comment.*`,
      [
        workspaceId,
        projectId,
        reviewId,
        commentId,
        resolution.resolvedAt ?? null,
        resolution.resolvedBy ?? null,
        expectedResolvedAt ?? null,
      ],
    );
    if (!updated.rows[0]) {
      const review = await this.getReview(workspaceId, projectId, reviewId);
      if (!review) throw new RepositoryNotFoundError('Review not found');
      if (!review.review.comments.some((comment) => comment.id === commentId)) {
        throw new RepositoryNotFoundError('Review comment not found');
      }
      throw new RepositoryConflictError('Review comment resolution changed concurrently');
    }
    return (await this.getReview(workspaceId, projectId, reviewId))!;
  }

  async setReviewAssignees(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    expectedAssignedTo: readonly string[],
    assignedTo: readonly string[],
  ): Promise<ReviewRecord> {
    const updated = await this.pool.query<ReviewRow>(
      `UPDATE reviews
          SET review_json=jsonb_set(review_json,'{assignedTo}',$4::jsonb,true)
        WHERE workspace_id=$1 AND project_id=$2 AND id=$3
          AND COALESCE(review_json->'assignedTo','[]'::jsonb)=$5::jsonb
        RETURNING *`,
      [
        workspaceId,
        projectId,
        reviewId,
        JSON.stringify(assignedTo),
        JSON.stringify(expectedAssignedTo),
      ],
    );
    if (!updated.rows[0]) {
      if (!(await this.getReview(workspaceId, projectId, reviewId))) {
        throw new RepositoryNotFoundError('Review not found');
      }
      throw new RepositoryConflictError('Review assignment changed concurrently');
    }
    return (await this.getReview(workspaceId, projectId, reviewId))!;
  }

  async addReviewDecision(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    decision: ReviewDecision,
  ): Promise<ReviewRecord> {
    const normalized = ReviewDecisionSchema.parse(decision);
    await transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${workspaceId}`,
      ]);
      const reviewRow = (
        await client.query<ReviewRow>(
          `SELECT * FROM reviews
            WHERE id=$1 AND workspace_id=$2 AND project_id=$3
            FOR UPDATE`,
          [reviewId, workspaceId, projectId],
        )
      ).rows[0];
      if (!reviewRow) throw new RepositoryNotFoundError('Review not found');
      const stored = (
        await client.query<DecisionRow>('SELECT * FROM review_decisions WHERE id=$1', [
          normalized.id,
        ])
      ).rows[0];
      if (stored) {
        if (
          stored.review_id !== reviewId ||
          stableStringify(reviewDecision(stored)) !== stableStringify(normalized)
        ) {
          throw new RepositoryConflictError('Review decision idempotency conflict');
        }
        return;
      }
      const decisionRows = await client.query<DecisionRow>(
        'SELECT * FROM review_decisions WHERE review_id=$1 ORDER BY created_at,id',
        [reviewId],
      );
      const base = ReviewSchema.parse(reviewRow.review_json);
      const current = ReviewSchema.parse({
        ...base,
        status: reviewRow.status,
        ...(reviewRow.closed_at ? { closedAt: iso(reviewRow.closed_at) } : { closedAt: undefined }),
        decisions: decisionRows.rows.map(reviewDecision),
      });
      const status =
        normalized.decision === 'approve'
          ? 'approved'
          : normalized.decision === 'reject'
            ? 'rejected'
            : normalized.decision === 'request-change'
              ? 'changes-requested'
              : current.status;
      const closedAt =
        status === 'approved' || status === 'rejected' ? normalized.createdAt : undefined;
      ReviewSchema.parse({
        ...current,
        status,
        decisions: [...current.decisions, normalized],
        ...(closedAt ? { closedAt } : { closedAt: undefined }),
      });
      if (normalized.decision === 'approve' && current.subject.kind === 'run') {
        const run = (
          await client.query<RunEvidenceRow>(
            `SELECT * FROM verification_runs
              WHERE id=$1 AND workspace_id=$2 AND project_id=$3`,
            [current.subject.id, workspaceId, projectId],
          )
        ).rows[0];
        if (!run) throw new RepositoryConflictError('Review Run evidence is unavailable');
        await this.assertStructuredAssetsActive(client, workspaceId, run.artifact_json);
      }
      const inserted = await client.query<DecisionRow>(
        `INSERT INTO review_decisions(id,review_id,change_id,actor_id,decision,reason,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING *`,
        [
          normalized.id,
          reviewId,
          normalized.changeId ?? null,
          normalized.actorId,
          normalized.decision,
          normalized.reason ?? null,
          normalized.createdAt,
        ],
      );
      if (!inserted.rows[0]) {
        const raced = (
          await client.query<DecisionRow>('SELECT * FROM review_decisions WHERE id=$1', [
            normalized.id,
          ])
        ).rows[0];
        if (
          !raced ||
          raced.review_id !== reviewId ||
          stableStringify(reviewDecision(raced)) !== stableStringify(normalized)
        ) {
          throw new RepositoryConflictError('Review decision idempotency conflict');
        }
        return;
      }
      await client.query(
        `UPDATE reviews SET status=$1,closed_at=$2
          WHERE id=$3 AND workspace_id=$4 AND project_id=$5`,
        [status, closedAt ?? null, reviewId, workspaceId, projectId],
      );
    });
    return (await this.getReview(workspaceId, projectId, reviewId))!;
  }

  private async assertStructuredAssetsActive(
    client: PoolClient,
    workspaceId: string,
    value: unknown,
  ): Promise<void> {
    const assets = structuredAssetIdentities(value);
    if (assets.length === 0) return;
    const blocked = await client.query<{ sha256: string; media_type: string }>(
      `SELECT item.sha256,item.media_type
         FROM jsonb_to_recordset($2::jsonb) AS item(sha256 text,media_type text)
         LEFT JOIN evidence_object_lifecycle lifecycle ON
           lifecycle.workspace_id=$1 AND lifecycle.sha256=item.sha256
           AND lifecycle.media_type=item.media_type
        WHERE lifecycle.status IS DISTINCT FROM 'active'
        LIMIT 1`,
      [
        workspaceId,
        JSON.stringify(
          assets.map((asset) => ({ sha256: asset.sha256, media_type: asset.mediaType })),
        ),
      ],
    );
    if (blocked.rows[0]) {
      throw new RepositoryConflictError(
        `Evidence object is not active: ${blocked.rows[0].sha256}:${blocked.rows[0].media_type}`,
      );
    }
  }

  private async assertUploadObjectsActive(
    client: PoolClient,
    workspaceId: string,
    uploadId: string,
  ): Promise<void> {
    const blocked = await client.query<{ sha256: string; media_type: string }>(
      `SELECT object.sha256,object.media_type
         FROM artifact_uploads upload
         JOIN artifact_objects object ON object.upload_id=upload.id
         LEFT JOIN evidence_object_lifecycle lifecycle ON
           lifecycle.workspace_id=upload.workspace_id AND lifecycle.sha256=object.sha256
           AND lifecycle.media_type=object.media_type
        WHERE upload.id=$2 AND upload.workspace_id=$1 AND upload.status='finalized'
          AND lifecycle.status IS DISTINCT FROM 'active'
        LIMIT 1`,
      [workspaceId, uploadId],
    );
    if (blocked.rows[0]) {
      throw new RepositoryConflictError(
        `Release upload object is not active: ${blocked.rows[0].sha256}:${blocked.rows[0].media_type}`,
      );
    }
  }

  async recordVerificationRun(input: VerificationRunRecord): Promise<VerificationRunRecord> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${input.workspaceId}`,
      ]);
      await this.assertStructuredAssetsActive(client, input.workspaceId, input.run);
      const inserted = await client.query<RunEvidenceRow>(
        `INSERT INTO verification_runs(id,workspace_id,project_id,scene_id,source_revision,artifact_hash,artifact_json,idempotency_key,request_hash,recorded_by,recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.id,
          input.workspaceId,
          input.projectId,
          input.sceneId,
          input.sourceRevision,
          input.artifactHash,
          input.run,
          input.idempotencyKey,
          input.requestHash,
          input.recordedBy,
          input.recordedAt,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query<RunEvidenceRow>(
            'SELECT * FROM verification_runs WHERE (id=$1 AND workspace_id=$2 AND project_id=$4) OR (workspace_id=$2 AND project_id=$4 AND idempotency_key=$3) ORDER BY (id=$1) DESC LIMIT 1',
            [input.id, input.workspaceId, input.idempotencyKey, input.projectId],
          )
        ).rows[0];
      if (!row) throw new Error('Could not record verification Run');
      if (
        row.request_hash !== input.requestHash ||
        (row.id === input.id && row.idempotency_key !== input.idempotencyKey)
      )
        throw new RepositoryConflictError('Run evidence idempotency conflict');
      const diagnostic = input.run.attempts.flatMap((attempt) => [
        ...(attempt.trace ? [attempt.trace] : []),
        ...attempt.attachments.filter((asset) => asset.role === 'trace' || asset.role === 'video'),
      ]);
      for (const asset of diagnostic) {
        await client.query(
          `UPDATE evidence_object_lifecycle
              SET retention_class='diagnostic'
            WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3 AND status='active'`,
          [input.workspaceId, asset.sha256, asset.mediaType],
        );
      }
      return verificationRun(row);
    });
  }

  async getVerificationRun(
    workspaceId: string,
    projectId: string,
    runId: string,
  ): Promise<VerificationRunRecord | undefined> {
    const row = (
      await this.pool.query<RunEvidenceRow>(
        'SELECT * FROM verification_runs WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
        [runId, workspaceId, projectId],
      )
    ).rows[0];
    return row ? verificationRun(row) : undefined;
  }

  async listVerificationRuns(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationRunRecord[]> {
    const result = await this.pool.query<RunEvidenceRow>(
      'SELECT * FROM verification_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY recorded_at DESC,id DESC LIMIT $3',
      [workspaceId, projectId, limit],
    );
    return result.rows.map(verificationRun);
  }

  async recordVerificationBuild(input: VerificationBuildRecord): Promise<VerificationBuildRecord> {
    const inserted = await this.pool.query<BuildEvidenceRow>(
      `INSERT INTO verification_builds(id,workspace_id,project_id,artifact_hash,artifact_json,idempotency_key,request_hash,recorded_by,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.artifactHash,
        input.build,
        input.idempotencyKey,
        input.requestHash,
        input.recordedBy,
        input.recordedAt,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<BuildEvidenceRow>(
          'SELECT * FROM verification_builds WHERE (id=$1 AND workspace_id=$2 AND project_id=$4) OR (workspace_id=$2 AND project_id=$4 AND idempotency_key=$3) ORDER BY (id=$1) DESC LIMIT 1',
          [input.id, input.workspaceId, input.idempotencyKey, input.projectId],
        )
      ).rows[0];
    if (!row) throw new Error('Could not record verification Build');
    if (
      row.request_hash !== input.requestHash ||
      (row.id === input.id && row.idempotency_key !== input.idempotencyKey)
    )
      throw new RepositoryConflictError('Build evidence idempotency conflict');
    return verificationBuild(row);
  }

  async getVerificationBuild(
    workspaceId: string,
    projectId: string,
    buildId: string,
  ): Promise<VerificationBuildRecord | undefined> {
    const row = (
      await this.pool.query<BuildEvidenceRow>(
        'SELECT * FROM verification_builds WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
        [buildId, workspaceId, projectId],
      )
    ).rows[0];
    return row ? verificationBuild(row) : undefined;
  }

  async listVerificationBuilds(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationBuildRecord[]> {
    const result = await this.pool.query<BuildEvidenceRow>(
      'SELECT * FROM verification_builds WHERE workspace_id=$1 AND project_id=$2 ORDER BY recorded_at DESC,id DESC LIMIT $3',
      [workspaceId, projectId, limit],
    );
    return result.rows.map(verificationBuild);
  }

  async recordVerificationBaseline(
    input: VerificationBaselineRecord,
  ): Promise<VerificationBaselineRecord> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${input.workspaceId}`,
      ]);
      await this.assertStructuredAssetsActive(client, input.workspaceId, input.baseline);
      const sourceRun = (
        await client.query<RunEvidenceRow>(
          'SELECT * FROM verification_runs WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
          [input.sourceRunId, input.workspaceId, input.projectId],
        )
      ).rows[0];
      if (!sourceRun) throw new RepositoryNotFoundError('Baseline source Run not found');
      await this.assertStructuredAssetsActive(client, input.workspaceId, sourceRun.artifact_json);
      const inserted = await client.query<BaselineEvidenceRow>(
        `INSERT INTO verification_baselines(id,workspace_id,project_id,scene_id,source_revision,source_run_id,source_run_hash,artifact_hash,artifact_json,idempotency_key,request_hash,recorded_by,recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.id,
          input.workspaceId,
          input.projectId,
          input.sceneId,
          input.sourceRevision,
          input.sourceRunId,
          input.sourceRunHash,
          input.artifactHash,
          input.baseline,
          input.idempotencyKey,
          input.requestHash,
          input.recordedBy,
          input.recordedAt,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query<BaselineEvidenceRow>(
            'SELECT * FROM verification_baselines WHERE (id=$1 AND workspace_id=$2 AND project_id=$4) OR (workspace_id=$2 AND project_id=$4 AND idempotency_key=$3) ORDER BY (id=$1) DESC LIMIT 1',
            [input.id, input.workspaceId, input.idempotencyKey, input.projectId],
          )
        ).rows[0];
      if (!row) throw new Error('Could not record verification Baseline');
      if (
        row.request_hash !== input.requestHash ||
        (row.id === input.id && row.idempotency_key !== input.idempotencyKey)
      )
        throw new RepositoryConflictError('Baseline evidence idempotency conflict');
      return verificationBaseline(row);
    });
  }

  async getVerificationBaseline(
    workspaceId: string,
    projectId: string,
    baselineId: string,
  ): Promise<VerificationBaselineRecord | undefined> {
    const row = (
      await this.pool.query<BaselineEvidenceRow>(
        'SELECT * FROM verification_baselines WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
        [baselineId, workspaceId, projectId],
      )
    ).rows[0];
    return row ? verificationBaseline(row) : undefined;
  }

  async listVerificationBaselines(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationBaselineRecord[]> {
    const result = await this.pool.query<BaselineEvidenceRow>(
      'SELECT * FROM verification_baselines WHERE workspace_id=$1 AND project_id=$2 ORDER BY recorded_at DESC,id DESC LIMIT $3',
      [workspaceId, projectId, limit],
    );
    return result.rows.map(verificationBaseline);
  }

  async recordReviewApproval(input: ReviewApprovalRecord): Promise<ReviewApprovalRecord> {
    const inserted = await this.pool.query<ApprovalEvidenceRow>(
      `INSERT INTO review_approvals(id,workspace_id,project_id,subject_kind,subject_id,subject_revision,artifact_hash,approval_json,idempotency_key,request_hash,recorded_by,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.subjectKind,
        input.subjectId,
        input.subjectRevision,
        input.artifactHash,
        input.approval,
        input.idempotencyKey,
        input.requestHash,
        input.recordedBy,
        input.recordedAt,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<ApprovalEvidenceRow>(
          'SELECT * FROM review_approvals WHERE (id=$1 AND workspace_id=$2 AND project_id=$4) OR (workspace_id=$2 AND project_id=$4 AND idempotency_key=$3) ORDER BY (id=$1) DESC LIMIT 1',
          [input.id, input.workspaceId, input.idempotencyKey, input.projectId],
        )
      ).rows[0];
    if (!row) throw new Error('Could not record Review approval');
    if (
      row.request_hash !== input.requestHash ||
      (row.id === input.id && row.idempotency_key !== input.idempotencyKey)
    )
      throw new RepositoryConflictError('Review approval idempotency conflict');
    return reviewApproval(row);
  }

  async getReviewApproval(
    workspaceId: string,
    projectId: string,
    approvalId: string,
  ): Promise<ReviewApprovalRecord | undefined> {
    const row = (
      await this.pool.query<ApprovalEvidenceRow>(
        'SELECT * FROM review_approvals WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
        [approvalId, workspaceId, projectId],
      )
    ).rows[0];
    return row ? reviewApproval(row) : undefined;
  }

  async listReviewApprovals(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ReviewApprovalRecord[]> {
    const result = await this.pool.query<ApprovalEvidenceRow>(
      'SELECT * FROM review_approvals WHERE workspace_id=$1 AND project_id=$2 ORDER BY recorded_at DESC,id DESC LIMIT $3',
      [workspaceId, projectId, limit],
    );
    return result.rows.map(reviewApproval);
  }

  private async uploadById(
    client: Pool | PoolClient,
    uploadId: string,
  ): Promise<ArtifactUploadRecord | undefined> {
    const row = (
      await client.query<UploadRow>('SELECT * FROM artifact_uploads WHERE id=$1', [uploadId])
    ).rows[0];
    if (!row) return undefined;
    const objects = await client.query<ObjectRow>(
      'SELECT * FROM artifact_objects WHERE upload_id=$1 ORDER BY sha256,media_type',
      [uploadId],
    );
    return upload(row, objects.rows);
  }

  async beginUpload(
    input: Parameters<ControlPlaneRepository['beginUpload']>[0],
  ): Promise<ArtifactUploadRecord> {
    if (
      new Set(
        input.objects.map((object) => artifactObjectIdentity(object.sha256, object.mediaType)),
      ).size !== input.objects.length
    ) {
      throw new RepositoryConflictError('Upload object identities must be unique');
    }
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${input.workspaceId}`,
      ]);
      const existing = (
        await client.query<UploadRow>(
          'SELECT * FROM artifact_uploads WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE',
          [input.workspaceId, input.idempotencyKey],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash) {
          throw new RepositoryConflictError(
            'Upload idempotency key was reused with another request',
          );
        }
        return (await this.uploadById(client, existing.id))!;
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('scenebook-artifact-upload-global', 0))",
      );
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-artifact-upload-tenant:${input.workspaceId}`,
      ]);
      // A concurrent request with the same key can commit while this
      // transaction waits for the advisory locks. Recheck before applying
      // capacity limits so a safe retry returns the original upload instead
      // of being rejected for capacity consumed by that same upload.
      const settled = (
        await client.query<UploadRow>(
          'SELECT * FROM artifact_uploads WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE',
          [input.workspaceId, input.idempotencyKey],
        )
      ).rows[0];
      if (settled) {
        if (settled.request_hash !== input.requestHash) {
          throw new RepositoryConflictError(
            'Upload idempotency key was reused with another request',
          );
        }
        return (await this.uploadById(client, settled.id))!;
      }
      const blockedLifecycle = await client.query<{ sha256: string; media_type: string }>(
        `SELECT l.sha256,l.media_type
           FROM evidence_object_lifecycle l
          WHERE l.workspace_id=$1 AND l.status IN ('claimed','deleting')
            AND (l.sha256,l.media_type) IN (
              SELECT item.sha256,item.media_type
                FROM jsonb_to_recordset($2::jsonb) AS item(sha256 text,media_type text)
            )
          LIMIT 1`,
        [
          input.workspaceId,
          JSON.stringify(
            input.objects.map((object) => ({
              sha256: object.sha256,
              media_type: object.mediaType,
            })),
          ),
        ],
      );
      if (blockedLifecycle.rows[0]) {
        throw new RepositoryConflictError('Object is being retained or deleted; retry upload');
      }
      const usage = async (workspaceId?: string): Promise<{ uploads: number; bytes: number }> => {
        const parameters: unknown[] = [input.now];
        const workspace = workspaceId ? ' AND u.workspace_id=$2' : '';
        if (workspaceId) parameters.push(workspaceId);
        const row = (
          await client.query<UploadUsageRow>(
            `SELECT COUNT(DISTINCT u.id) AS upload_count, COALESCE(SUM(o.byte_length),0) AS byte_count
             FROM artifact_uploads u
             JOIN artifact_objects o ON o.upload_id=u.id
             WHERE u.status IN ('pending','staged') AND u.expires_at>$1${workspace}`,
            parameters,
          )
        ).rows[0] ?? { upload_count: 0, byte_count: 0 };
        return { uploads: Number(row.upload_count), bytes: Number(row.byte_count) };
      };
      const global = await usage();
      const tenant = await usage(input.workspaceId);
      const requestedBytes = input.objects.reduce((total, object) => total + object.byteLength, 0);
      if (tenant.uploads + 1 > input.limits.maxActiveUploadsPerTenant) {
        throw new RepositoryCapacityError('tenant', 'uploads');
      }
      if (global.uploads + 1 > input.limits.maxActiveUploadsGlobal) {
        throw new RepositoryCapacityError('global', 'uploads');
      }
      if (tenant.bytes + requestedBytes > input.limits.maxActiveBytesPerTenant) {
        throw new RepositoryCapacityError('tenant', 'bytes');
      }
      if (global.bytes + requestedBytes > input.limits.maxActiveBytesGlobal) {
        throw new RepositoryCapacityError('global', 'bytes');
      }
      const inserted = (
        await client.query<UploadRow>(
          `INSERT INTO artifact_uploads(id,workspace_id,project_id,repository,commit_sha,git_ref,status,idempotency_key,request_hash,created_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10)
           ON CONFLICT DO NOTHING RETURNING *`,
          [
            input.id,
            input.workspaceId,
            input.projectId,
            input.repository,
            input.commit,
            input.ref,
            input.idempotencyKey,
            input.requestHash,
            input.now,
            input.expiresAt,
          ],
        )
      ).rows[0];
      if (!inserted) {
        const conflicting = (
          await client.query<UploadRow>(
            'SELECT * FROM artifact_uploads WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE',
            [input.workspaceId, input.idempotencyKey],
          )
        ).rows[0];
        if (!conflicting) throw new RepositoryConflictError('Upload ID is already in use');
        if (conflicting.request_hash !== input.requestHash)
          throw new RepositoryConflictError(
            'Upload idempotency key was reused with another request',
          );
        return (await this.uploadById(client, conflicting.id))!;
      }
      for (const object of input.objects) {
        await client.query(
          `INSERT INTO artifact_objects(upload_id,sha256,byte_length,media_type,status) VALUES ($1,$2,$3,$4,'pending')`,
          [input.id, object.sha256, object.byteLength, object.mediaType],
        );
      }
      return (await this.uploadById(client, input.id))!;
    });
  }

  async getUpload(uploadId: string): Promise<ArtifactUploadRecord | undefined> {
    return this.uploadById(this.pool, uploadId);
  }

  async listWorkspaceFinalizedUploads(
    workspaceId: string,
    limit: number,
  ): Promise<readonly ArtifactUploadRecord[]> {
    const rows = await this.pool.query<UploadRow>(
      `SELECT * FROM artifact_uploads
        WHERE workspace_id=$1 AND status='finalized'
        ORDER BY finalized_at DESC,id DESC LIMIT $2`,
      [workspaceId, limit],
    );
    const values: ArtifactUploadRecord[] = [];
    for (const row of rows.rows) values.push((await this.uploadById(this.pool, row.id))!);
    return values;
  }

  async getFinalizedUploadByManifest(
    workspaceId: string,
    projectId: string,
    repository: string,
    commit: string,
    manifestHash: string,
  ): Promise<ArtifactUploadRecord | undefined> {
    const row = (
      await this.pool.query<UploadRow>(
        "SELECT * FROM artifact_uploads WHERE workspace_id=$1 AND project_id=$2 AND lower(repository)=lower($3) AND commit_sha=$4 AND manifest_hash=$5 AND status='finalized' ORDER BY finalized_at DESC,id DESC LIMIT 1",
        [workspaceId, projectId, repository, commit, manifestHash],
      )
    ).rows[0];
    return row ? this.uploadById(this.pool, row.id) : undefined;
  }

  async getFinalizedObject(
    workspaceId: string,
    projectId: string,
    hash: string,
    mediaType: string,
  ): Promise<StoredObject | undefined> {
    const row = (
      await this.pool.query<ObjectRow>(
        `SELECT o.*
           FROM artifact_objects o
           JOIN artifact_uploads u ON u.id=o.upload_id
          WHERE u.workspace_id=$1 AND u.project_id=$2 AND u.status='finalized'
            AND o.sha256=$3 AND o.media_type=$4 AND o.status='finalized'
            AND o.final_key IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM evidence_object_lifecycle l
               WHERE l.workspace_id=u.workspace_id AND l.sha256=o.sha256
                 AND l.media_type=o.media_type AND l.status <> 'active'
            )
          ORDER BY u.finalized_at DESC,u.id DESC LIMIT 1`,
        [workspaceId, projectId, hash, mediaType],
      )
    ).rows[0];
    if (!row?.final_key) return undefined;
    return {
      key: row.final_key,
      sha256: row.sha256,
      byteLength: Number(row.byte_length),
      mediaType: row.media_type,
    };
  }

  async markObjectStaged(
    uploadId: string,
    hash: string,
    mediaType: string,
    stagingKey: string,
    now: string,
  ): Promise<ArtifactUploadRecord> {
    const result = await this.pool.query(
      `UPDATE artifact_objects o SET status='staged',staging_key=$4
       FROM artifact_uploads u
       WHERE o.upload_id=$1 AND o.sha256=$2 AND o.media_type=$3
         AND o.status IN ('pending','staged')
         AND u.id=o.upload_id AND u.status IN ('pending','staged') AND u.expires_at>$5`,
      [uploadId, hash, mediaType, stagingKey, now],
    );
    if (result.rowCount !== 1)
      throw new RepositoryConflictError('Object is not pending or does not belong to upload');
    await this.pool.query(
      `UPDATE artifact_uploads SET status='staged'
       WHERE id=$1 AND status IN ('pending','staged') AND expires_at>$2
         AND NOT EXISTS (SELECT 1 FROM artifact_objects WHERE upload_id=$1 AND status='pending')`,
      [uploadId, now],
    );
    return (await this.getUpload(uploadId))!;
  }

  async claimExpiredUploads(
    input: Parameters<ControlPlaneRepository['claimExpiredUploads']>[0],
  ): Promise<readonly ArtifactUploadRecord[]> {
    return transaction(this.pool, async (client) => {
      const rows = (
        await client.query<UploadRow>(
          `WITH candidates AS (
             SELECT id FROM artifact_uploads
             WHERE status <> 'finalized' AND expires_at <= $1 AND gc_completed_at IS NULL
               AND (gc_claimed_until IS NULL OR gc_claimed_until <= $1)
             ORDER BY expires_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT $2
           )
           UPDATE artifact_uploads u
           SET status='expired', gc_claim_id=$3, gc_claimed_until=$4
           FROM candidates c
           WHERE u.id=c.id
           RETURNING u.*`,
          [input.now, input.limit, input.claimId, input.claimedUntil],
        )
      ).rows;
      const uploads: ArtifactUploadRecord[] = [];
      for (const row of rows) uploads.push((await this.uploadById(client, row.id))!);
      return uploads;
    });
  }

  async completeExpiredUpload(uploadId: string, claimId: string, now: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE artifact_uploads SET gc_completed_at=COALESCE(gc_completed_at,$3)
       WHERE id=$1 AND status='expired' AND gc_claim_id=$2`,
      [uploadId, claimId, now],
    );
    return result.rowCount === 1;
  }

  private async evidenceObjectIsProtected(
    client: Pool | PoolClient,
    workspaceId: string,
    sha256: string,
    mediaType: string,
  ): Promise<boolean> {
    const variables = JSON.stringify({ sha: sha256, media: mediaType });
    const path = '$.** ? (@.sha256 == $sha && @.mediaType == $media)';
    const direct = await client.query<{ protected: boolean }>(
      `SELECT
         EXISTS(
           SELECT 1 FROM scene_revisions scene
            WHERE scene.workspace_id=$1
              AND jsonb_path_exists(scene.source_json,$4::jsonpath,$5::jsonb)
         ) OR EXISTS(
           SELECT 1 FROM verification_baselines b
            WHERE b.workspace_id=$1
              AND jsonb_path_exists(b.artifact_json,$4::jsonpath,$5::jsonb)
         ) OR EXISTS(
           SELECT 1 FROM verification_baselines b
           JOIN verification_runs r ON r.id=b.source_run_id AND r.workspace_id=b.workspace_id
            WHERE b.workspace_id=$1
              AND jsonb_path_exists(r.artifact_json,$4::jsonpath,$5::jsonb)
         ) OR EXISTS(
           SELECT 1 FROM releases r
            WHERE r.workspace_id=$1
              AND jsonb_path_exists(r.release_json,$4::jsonpath,$5::jsonb)
         ) OR EXISTS(
           SELECT 1 FROM releases r
           JOIN artifact_objects o ON o.upload_id=r.evidence_json->>'artifactUploadId'
            WHERE r.workspace_id=$1 AND o.sha256=$2 AND o.media_type=$3
         ) OR EXISTS(
           SELECT 1 FROM releases release
           CROSS JOIN LATERAL jsonb_array_elements(
             COALESCE(release.evidence_json->'scenes','[]'::jsonb)
           ) scene
           JOIN verification_runs run ON run.id=scene->>'runId'
            WHERE release.workspace_id=$1
              AND jsonb_path_exists(run.artifact_json,$4::jsonpath,$5::jsonb)
         ) OR EXISTS(
           SELECT 1 FROM reviews review
           JOIN verification_runs run ON
             review.review_json->'subject'->>'kind'='run'
             AND run.id=review.review_json->'subject'->>'id'
            WHERE review.workspace_id=$1 AND review.status='approved'
              AND jsonb_path_exists(run.artifact_json,$4::jsonpath,$5::jsonb)
         ) AS protected`,
      [workspaceId, sha256, mediaType, path, variables],
    );
    return direct.rows[0]?.protected === true;
  }

  private async evidenceObjectProjectIds(
    client: Pool | PoolClient,
    workspaceId: string,
    sha256: string,
    mediaType: string,
  ): Promise<string[]> {
    const values = await client.query<{ project_id: string }>(
      `SELECT DISTINCT u.project_id
         FROM artifact_uploads u
         JOIN artifact_objects o ON o.upload_id=u.id
        WHERE u.workspace_id=$1 AND o.sha256=$2 AND o.media_type=$3
        ORDER BY u.project_id`,
      [workspaceId, sha256, mediaType],
    );
    return values.rows.map((row) => row.project_id);
  }

  async listEvidenceRetentionWorkspaceIds(
    input: Parameters<ControlPlaneRepository['listEvidenceRetentionWorkspaceIds']>[0],
  ): Promise<readonly string[]> {
    const rows = await this.pool.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id
         FROM evidence_object_lifecycle
        WHERE status <> 'deleted' AND workspace_id > $1
        ORDER BY workspace_id
        LIMIT $2`,
      [input.afterWorkspaceId ?? '', input.limit],
    );
    return rows.rows.map((row) => row.workspace_id);
  }

  async claimEvidenceRetentionObjects(
    input: Parameters<ControlPlaneRepository['claimEvidenceRetentionObjects']>[0],
  ): ReturnType<ControlPlaneRepository['claimEvidenceRetentionObjects']> {
    return transaction(this.pool, async (client) => {
      const candidates = await client.query<EvidenceObjectLifecycleRow>(
        `SELECT * FROM evidence_object_lifecycle
          WHERE workspace_id=$1 AND (
            status='active' OR
            (status IN ('claimed','deleting') AND claimed_until <= $2)
          )
          ORDER BY last_evaluated_at ASC NULLS FIRST,last_finalized_at,sha256,media_type
          LIMIT $3`,
        [input.workspaceId, input.now, input.limit],
      );
      const claimed: EvidenceRetentionClaimRecord[] = [];
      const evaluations: EvidenceRetentionEvaluationRecord[] = [];
      for (const selected of candidates.rows) {
        // Every operation that can create a durable reference or reactivate an
        // object takes this advisory lock before touching its lifecycle row.
        // Preserve that order here to avoid a row/advisory-lock inversion.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `scenebook-evidence-retention:${input.workspaceId}`,
        ]);
        const candidate = (
          await client.query<EvidenceObjectLifecycleRow>(
            `SELECT * FROM evidence_object_lifecycle
              WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3
                AND (
                  status='active' OR
                  (status IN ('claimed','deleting') AND claimed_until <= $4)
                )
              FOR UPDATE`,
            [selected.workspace_id, selected.sha256, selected.media_type, input.now],
          )
        ).rows[0];
        // Another worker can select the same unlocked candidate list. The
        // exact re-read makes the first committed claim authoritative.
        if (!candidate) continue;
        const cutoff =
          candidate.retention_class === 'diagnostic'
            ? input.diagnosticCutoff
            : input.standardCutoff;
        const gracePeriod = iso(candidate.last_finalized_at) > cutoff;
        const protectedReference = gracePeriod
          ? false
          : await this.evidenceObjectIsProtected(
              client,
              candidate.workspace_id,
              candidate.sha256,
              candidate.media_type,
            );
        const activeUpload = await client.query(
          `SELECT 1
             FROM artifact_uploads u
             JOIN artifact_objects o ON o.upload_id=u.id
            WHERE u.workspace_id=$1 AND o.sha256=$2 AND o.media_type=$3
              AND u.status IN ('pending','staged')
            LIMIT 1`,
          [candidate.workspace_id, candidate.sha256, candidate.media_type],
        );
        const projectIds = await this.evidenceObjectProjectIds(
          client,
          candidate.workspace_id,
          candidate.sha256,
          candidate.media_type,
        );
        const disposition = gracePeriod
          ? ('grace-period' as const)
          : protectedReference || Boolean(activeUpload.rows[0])
            ? ('protected' as const)
            : ('eligible' as const);
        const reason =
          disposition === 'grace-period'
            ? `${candidate.retention_class} grace period has not elapsed`
            : disposition === 'protected'
              ? activeUpload.rows[0]
                ? 'matching active upload exists'
                : 'immutable evidence or Release reference exists'
              : 'grace elapsed and no protected reference or active upload exists';
        evaluations.push({
          ...evidenceObjectLifecycle(candidate),
          projectIds,
          disposition,
          reason,
        });
        if (!input.dryRun) {
          await client.query(
            `UPDATE evidence_object_lifecycle SET last_evaluated_at=$4
              WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3`,
            [candidate.workspace_id, candidate.sha256, candidate.media_type, input.now],
          );
        }
        if (disposition !== 'eligible') continue;
        if (input.dryRun) {
          claimed.push(
            evidenceRetentionClaim({
              ...candidate,
              status: 'claimed',
              claim_id: input.claimId,
              claimed_until: new Date(input.claimedUntil),
              project_ids: projectIds,
            }),
          );
          continue;
        }
        const updated = (
          await client.query<EvidenceObjectLifecycleRow>(
            `UPDATE evidence_object_lifecycle
                SET status='claimed',claim_id=$4,claimed_until=$5,deleted_at=NULL
              WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3
                AND (
                  status='active' OR
                  (status IN ('claimed','deleting') AND claimed_until <= $6)
                )
              RETURNING *`,
            [
              candidate.workspace_id,
              candidate.sha256,
              candidate.media_type,
              input.claimId,
              input.claimedUntil,
              input.now,
            ],
          )
        ).rows[0];
        if (updated) claimed.push(evidenceRetentionClaim({ ...updated, project_ids: projectIds }));
      }
      return { evaluations, claims: claimed };
    });
  }

  async beginFinalEvidenceDeletion(
    input: Parameters<ControlPlaneRepository['beginFinalEvidenceDeletion']>[0],
  ): Promise<EvidenceRetentionClaimRecord | undefined> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${input.workspaceId}`,
      ]);
      const row = (
        await client.query<EvidenceObjectLifecycleRow>(
          `SELECT * FROM evidence_object_lifecycle
            WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3
            FOR UPDATE`,
          [input.workspaceId, input.sha256, input.mediaType],
        )
      ).rows[0];
      if (
        !row ||
        row.status !== 'claimed' ||
        row.claim_id !== input.claimId ||
        !row.claimed_until ||
        iso(row.claimed_until) <= input.now
      ) {
        return undefined;
      }
      if (
        await this.evidenceObjectIsProtected(
          client,
          input.workspaceId,
          input.sha256,
          input.mediaType,
        )
      ) {
        await client.query(
          `UPDATE evidence_object_lifecycle
              SET status='active',claim_id=NULL,claimed_until=NULL
            WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3 AND claim_id=$4`,
          [input.workspaceId, input.sha256, input.mediaType, input.claimId],
        );
        return undefined;
      }
      const activeUpload = await client.query(
        `SELECT 1 FROM artifact_uploads u
         JOIN artifact_objects o ON o.upload_id=u.id
         WHERE u.workspace_id=$1 AND o.sha256=$2 AND o.media_type=$3
           AND u.status IN ('pending','staged') LIMIT 1`,
        [input.workspaceId, input.sha256, input.mediaType],
      );
      if (activeUpload.rows[0]) return undefined;
      const updated = (
        await client.query<EvidenceObjectLifecycleRow>(
          `UPDATE evidence_object_lifecycle SET status='deleting'
            WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3
              AND status='claimed' AND claim_id=$4
            RETURNING *`,
          [input.workspaceId, input.sha256, input.mediaType, input.claimId],
        )
      ).rows[0];
      if (!updated) return undefined;
      const projectIds = await this.evidenceObjectProjectIds(
        client,
        input.workspaceId,
        input.sha256,
        input.mediaType,
      );
      return evidenceRetentionClaim({ ...updated, project_ids: projectIds });
    });
  }

  async completeFinalEvidenceDeletion(
    input: Parameters<ControlPlaneRepository['completeFinalEvidenceDeletion']>[0],
  ): Promise<boolean> {
    if (
      input.event.workspaceId !== input.workspaceId ||
      input.event.sha256 !== input.sha256 ||
      input.event.mediaType !== input.mediaType ||
      input.event.claimId !== input.claimId ||
      input.event.disposition !== 'deleted' ||
      input.event.createdAt !== input.now ||
      input.audit.workspaceId !== input.workspaceId ||
      input.audit.action !== 'evidence.retention-deleted' ||
      input.audit.targetType !== 'evidence-object' ||
      input.audit.targetId !== `${input.sha256}:${input.mediaType}` ||
      input.audit.requestId !== input.claimId ||
      input.audit.createdAt !== input.now
    ) {
      throw new RepositoryConflictError('Final evidence deletion audit does not match its claim');
    }
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE evidence_object_lifecycle
            SET status='deleted',claim_id=NULL,claimed_until=NULL,deleted_at=$5
          WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3
            AND status='deleting' AND claim_id=$4`,
        [input.workspaceId, input.sha256, input.mediaType, input.claimId, input.now],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO evidence_retention_events(
           id,workspace_id,sha256,media_type,claim_id,disposition,reason,metadata_json,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.event.id,
          input.event.workspaceId,
          input.event.sha256,
          input.event.mediaType,
          input.event.claimId ?? null,
          input.event.disposition,
          input.event.reason,
          input.event.metadata,
          input.event.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           id,workspace_id,actor_id,action,target_type,target_id,request_id,ip_hash,metadata_json,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          input.audit.id,
          input.audit.workspaceId ?? null,
          input.audit.actorId,
          input.audit.action,
          input.audit.targetType,
          input.audit.targetId,
          input.audit.requestId,
          input.audit.ipHash ?? null,
          input.audit.metadata,
          input.audit.createdAt,
        ],
      );
      return true;
    });
  }

  async releaseFinalEvidenceDeletion(
    input: Parameters<ControlPlaneRepository['releaseFinalEvidenceDeletion']>[0],
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE evidence_object_lifecycle
          SET status='active',claim_id=NULL,claimed_until=NULL
        WHERE workspace_id=$1 AND sha256=$2 AND media_type=$3
          AND status IN ('claimed','deleting') AND claim_id=$4`,
      [input.workspaceId, input.sha256, input.mediaType, input.claimId],
    );
    return result.rowCount === 1;
  }

  async appendEvidenceRetentionEvent(event: EvidenceRetentionEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO evidence_retention_events(
         id,workspace_id,sha256,media_type,claim_id,disposition,reason,metadata_json,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.workspaceId,
        event.sha256,
        event.mediaType,
        event.claimId ?? null,
        event.disposition,
        event.reason,
        event.metadata,
        event.createdAt,
      ],
    );
  }

  async appendEvidenceRetentionEventAndAudit(
    event: EvidenceRetentionEventRecord,
    audit: AuditEventRecord,
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO evidence_retention_events(
           id,workspace_id,sha256,media_type,claim_id,disposition,reason,metadata_json,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.workspaceId,
          event.sha256,
          event.mediaType,
          event.claimId ?? null,
          event.disposition,
          event.reason,
          event.metadata,
          event.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events(
           id,workspace_id,actor_id,action,target_type,target_id,request_id,ip_hash,metadata_json,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [
          audit.id,
          audit.workspaceId ?? null,
          audit.actorId,
          audit.action,
          audit.targetType,
          audit.targetId,
          audit.requestId,
          audit.ipHash ?? null,
          audit.metadata,
          audit.createdAt,
        ],
      );
    });
  }

  async listWorkspaceArtifactInventory(
    workspaceId: string,
    limit: number,
  ): Promise<readonly WorkspaceArtifactInventoryRecord[]> {
    const rows = await this.pool.query<{
      project_id: string;
      upload_id: string;
      sha256: string;
      byte_length: string | number;
      media_type: string;
      finalized_at: Date;
      lifecycle_status: EvidenceObjectLifecycleRecord['status'];
    }>(
      `SELECT u.project_id,u.id AS upload_id,o.sha256,o.byte_length,o.media_type,u.finalized_at,
              COALESCE(l.status,'active') AS lifecycle_status
         FROM artifact_uploads u
         JOIN artifact_objects o ON o.upload_id=u.id
         LEFT JOIN evidence_object_lifecycle l ON
           l.workspace_id=u.workspace_id AND l.sha256=o.sha256 AND l.media_type=o.media_type
        WHERE u.workspace_id=$1 AND u.status='finalized' AND o.status='finalized'
        ORDER BY u.project_id,o.sha256,o.media_type,u.id
        LIMIT $2`,
      [workspaceId, limit],
    );
    return rows.rows.map((row) => ({
      projectId: row.project_id,
      uploadId: row.upload_id,
      sha256: row.sha256,
      byteLength: Number(row.byte_length),
      mediaType: row.media_type,
      finalizedAt: iso(row.finalized_at),
      lifecycleStatus: row.lifecycle_status,
    }));
  }

  async finalizeUpload(
    uploadId: string,
    manifestHash: string,
    promoted: readonly StoredObject[],
    now: string,
  ): Promise<ArtifactUploadRecord> {
    return transaction(this.pool, async (client) => {
      const workspace = (
        await client.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM artifact_uploads WHERE id=$1',
          [uploadId],
        )
      ).rows[0];
      if (!workspace) throw new RepositoryNotFoundError('Upload not found');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${workspace.workspace_id}`,
      ]);
      await client.query('SELECT id FROM artifact_uploads WHERE id=$1 FOR UPDATE', [uploadId]);
      const current = await this.uploadById(client, uploadId);
      if (!current) throw new RepositoryNotFoundError('Upload not found');
      if (current.status === 'finalized') {
        if (current.manifestHash !== manifestHash)
          throw new RepositoryConflictError('Finalized upload has another manifest');
        return current;
      }
      if (
        current.status !== 'staged' ||
        current.objects.some((object) => object.status !== 'staged')
      ) {
        throw new RepositoryConflictError(
          'Every expected object must be staged before finalization',
        );
      }
      const byIdentity = new Map(
        promoted.map((object) => [artifactObjectIdentity(object.sha256, object.mediaType), object]),
      );
      if (byIdentity.size !== current.objects.length)
        throw new RepositoryConflictError('Promoted object set is incomplete');
      for (const expected of current.objects) {
        const object = byIdentity.get(artifactObjectIdentity(expected.sha256, expected.mediaType));
        if (
          !object ||
          object.byteLength !== expected.byteLength ||
          object.mediaType !== expected.mediaType
        )
          throw new RepositoryConflictError(`Promoted object mismatch: ${expected.sha256}`);
        await client.query(
          `UPDATE artifact_objects SET status='finalized',final_key=$4
           WHERE upload_id=$1 AND sha256=$2 AND media_type=$3`,
          [uploadId, expected.sha256, expected.mediaType, object.key],
        );
      }
      await client.query(
        `UPDATE artifact_uploads SET status='finalized',manifest_hash=$2,finalized_at=$3 WHERE id=$1`,
        [uploadId, manifestHash, now],
      );
      for (const object of current.objects) {
        await client.query(
          `INSERT INTO evidence_object_lifecycle(
             workspace_id,sha256,media_type,byte_length,retention_class,status,
             first_finalized_at,last_finalized_at
           ) VALUES ($1,$2,$3,$4,$5,'active',$6,$6)
           ON CONFLICT (workspace_id,sha256,media_type) DO UPDATE SET
             byte_length=EXCLUDED.byte_length,
             retention_class=CASE
               WHEN evidence_object_lifecycle.retention_class='diagnostic'
                 OR EXCLUDED.retention_class='diagnostic' THEN 'diagnostic'
               ELSE 'standard'
             END,
             status='active',
             last_finalized_at=GREATEST(evidence_object_lifecycle.last_finalized_at,EXCLUDED.last_finalized_at),
             claim_id=NULL,claimed_until=NULL,deleted_at=NULL`,
          [
            current.workspaceId,
            object.sha256,
            object.mediaType,
            object.byteLength,
            object.mediaType === 'video/mp4' || object.mediaType === 'video/webm'
              ? 'diagnostic'
              : 'standard',
            now,
          ],
        );
      }
      return (await this.uploadById(client, uploadId))!;
    });
  }

  async createChannel(
    input: Parameters<ControlPlaneRepository['createChannel']>[0],
  ): Promise<ChannelRecord> {
    const result = await this.pool.query<ChannelRow>(
      `INSERT INTO channels(id,workspace_id,project_id,slug,name,kind,policy_json,webhook_ids,analytics_token_hash,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.slug,
        input.name,
        input.kind,
        input.policy,
        JSON.stringify(input.webhookIds),
        input.analyticsTokenHash,
        input.now,
      ],
    );
    const row =
      result.rows[0] ??
      (await this.pool.query<ChannelRow>('SELECT * FROM channels WHERE id=$1', [input.id])).rows[0];
    if (!row) throw new Error('Could not create Channel');
    const value = channel(row);
    if (
      value.workspaceId !== input.workspaceId ||
      value.projectId !== input.projectId ||
      value.slug !== input.slug ||
      value.name !== input.name ||
      value.kind !== input.kind ||
      stableStringify(value.policy) !== stableStringify(input.policy) ||
      stableStringify(value.webhookIds) !== stableStringify(input.webhookIds) ||
      value.analyticsTokenHash !== input.analyticsTokenHash
    ) {
      throw new RepositoryConflictError('Channel idempotency conflict');
    }
    return value;
  }

  async getChannel(
    workspaceId: string,
    projectId: string,
    channelId: string,
  ): Promise<ChannelRecord | undefined> {
    const row = (
      await this.pool.query<ChannelRow>(
        'SELECT * FROM channels WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
        [channelId, workspaceId, projectId],
      )
    ).rows[0];
    return row ? channel(row) : undefined;
  }

  async listChannels(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ChannelRecord[]> {
    const result = await this.pool.query<ChannelRow>(
      'SELECT * FROM channels WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3',
      [workspaceId, projectId, limit],
    );
    return result.rows.map(channel);
  }

  async resolveHostedPublication(
    route:
      | {
          readonly kind: 'path';
          readonly workspaceSlug: string;
          readonly projectSlug: string;
          readonly channelSlug: string;
        }
      | { readonly kind: 'hostname'; readonly hostname: string },
  ): Promise<HostedPublicationRecord | undefined> {
    const hostname =
      route.kind === 'hostname' ? normalizeCustomDomainHostname(route.hostname) : undefined;
    const query =
      route.kind === 'path'
        ? {
            text: `SELECT to_jsonb(w) AS workspace_record,
                          to_jsonb(p) AS project_record,
                          to_jsonb(c) AS channel_record,
                          CASE WHEN r.id IS NULL THEN NULL ELSE to_jsonb(r) END AS release_record,
                          NULL::jsonb AS custom_domain_record
                     FROM workspaces w
                     JOIN projects p ON p.workspace_id=w.id
                     JOIN channels c ON c.workspace_id=w.id AND c.project_id=p.id
                LEFT JOIN releases r ON r.id=c.current_release_id
                                    AND r.workspace_id=c.workspace_id
                                    AND r.project_id=c.project_id
                                    AND r.channel_id=c.id
                    WHERE w.slug=$1 AND p.slug=$2 AND c.slug=$3`,
            values: [route.workspaceSlug, route.projectSlug, route.channelSlug],
          }
        : {
            text: `SELECT to_jsonb(w) AS workspace_record,
                          to_jsonb(p) AS project_record,
                          to_jsonb(c) AS channel_record,
                          CASE WHEN r.id IS NULL THEN NULL ELSE to_jsonb(r) END AS release_record,
                          to_jsonb(d) AS custom_domain_record
                     FROM custom_domains d
                     JOIN workspaces w ON w.id=d.workspace_id
                     JOIN projects p ON p.workspace_id=d.workspace_id AND p.id=d.project_id
                     JOIN channels c ON c.workspace_id=d.workspace_id
                                    AND c.project_id=d.project_id
                                    AND c.id=d.channel_id
                LEFT JOIN releases r ON r.id=c.current_release_id
                                    AND r.workspace_id=c.workspace_id
                                    AND r.project_id=c.project_id
                                    AND r.channel_id=c.id
                    WHERE d.hostname=$1 AND d.status='active'`,
            values: [hostname],
          };
    const row = (await this.pool.query<HostedPublicationRow>(query.text, query.values)).rows[0];
    if (!row) return undefined;
    return {
      workspace: workspace(row.workspace_record),
      project: project(row.project_record),
      channel: channel(row.channel_record),
      ...(row.release_record ? { release: release(row.release_record) } : {}),
      ...(row.custom_domain_record ? { customDomain: customDomain(row.custom_domain_record) } : {}),
    };
  }

  async createCustomDomain(input: CustomDomainRecord): Promise<CustomDomainRecord> {
    if (input.version !== 1) {
      throw new RepositoryConflictError('Custom domain must start at version 1');
    }
    const result = await this.pool.query<CustomDomainRow>(
      `INSERT INTO custom_domains(
         id,workspace_id,project_id,channel_id,hostname,routing_target,status,dns_status,
         challenge_name,challenge_value,dns_checked_at,dns_verified_at,provisioning_json,
         version,created_by,created_at,updated_at,removed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.projectId,
        input.channelId,
        input.hostname,
        input.routingTarget,
        input.status,
        input.dnsProof.status,
        input.dnsProof.challengeName,
        input.dnsProof.challengeValue,
        input.dnsProof.checkedAt ?? null,
        input.dnsProof.verifiedAt ?? null,
        input.provisioning ?? null,
        input.version,
        input.createdBy,
        input.createdAt,
        input.updatedAt,
        input.removedAt ?? null,
      ],
    );
    const row =
      result.rows[0] ??
      (
        await this.pool.query<CustomDomainRow>('SELECT * FROM custom_domains WHERE id=$1', [
          input.id,
        ])
      ).rows[0];
    if (!row) throw new Error('Could not create custom domain');
    const value = customDomain(row);
    if (stableStringify(value) !== stableStringify(input)) {
      throw new RepositoryConflictError('Custom domain idempotency conflict');
    }
    return value;
  }

  async getCustomDomain(
    workspaceId: string,
    projectId: string,
    channelId: string,
    domainId: string,
  ): Promise<CustomDomainRecord | undefined> {
    const row = (
      await this.pool.query<CustomDomainRow>(
        `SELECT * FROM custom_domains
         WHERE id=$1 AND workspace_id=$2 AND project_id=$3 AND channel_id=$4`,
        [domainId, workspaceId, projectId, channelId],
      )
    ).rows[0];
    return row ? customDomain(row) : undefined;
  }

  async getActiveCustomDomainByHostname(hostname: string): Promise<CustomDomainRecord | undefined> {
    const normalized = normalizeCustomDomainHostname(hostname);
    const row = (
      await this.pool.query<CustomDomainRow>(
        "SELECT * FROM custom_domains WHERE hostname=$1 AND status='active'",
        [normalized],
      )
    ).rows[0];
    return row ? customDomain(row) : undefined;
  }

  async listCustomDomains(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly CustomDomainRecord[]> {
    const result = await this.pool.query<CustomDomainRow>(
      `SELECT * FROM custom_domains
       WHERE workspace_id=$1 AND project_id=$2 AND channel_id=$3
       ORDER BY created_at DESC,id DESC LIMIT $4`,
      [workspaceId, projectId, channelId, limit],
    );
    return result.rows.map(customDomain);
  }

  async updateCustomDomain(input: {
    record: CustomDomainRecord;
    expectedVersion: number;
  }): Promise<CustomDomainRecord> {
    if (input.record.version !== input.expectedVersion + 1) {
      throw new RepositoryConflictError('Custom domain version is invalid');
    }
    return transaction(this.pool, async (client) => {
      const row = (
        await client.query<CustomDomainRow>(
          `SELECT * FROM custom_domains
           WHERE id=$1 AND workspace_id=$2 AND project_id=$3 AND channel_id=$4 FOR UPDATE`,
          [
            input.record.id,
            input.record.workspaceId,
            input.record.projectId,
            input.record.channelId,
          ],
        )
      ).rows[0];
      if (!row) throw new RepositoryNotFoundError('Custom domain not found');
      const current = customDomain(row);
      if (current.version !== input.expectedVersion) {
        throw new RepositoryConflictError('Custom domain changed');
      }
      if (
        input.record.workspaceId !== current.workspaceId ||
        input.record.projectId !== current.projectId ||
        input.record.channelId !== current.channelId ||
        input.record.hostname !== current.hostname ||
        input.record.routingTarget !== current.routingTarget ||
        input.record.createdAt !== current.createdAt ||
        input.record.createdBy !== current.createdBy
      ) {
        throw new RepositoryConflictError('Custom domain immutable identity changed');
      }
      const updated = await client.query<CustomDomainRow>(
        `UPDATE custom_domains SET
           status=$2,dns_status=$3,challenge_name=$4,challenge_value=$5,dns_checked_at=$6,
           dns_verified_at=$7,provisioning_json=$8,version=$9,updated_at=$10,removed_at=$11
         WHERE id=$1 RETURNING *`,
        [
          input.record.id,
          input.record.status,
          input.record.dnsProof.status,
          input.record.dnsProof.challengeName,
          input.record.dnsProof.challengeValue,
          input.record.dnsProof.checkedAt ?? null,
          input.record.dnsProof.verifiedAt ?? null,
          input.record.provisioning ?? null,
          input.record.version,
          input.record.updatedAt,
          input.record.removedAt ?? null,
        ],
      );
      return customDomain(updated.rows[0]!);
    });
  }

  async promoteRelease(
    input: Parameters<ControlPlaneRepository['promoteRelease']>[0],
  ): Promise<ReleaseRecord> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${input.workspaceId}`,
      ]);
      const existing = (
        await client.query<ReleaseRow>(
          'SELECT workspace_id,project_id,status,release_json,idempotency_key,request_hash,evidence_json FROM releases WHERE channel_id=$1 AND idempotency_key=$2',
          [input.channelId, input.idempotencyKey],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash)
          throw new RepositoryConflictError('Release idempotency conflict');
        return release(existing);
      }
      const channelRow = (
        await client.query<ChannelRow>(
          'SELECT * FROM channels WHERE id=$1 AND workspace_id=$2 AND project_id=$3 FOR UPDATE',
          [input.channelId, input.workspaceId, input.projectId],
        )
      ).rows[0];
      if (!channelRow) throw new RepositoryNotFoundError('Channel not found');
      const settled = (
        await client.query<ReleaseRow>(
          'SELECT workspace_id,project_id,status,release_json,idempotency_key,request_hash,evidence_json FROM releases WHERE channel_id=$1 AND idempotency_key=$2',
          [input.channelId, input.idempotencyKey],
        )
      ).rows[0];
      if (settled) {
        if (settled.request_hash !== input.requestHash)
          throw new RepositoryConflictError('Release idempotency conflict');
        return release(settled);
      }
      if (input.promotionEvidence?.artifactUploadId) {
        await this.assertUploadObjectsActive(
          client,
          input.workspaceId,
          input.promotionEvidence.artifactUploadId,
        );
      }
      if (channelRow.current_release_id !== (input.expectedCurrentReleaseId ?? null)) {
        throw new RepositoryConflictError('Channel current Release changed');
      }
      const nextSequence = Number(channelRow.sequence) + 1;
      const releaseValue = ReleaseSchema.parse({
        ...input.release,
        channelId: input.channelId,
        sequence: nextSequence,
        status: 'published',
        publishedAt: input.now,
        ...(channelRow.current_release_id
          ? { supersedesReleaseId: channelRow.current_release_id }
          : {}),
      });
      if (channelRow.current_release_id) {
        await client.query("UPDATE releases SET status='superseded' WHERE id=$1", [
          channelRow.current_release_id,
        ]);
      }
      await client.query(
        `INSERT INTO releases(id,workspace_id,project_id,channel_id,sequence,status,release_json,manifest_hash,idempotency_key,request_hash,published_at,supersedes_release_id,evidence_json)
         VALUES ($1,$2,$3,$4,$5,'published',$6,$7,$8,$9,$10,$11,$12)`,
        [
          releaseValue.id,
          input.workspaceId,
          input.projectId,
          input.channelId,
          nextSequence,
          releaseValue,
          releaseValue.manifestHash,
          input.idempotencyKey,
          input.requestHash,
          input.now,
          channelRow.current_release_id,
          input.promotionEvidence ?? null,
        ],
      );
      await client.query('UPDATE channels SET current_release_id=$2,sequence=$3 WHERE id=$1', [
        input.channelId,
        releaseValue.id,
        nextSequence,
      ]);
      return {
        release: releaseValue,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        ...(input.promotionEvidence ? { promotionEvidence: input.promotionEvidence } : {}),
      };
    });
  }

  async rollbackRelease(
    input: Parameters<ControlPlaneRepository['rollbackRelease']>[0],
  ): Promise<ReleaseRecord> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenebook-evidence-retention:${input.workspaceId}`,
      ]);
      const existing = (
        await client.query<ReleaseRow>(
          'SELECT workspace_id,project_id,status,release_json,idempotency_key,request_hash,evidence_json FROM releases WHERE channel_id=$1 AND idempotency_key=$2',
          [input.channelId, input.idempotencyKey],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== input.requestHash)
          throw new RepositoryConflictError('Rollback idempotency conflict');
        return release(existing);
      }
      const channelRow = (
        await client.query<ChannelRow>(
          'SELECT * FROM channels WHERE id=$1 AND workspace_id=$2 AND project_id=$3 FOR UPDATE',
          [input.channelId, input.workspaceId, input.projectId],
        )
      ).rows[0];
      if (!channelRow) throw new RepositoryNotFoundError('Channel not found');
      const settled = (
        await client.query<ReleaseRow>(
          'SELECT workspace_id,project_id,status,release_json,idempotency_key,request_hash,evidence_json FROM releases WHERE channel_id=$1 AND idempotency_key=$2',
          [input.channelId, input.idempotencyKey],
        )
      ).rows[0];
      if (settled) {
        if (settled.request_hash !== input.requestHash)
          throw new RepositoryConflictError('Rollback idempotency conflict');
        return release(settled);
      }
      if (channelRow.current_release_id !== input.expectedCurrentReleaseId)
        throw new RepositoryConflictError('Channel current Release changed');
      const target = (
        await client.query<ReleaseRow & { id: string }>(
          'SELECT id,workspace_id,project_id,status,release_json,idempotency_key,request_hash,evidence_json FROM releases WHERE id=$1 AND channel_id=$2',
          [input.targetReleaseId, input.channelId],
        )
      ).rows[0];
      if (!target) throw new RepositoryNotFoundError('Rollback target not found');
      const original = ReleaseSchema.parse(target.release_json);
      const sequence = Number(channelRow.sequence) + 1;
      const releaseValue = ReleaseSchema.parse({
        ...original,
        id: input.newReleaseId,
        sequence,
        status: 'published',
        publishedAt: input.now,
        supersedesReleaseId: input.expectedCurrentReleaseId,
      });
      await client.query("UPDATE releases SET status='rolled-back' WHERE id=$1", [
        input.expectedCurrentReleaseId,
      ]);
      await client.query(
        `INSERT INTO releases(id,workspace_id,project_id,channel_id,sequence,status,release_json,manifest_hash,idempotency_key,request_hash,published_at,supersedes_release_id,rollback_of_release_id,evidence_json)
         VALUES ($1,$2,$3,$4,$5,'published',$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          releaseValue.id,
          input.workspaceId,
          input.projectId,
          input.channelId,
          sequence,
          releaseValue,
          releaseValue.manifestHash,
          input.idempotencyKey,
          input.requestHash,
          input.now,
          input.expectedCurrentReleaseId,
          input.targetReleaseId,
          null,
        ],
      );
      await client.query('UPDATE channels SET current_release_id=$2,sequence=$3 WHERE id=$1', [
        input.channelId,
        releaseValue.id,
        sequence,
      ]);
      return {
        release: releaseValue,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      };
    });
  }

  async getRelease(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | undefined> {
    const row = (
      await this.pool.query<ReleaseRow>(
        'SELECT workspace_id,project_id,status,release_json,idempotency_key,request_hash,evidence_json FROM releases WHERE id=$1 AND workspace_id=$2 AND project_id=$3',
        [releaseId, workspaceId, projectId],
      )
    ).rows[0];
    return row ? release(row) : undefined;
  }

  async listReleases(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly ReleaseRecord[]> {
    const result = await this.pool.query<ReleaseRow>(
      `SELECT workspace_id,project_id,status,release_json,idempotency_key,request_hash,evidence_json
         FROM releases
        WHERE workspace_id=$1 AND project_id=$2 AND channel_id=$3
        ORDER BY sequence DESC,id DESC LIMIT $4`,
      [workspaceId, projectId, channelId, limit],
    );
    return result.rows.map(release);
  }

  async ingestAnalytics(event: AnalyticsEventRecord): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO analytics_events(id,schema_version,workspace_id,project_id,channel_id,release_id,scene_id,step_id,event_type,occurred_at,anonymous_id_hash,session_id_hash,properties_json)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
       WHERE EXISTS (SELECT 1 FROM releases WHERE id=$6 AND channel_id=$5 AND workspace_id=$3 AND project_id=$4)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.schemaVersion,
        event.workspaceId,
        event.projectId,
        event.channelId,
        event.releaseId,
        event.sceneId,
        event.stepId ?? null,
        event.type,
        event.occurredAt,
        event.anonymousIdHash ?? null,
        event.sessionIdHash ?? null,
        event.properties,
      ],
    );
    return result.rowCount === 1;
  }

  async aggregateAnalytics(input: {
    workspaceId: string;
    projectId: string;
    channelId: string;
    releaseId: string;
    from: string;
    to: string;
  }): Promise<readonly AnalyticsAggregateRow[]> {
    const result = await this.pool.query<AnalyticsAggregateDatabaseRow>(
      `WITH scoped AS (
         SELECT scene_id,step_id,event_type,
                COALESCE(session_id_hash,anonymous_id_hash,'event:' || id) AS subject_key
           FROM analytics_events
          WHERE workspace_id=$1 AND project_id=$2 AND channel_id=$3 AND release_id=$4
            AND occurred_at >= $5 AND occurred_at <= $6
       )
       SELECT scene_id,step_id,event_type,
              GROUPING(scene_id)::int AS scene_grouped,
              GROUPING(step_id)::int AS step_grouped,
              COUNT(*) AS event_count,
              COUNT(DISTINCT subject_key) AS unique_subject_count
         FROM scoped
        GROUP BY GROUPING SETS (
          (event_type),
          (scene_id,event_type),
          (scene_id,step_id,event_type)
        )
       HAVING GROUPING(step_id)=1 OR step_id IS NOT NULL
        ORDER BY GROUPING(scene_id) DESC,GROUPING(step_id) DESC,scene_id,step_id,event_type`,
      [input.workspaceId, input.projectId, input.channelId, input.releaseId, input.from, input.to],
    );
    return result.rows.map((row) => {
      const scope: AnalyticsAggregateRow['scope'] =
        row.scene_grouped === 1 ? 'total' : row.step_grouped === 1 ? 'scene' : 'step';
      return {
        scope,
        ...(row.scene_id ? { sceneId: row.scene_id } : {}),
        ...(scope === 'step' && row.step_id ? { stepId: row.step_id } : {}),
        type: row.event_type,
        eventCount: Number(row.event_count),
        uniqueSubjectCount: Number(row.unique_subject_count),
      };
    });
  }

  async createCtaSubmission(
    input: CtaSubmissionRecord,
    delivery: WebhookDeliveryRecord,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO cta_submissions(id,workspace_id,project_id,channel_id,release_id,scene_id,step_id,cta_id,webhook_id,payload_hash,encrypted_payload,created_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
         WHERE EXISTS (SELECT 1 FROM releases WHERE id=$5 AND channel_id=$4 AND workspace_id=$2 AND project_id=$3)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.id,
          input.workspaceId,
          input.projectId,
          input.channelId,
          input.releaseId,
          input.sceneId,
          input.stepId ?? null,
          input.ctaId,
          input.webhookId,
          input.payloadHash,
          input.encryptedPayload,
          input.createdAt,
        ],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO webhook_deliveries(id,submission_id,webhook_id,status,attempts,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          delivery.id,
          delivery.submissionId,
          delivery.webhookId,
          delivery.status,
          delivery.attempts,
          delivery.nextAttemptAt,
        ],
      );
      return true;
    });
  }

  async claimWebhookDeliveries(
    now: string,
    limit: number,
  ): Promise<readonly WebhookDeliveryRecord[]> {
    return transaction(this.pool, async (client) => {
      const rows = await client.query<DeliveryRow>(
        `SELECT * FROM webhook_deliveries
         WHERE (status IN ('pending','failed') AND next_attempt_at <= $1)
            OR (status='delivering' AND locked_at <= $1::timestamptz - interval '5 minutes')
         ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      if (rows.rows.length > 0) {
        await client.query(
          `UPDATE webhook_deliveries SET status='delivering',locked_at=$2,attempts=attempts+1,updated_at=$2 WHERE id=ANY($1::text[])`,
          [rows.rows.map((row) => row.id), now],
        );
      }
      return rows.rows.map((row) => ({
        id: row.id,
        submissionId: row.submission_id,
        webhookId: row.webhook_id,
        status: 'delivering',
        attempts: row.attempts + 1,
        nextAttemptAt: iso(row.next_attempt_at),
        ...(row.last_status === null ? {} : { lastStatus: row.last_status }),
        ...(row.last_error === null ? {} : { lastError: row.last_error }),
      }));
    });
  }

  async completeWebhookDelivery(
    input: Parameters<ControlPlaneRepository['completeWebhookDelivery']>[0],
  ): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_deliveries SET status=$2,last_status=$3,last_error=$4,next_attempt_at=COALESCE($5,next_attempt_at),locked_at=NULL,updated_at=now() WHERE id=$1`,
      [
        input.id,
        input.succeeded ? 'succeeded' : input.terminal ? 'exhausted' : 'failed',
        input.status ?? null,
        input.error?.slice(0, 2_000) ?? null,
        input.nextAttemptAt ?? null,
      ],
    );
  }

  async getCtaSubmission(id: string): Promise<CtaSubmissionRecord | undefined> {
    const row = (await this.pool.query<CtaRow>('SELECT * FROM cta_submissions WHERE id=$1', [id]))
      .rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      channelId: row.channel_id,
      releaseId: row.release_id,
      sceneId: row.scene_id,
      ...(row.step_id ? { stepId: row.step_id } : {}),
      ctaId: row.cta_id,
      webhookId: row.webhook_id,
      payloadHash: row.payload_hash,
      encryptedPayload: row.encrypted_payload,
      createdAt: iso(row.created_at),
    };
  }

  async appendAudit(event: AuditEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events(id,workspace_id,actor_id,action,target_type,target_id,request_id,ip_hash,metadata_json,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.workspaceId ?? null,
        event.actorId,
        event.action,
        event.targetType,
        event.targetId,
        event.requestId,
        event.ipHash ?? null,
        event.metadata,
        event.createdAt,
      ],
    );
  }

  async listAudit(
    workspaceId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly (AuditEventRecord & { sequence: number })[]> {
    const rows = await this.pool.query<AuditRow>(
      'SELECT * FROM audit_events WHERE workspace_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',
      [workspaceId, afterSequence, limit],
    );
    return rows.rows.map((row) => ({
      sequence: Number(row.sequence),
      id: row.id,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      requestId: row.request_id,
      ...(row.ip_hash ? { ipHash: row.ip_hash } : {}),
      metadata: row.metadata_json,
      createdAt: iso(row.created_at),
    }));
  }
}
