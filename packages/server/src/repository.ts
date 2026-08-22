import type { Pool } from 'pg';

import type {
  AnalyticsAggregateRow,
  AnalyticsEventRecord,
  ActiveUploadLimits,
  ArtifactObjectSpec,
  ArtifactUploadRecord,
  AuditEventRecord,
  ChannelRecord,
  CustomDomainRecord,
  CtaSubmissionRecord,
  IdentityApiTokenRecord,
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
  StudioProjectDocument,
  StudioSceneDocument,
  VerificationBaselineRecord,
  VerificationBuildRecord,
  VerificationJobRecord,
  VerificationRunRecord,
  VerificationRunnerRecord,
  VerificationScheduleRecord,
  WebhookDeliveryRecord,
  WorkspaceRecord,
  HostedPublicationRecord,
  GitHubInstallationBindingRecord,
  GitHubSourceChangeRecord,
  WorkspaceMembershipRecord,
  UserRecord,
  UserSessionRecord,
  EvidenceRetentionClaimRecord,
  EvidenceRetentionEventRecord,
  EvidenceRetentionEvaluationBatch,
  WorkspaceArtifactInventoryRecord,
} from './domain.js';
import type { ChannelPolicy, Release, Review, Scene, PrivacySummary } from '@scenebook/schema';
import type { StoredObject } from './object-store.js';

type ReviewComment = Review['comments'][number];
type ReviewDecision = Review['decisions'][number];

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

export class RepositoryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryNotFoundError';
  }
}

export class RepositoryCapacityError extends Error {
  constructor(
    readonly scope: 'tenant' | 'global',
    readonly resource: 'uploads' | 'bytes',
  ) {
    super(`${scope} active upload ${resource} quota is exhausted`);
    this.name = 'RepositoryCapacityError';
  }
}

export interface ControlPlaneRepository {
  health(): Promise<void>;
  close(): Promise<void>;

  createWorkspace(input: {
    id: string;
    slug: string;
    name: string;
    now: string;
  }): Promise<WorkspaceRecord>;
  getWorkspace(id: string): Promise<WorkspaceRecord | undefined>;
  listProjects(workspaceId: string, limit: number): Promise<readonly ProjectRecord[]>;
  createProject(input: {
    id: string;
    workspaceId: string;
    slug: string;
    name: string;
    now: string;
  }): Promise<ProjectRecord>;
  getProject(workspaceId: string, id: string): Promise<ProjectRecord | undefined>;
  listStudioSceneDocuments(input: {
    workspaceId: string;
    projectId: string;
    limit: number;
    before?: { savedAt: number; sceneId: string };
  }): Promise<readonly StudioSceneDocument[]>;
  getStudioSceneDocument(
    workspaceId: string,
    projectId: string,
    sceneId: string,
  ): Promise<StudioSceneDocument | undefined>;
  listStudioSceneVersions(input: {
    workspaceId: string;
    projectId: string;
    sceneId: string;
    limit: number;
    beforeRevision?: number;
  }): Promise<readonly StudioSceneDocument[]>;
  getStudioSceneVersion(
    workspaceId: string,
    projectId: string,
    sceneId: string,
    revision: number,
  ): Promise<StudioSceneDocument | undefined>;
  studioPayloadIsReferenced(
    workspaceId: string,
    projectId: string,
    sha256: string,
    mediaType: string,
  ): Promise<boolean>;
  putStudioWorkspace(input: {
    workspaceId: string;
    projectId: string;
    writes: readonly {
      expectedRevision: number;
      record: StudioSceneDocument;
    }[];
    project?: {
      expectedRevision: number;
      document: Omit<StudioProjectDocument, 'revision'>;
    };
    actorId: string;
    now: string;
  }): Promise<{
    records: readonly StudioSceneDocument[];
    project?: StudioProjectDocument;
  }>;
  deleteStudioSceneDocument(input: {
    workspaceId: string;
    projectId: string;
    sceneId: string;
    expectedRevision: number;
  }): Promise<boolean>;
  getStudioProjectDocument(
    workspaceId: string,
    projectId: string,
  ): Promise<StudioProjectDocument | undefined>;
  putStudioProjectDocument(input: {
    workspaceId: string;
    projectId: string;
    expectedRevision: number;
    document: Omit<StudioProjectDocument, 'revision'>;
    actorId: string;
    now: string;
  }): Promise<StudioProjectDocument>;

  createUser(input: {
    id: string;
    email: string;
    displayName: string;
    now: string;
  }): Promise<UserRecord>;
  getUser(id: string): Promise<UserRecord | undefined>;
  disableUser(id: string, now: string): Promise<boolean>;
  putWorkspaceMembership(input: WorkspaceMembershipRecord): Promise<WorkspaceMembershipRecord>;
  getWorkspaceMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembershipRecord | undefined>;
  listWorkspaceMemberships(
    workspaceId: string,
    limit: number,
  ): Promise<readonly WorkspaceMembershipRecord[]>;
  revokeWorkspaceMembership(workspaceId: string, userId: string, now: string): Promise<boolean>;
  createIdentityApiToken(input: IdentityApiTokenRecord): Promise<IdentityApiTokenRecord>;
  getIdentityApiToken(id: string): Promise<IdentityApiTokenRecord | undefined>;
  listIdentityApiTokens(
    workspaceId: string,
    userId: string,
    limit: number,
  ): Promise<readonly IdentityApiTokenRecord[]>;
  touchIdentityApiToken(id: string, now: string): Promise<void>;
  revokeIdentityApiToken(id: string, userId: string, now: string): Promise<boolean>;
  createUserSession(input: UserSessionRecord): Promise<UserSessionRecord>;
  getUserSession(id: string): Promise<UserSessionRecord | undefined>;
  revokeUserSession(id: string, userId: string, now: string): Promise<boolean>;
  createPortalGrant(input: PortalGrantRecord): Promise<PortalGrantRecord>;
  getPortalGrant(id: string): Promise<PortalGrantRecord | undefined>;
  listPortalGrants(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly PortalGrantRecord[]>;
  findPortalGrantForUser(
    workspaceId: string,
    projectId: string,
    channelId: string,
    userId: string,
    now: string,
  ): Promise<PortalGrantRecord | undefined>;
  revokePortalGrant(id: string, workspaceId: string, now: string): Promise<boolean>;
  createPrivateShareLink(input: PrivateShareLinkRecord): Promise<PrivateShareLinkRecord>;
  getPrivateShareLink(id: string): Promise<PrivateShareLinkRecord | undefined>;
  listPrivateShareLinks(grantId: string, limit: number): Promise<readonly PrivateShareLinkRecord[]>;
  revokePrivateShareLink(id: string, now: string): Promise<boolean>;
  createPublicationLoginHandoff(
    input: PublicationLoginHandoffRecord,
  ): Promise<PublicationLoginHandoffRecord>;
  getActivePublicationLoginHandoff(input: {
    tokenHash: string;
    audienceOrigin: string;
    now: string;
  }): Promise<PublicationLoginHandoffRecord | undefined>;
  consumePublicationLoginHandoffAndAudit(
    input: { tokenHash: string; audienceOrigin: string; now: string },
    audit: AuditEventRecord,
  ): Promise<PublicationLoginHandoffRecord | undefined>;
  bindRepository(input: RepositoryBinding): Promise<RepositoryBinding>;
  getRepositoryBinding(
    workspaceId: string,
    projectId: string,
    repository: string,
  ): Promise<RepositoryBinding | undefined>;
  getRepositoryBindingById(
    workspaceId: string,
    projectId: string,
    bindingId: string,
  ): Promise<RepositoryBinding | undefined>;
  listRepositoryBindings(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly RepositoryBinding[]>;
  putGitHubInstallationBinding(
    input: GitHubInstallationBindingRecord,
  ): Promise<GitHubInstallationBindingRecord>;
  getGitHubInstallationBinding(
    workspaceId: string,
    projectId: string,
    bindingId: string,
  ): Promise<GitHubInstallationBindingRecord | undefined>;
  getActiveGitHubInstallationBindingForRepository(
    workspaceId: string,
    projectId: string,
    repositoryBindingId: string,
  ): Promise<GitHubInstallationBindingRecord | undefined>;
  withGitHubCheckRunLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T>;
  listGitHubInstallationBindings(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly GitHubInstallationBindingRecord[]>;
  revokeGitHubInstallationBinding(input: {
    workspaceId: string;
    projectId: string;
    bindingId: string;
    expectedVersion: number;
    now: string;
  }): Promise<GitHubInstallationBindingRecord>;
  claimGitHubSourceChange(input: {
    record: GitHubSourceChangeRecord;
    leaseId: string;
    leaseDurationMs: number;
  }): Promise<{ readonly record: GitHubSourceChangeRecord; readonly claimed: boolean }>;
  renewGitHubSourceChangeLease(input: {
    workspaceId: string;
    projectId: string;
    changeId: string;
    leaseId: string;
    leaseDurationMs: number;
  }): Promise<GitHubSourceChangeRecord>;
  completeGitHubSourceChange(input: {
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
  }): Promise<GitHubSourceChangeRecord>;
  failGitHubSourceChange(input: {
    workspaceId: string;
    projectId: string;
    changeId: string;
    leaseId: string;
    failureCode: string;
  }): Promise<GitHubSourceChangeRecord>;
  getGitHubSourceChange(
    workspaceId: string,
    projectId: string,
    changeId: string,
  ): Promise<GitHubSourceChangeRecord | undefined>;
  consumeOidcToken(input: {
    tokenId: string;
    repository: string;
    commit: string;
    expiresAt: string;
  }): Promise<boolean>;

  createVerificationSchedule(
    input: VerificationScheduleRecord,
  ): Promise<VerificationScheduleRecord>;
  getVerificationSchedule(
    workspaceId: string,
    projectId: string,
    scheduleId: string,
  ): Promise<VerificationScheduleRecord | undefined>;
  listVerificationSchedules(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationScheduleRecord[]>;
  updateVerificationSchedule(input: {
    workspaceId: string;
    projectId: string;
    scheduleId: string;
    expectedVersion: number;
    patch: Partial<
      Pick<
        VerificationScheduleRecord,
        | 'name'
        | 'sourceRef'
        | 'environmentId'
        | 'runTargetIds'
        | 'intervalSeconds'
        | 'freshnessTargetSeconds'
        | 'maxRuntimeSeconds'
        | 'maxAttempts'
      >
    >;
    now: string;
  }): Promise<VerificationScheduleRecord>;
  setVerificationScheduleStatus(input: {
    workspaceId: string;
    projectId: string;
    scheduleId: string;
    status: VerificationScheduleRecord['status'];
    nextDueAt?: string;
    now: string;
  }): Promise<VerificationScheduleRecord>;
  materializeDueVerificationJobs(
    now: string,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]>;
  createManualVerificationJob(input: VerificationJobRecord): Promise<VerificationJobRecord>;
  getVerificationJob(
    workspaceId: string,
    projectId: string,
    jobId: string,
  ): Promise<VerificationJobRecord | undefined>;
  listVerificationJobs(
    workspaceId: string,
    projectId: string,
    scheduleId: string | undefined,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]>;
  cancelVerificationJob(input: {
    workspaceId: string;
    projectId: string;
    jobId: string;
    result: VerificationJobRecord['result'];
    resultHash: string;
    now: string;
  }): Promise<VerificationJobRecord>;
  requeueExpiredVerificationJobs(
    now: string,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]>;
  createVerificationRunner(input: VerificationRunnerRecord): Promise<VerificationRunnerRecord>;
  getVerificationRunner(id: string): Promise<VerificationRunnerRecord | undefined>;
  listVerificationRunners(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationRunnerRecord[]>;
  rotateVerificationRunnerToken(input: {
    workspaceId: string;
    projectId: string;
    runnerId: string;
    tokenHash: string;
    now: string;
  }): Promise<VerificationRunnerRecord>;
  revokeVerificationRunner(input: {
    workspaceId: string;
    projectId: string;
    runnerId: string;
    now: string;
  }): Promise<boolean>;
  touchVerificationRunner(runnerId: string, now: string): Promise<void>;
  claimVerificationJob(input: {
    runnerId: string;
    now: string;
    leaseId: string;
    leaseSeconds: number;
  }): Promise<VerificationJobRecord | undefined>;
  renewVerificationJobLease(input: {
    runnerId: string;
    jobId: string;
    leaseId: string;
    now: string;
    leaseSeconds: number;
  }): Promise<VerificationJobRecord>;
  completeVerificationJob(input: {
    runnerId: string;
    jobId: string;
    leaseId: string;
    result: NonNullable<VerificationJobRecord['result']>;
    resultHash: string;
    now: string;
  }): Promise<VerificationJobRecord>;

  createSceneRevision(input: {
    id: string;
    workspaceId: string;
    projectId: string;
    scene: Scene;
    revision: string;
    privacy: PrivacySummary;
    createdBy: string;
    now: string;
  }): Promise<SceneRevisionRecord>;
  getSceneRevision(
    workspaceId: string,
    projectId: string,
    sceneId: string,
    revision: string,
  ): Promise<SceneRevisionRecord | undefined>;
  listSceneRevisions(
    workspaceId: string,
    projectId: string,
    sceneId: string,
    limit: number,
  ): Promise<readonly SceneRevisionRecord[]>;
  listSceneHeads(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly SceneRevisionRecord[]>;

  createReview(workspaceId: string, projectId: string, review: Review): Promise<ReviewRecord>;
  getReview(
    workspaceId: string,
    projectId: string,
    reviewId: string,
  ): Promise<ReviewRecord | undefined>;
  listReviews(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ReviewRecord[]>;
  addReviewComment(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    comment: ReviewComment,
  ): Promise<ReviewRecord>;
  setReviewCommentResolution(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    commentId: string,
    expectedResolvedAt: string | undefined,
    resolution: { readonly resolvedAt?: string; readonly resolvedBy?: string },
  ): Promise<ReviewRecord>;
  setReviewAssignees(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    expectedAssignedTo: readonly string[],
    assignedTo: readonly string[],
  ): Promise<ReviewRecord>;
  addReviewDecision(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    decision: ReviewDecision,
  ): Promise<ReviewRecord>;

  recordVerificationRun(input: VerificationRunRecord): Promise<VerificationRunRecord>;
  getVerificationRun(
    workspaceId: string,
    projectId: string,
    runId: string,
  ): Promise<VerificationRunRecord | undefined>;
  listVerificationRuns(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationRunRecord[]>;
  recordVerificationBuild(input: VerificationBuildRecord): Promise<VerificationBuildRecord>;
  getVerificationBuild(
    workspaceId: string,
    projectId: string,
    buildId: string,
  ): Promise<VerificationBuildRecord | undefined>;
  listVerificationBuilds(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationBuildRecord[]>;
  recordVerificationBaseline(
    input: VerificationBaselineRecord,
  ): Promise<VerificationBaselineRecord>;
  getVerificationBaseline(
    workspaceId: string,
    projectId: string,
    baselineId: string,
  ): Promise<VerificationBaselineRecord | undefined>;
  listVerificationBaselines(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationBaselineRecord[]>;
  recordReviewApproval(input: ReviewApprovalRecord): Promise<ReviewApprovalRecord>;
  getReviewApproval(
    workspaceId: string,
    projectId: string,
    approvalId: string,
  ): Promise<ReviewApprovalRecord | undefined>;
  listReviewApprovals(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ReviewApprovalRecord[]>;

  beginUpload(input: {
    id: string;
    workspaceId: string;
    projectId: string;
    repository: string;
    commit: string;
    ref: string;
    idempotencyKey: string;
    requestHash: string;
    objects: readonly ArtifactObjectSpec[];
    now: string;
    expiresAt: string;
    limits: ActiveUploadLimits;
  }): Promise<ArtifactUploadRecord>;
  getUpload(uploadId: string): Promise<ArtifactUploadRecord | undefined>;
  listWorkspaceFinalizedUploads(
    workspaceId: string,
    limit: number,
  ): Promise<readonly ArtifactUploadRecord[]>;
  getFinalizedUploadByManifest(
    workspaceId: string,
    projectId: string,
    repository: string,
    commit: string,
    manifestHash: string,
  ): Promise<ArtifactUploadRecord | undefined>;
  getFinalizedObject(
    workspaceId: string,
    projectId: string,
    hash: string,
    mediaType: string,
  ): Promise<StoredObject | undefined>;
  markObjectStaged(
    uploadId: string,
    hash: string,
    mediaType: string,
    stagingKey: string,
    now: string,
  ): Promise<ArtifactUploadRecord>;
  finalizeUpload(
    uploadId: string,
    manifestHash: string,
    promoted: readonly StoredObject[],
    now: string,
  ): Promise<ArtifactUploadRecord>;
  claimExpiredUploads(input: {
    now: string;
    limit: number;
    claimId: string;
    claimedUntil: string;
  }): Promise<readonly ArtifactUploadRecord[]>;
  completeExpiredUpload(uploadId: string, claimId: string, now: string): Promise<boolean>;
  listEvidenceRetentionWorkspaceIds(input: {
    afterWorkspaceId?: string;
    limit: number;
  }): Promise<readonly string[]>;
  claimEvidenceRetentionObjects(input: {
    workspaceId: string;
    now: string;
    standardCutoff: string;
    diagnosticCutoff: string;
    limit: number;
    claimId: string;
    claimedUntil: string;
    dryRun: boolean;
  }): Promise<EvidenceRetentionEvaluationBatch>;
  beginFinalEvidenceDeletion(input: {
    workspaceId: string;
    sha256: string;
    mediaType: string;
    claimId: string;
    now: string;
  }): Promise<EvidenceRetentionClaimRecord | undefined>;
  completeFinalEvidenceDeletion(input: {
    workspaceId: string;
    sha256: string;
    mediaType: string;
    claimId: string;
    now: string;
    event: EvidenceRetentionEventRecord;
    audit: AuditEventRecord;
  }): Promise<boolean>;
  releaseFinalEvidenceDeletion(input: {
    workspaceId: string;
    sha256: string;
    mediaType: string;
    claimId: string;
  }): Promise<boolean>;
  appendEvidenceRetentionEvent(event: EvidenceRetentionEventRecord): Promise<void>;
  appendEvidenceRetentionEventAndAudit(
    event: EvidenceRetentionEventRecord,
    audit: AuditEventRecord,
  ): Promise<void>;
  listWorkspaceArtifactInventory(
    workspaceId: string,
    limit: number,
  ): Promise<readonly WorkspaceArtifactInventoryRecord[]>;

  createChannel(input: {
    id: string;
    workspaceId: string;
    projectId: string;
    slug: string;
    name: string;
    kind: ChannelRecord['kind'];
    policy: ChannelPolicy;
    webhookIds: readonly string[];
    analyticsTokenHash: string;
    now: string;
  }): Promise<ChannelRecord>;
  getChannel(
    workspaceId: string,
    projectId: string,
    channelId: string,
  ): Promise<ChannelRecord | undefined>;
  listChannels(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ChannelRecord[]>;
  resolveHostedPublication(
    route:
      | {
          readonly kind: 'path';
          readonly workspaceSlug: string;
          readonly projectSlug: string;
          readonly channelSlug: string;
        }
      | { readonly kind: 'hostname'; readonly hostname: string },
  ): Promise<HostedPublicationRecord | undefined>;
  createCustomDomain(input: CustomDomainRecord): Promise<CustomDomainRecord>;
  getCustomDomain(
    workspaceId: string,
    projectId: string,
    channelId: string,
    domainId: string,
  ): Promise<CustomDomainRecord | undefined>;
  getActiveCustomDomainByHostname(hostname: string): Promise<CustomDomainRecord | undefined>;
  listCustomDomains(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly CustomDomainRecord[]>;
  updateCustomDomain(input: {
    record: CustomDomainRecord;
    expectedVersion: number;
  }): Promise<CustomDomainRecord>;
  promoteRelease(input: {
    workspaceId: string;
    projectId: string;
    channelId: string;
    release: Release;
    expectedCurrentReleaseId?: string;
    idempotencyKey: string;
    requestHash: string;
    promotionEvidence?: ReleasePromotionEvidence;
    now: string;
  }): Promise<ReleaseRecord>;
  rollbackRelease(input: {
    workspaceId: string;
    projectId: string;
    channelId: string;
    targetReleaseId: string;
    expectedCurrentReleaseId: string;
    newReleaseId: string;
    idempotencyKey: string;
    requestHash: string;
    now: string;
  }): Promise<ReleaseRecord>;
  getRelease(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | undefined>;
  listReleases(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly ReleaseRecord[]>;

  ingestAnalytics(event: AnalyticsEventRecord): Promise<boolean>;
  aggregateAnalytics(input: {
    workspaceId: string;
    projectId: string;
    channelId: string;
    releaseId: string;
    from: string;
    to: string;
  }): Promise<readonly AnalyticsAggregateRow[]>;
  createCtaSubmission(
    input: CtaSubmissionRecord,
    delivery: WebhookDeliveryRecord,
  ): Promise<boolean>;
  claimWebhookDeliveries(now: string, limit: number): Promise<readonly WebhookDeliveryRecord[]>;
  completeWebhookDelivery(input: {
    id: string;
    succeeded: boolean;
    terminal?: boolean;
    status?: number;
    error?: string;
    nextAttemptAt?: string;
  }): Promise<void>;
  getCtaSubmission(id: string): Promise<CtaSubmissionRecord | undefined>;

  appendAudit(event: AuditEventRecord): Promise<void>;
  listAudit(
    workspaceId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly (AuditEventRecord & { sequence: number })[]>;
}

export interface DatabasePoolOwner {
  readonly pool: Pool;
}
