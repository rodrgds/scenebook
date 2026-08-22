import type {
  Approval,
  Baseline,
  BuildArtifact,
  ChannelPolicy,
  PrivacySummary,
  Release,
  Review,
  RunArtifact,
  Scene,
  JsonObject,
} from '@scenebook/schema';

export interface WorkspaceRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

/**
 * Mutable creator-working state for the hosted Studio. This is deliberately
 * separate from canonical Scene revisions and immutable Run/Release evidence:
 * the browser compacts media into content-addressed payload references before
 * this document reaches PostgreSQL.
 */
export interface StudioSceneDocument {
  readonly id: string;
  readonly scene: JsonObject;
  readonly savedAt: number;
  readonly revision: number;
  readonly storageVersion: 4;
  readonly payloadRefs: readonly StudioPayloadReference[];
}

export interface StudioPayloadReference {
  readonly slot: 'step-image' | 'portable-asset' | 'portable-sidecar' | 'run-evidence-asset';
  readonly key: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly representation: 'utf8' | 'binary-data-uri';
}

export interface StudioProjectDocument {
  readonly project: JsonObject;
  readonly revision: number;
  readonly savedAt: number;
}

export type WorkspaceRole = 'owner' | 'editor' | 'reviewer' | 'viewer';

export type IdentityScope =
  | 'workspace:read'
  | 'workspace:admin'
  | 'project:read'
  | 'project:write'
  | 'review:read'
  | 'review:write'
  | 'channel:read'
  | 'channel:write'
  | 'release:write'
  | 'schedule:read'
  | 'schedule:write'
  | 'runner:admin'
  | 'analytics:read'
  | 'audit:read';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly disabledAt?: string;
}

export interface WorkspaceMembershipRecord {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

export interface IdentityApiTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly scopes: readonly IdentityScope[];
  readonly projectId?: string;
  readonly channelId?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}

export interface UserSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly sourceTokenId: string;
  readonly workspaceId: string;
  readonly scopes: readonly IdentityScope[];
  readonly projectId?: string;
  readonly channelId?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface PortalGrantRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly subject:
    | { readonly kind: 'user'; readonly userId: string }
    | {
        readonly kind: 'link';
        readonly label: string;
      };
  readonly permission: 'view' | 'review';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface PrivateShareLinkRecord {
  readonly id: string;
  readonly grantId: string;
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

/**
 * A short-lived, one-time bridge from an authenticated control-plane Session
 * to a publication-origin HttpOnly Session. Only the digest is persisted; the
 * browser receives the opaque credential once in a URL fragment.
 */
export interface PublicationLoginHandoffRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly sourceSessionId: string;
  readonly grantId: string;
  readonly audienceOrigin: string;
  readonly returnPath: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface RepositoryBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly workflowRefPattern: string;
  readonly createdAt: string;
}

/**
 * A workspace-owned authorization boundary for the operator-configured GitHub
 * App. The App private key and installation access tokens are deliberately not
 * represented here and are never persisted.
 */
export interface GitHubInstallationBindingRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly installationId: string;
  readonly githubRepositoryId: string;
  readonly defaultBranch: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly revokedAt?: string;
}

export interface GitHubSourceChangeRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly installationBindingId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly path: string;
  readonly baseCommitSha: string;
  readonly baseBlobSha: string;
  readonly patchHash: string;
  readonly branch: string;
  readonly title: string;
  readonly createReviewIssue: boolean;
  readonly evidenceBinding: Readonly<Record<string, string>>;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: number;
  readonly leaseId?: string;
  readonly leaseExpiresAt?: string;
  readonly headCommitSha?: string;
  readonly headBlobSha?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
  readonly issueNumber?: number;
  readonly issueUrl?: string;
  readonly failureCode?: string;
}

/**
 * A recurring verification policy. The control plane only coordinates work:
 * environments and Run Targets are opaque identifiers resolved by a
 * customer-owned runner. It never stores a target URL or an executable command.
 */
export interface VerificationScheduleRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repositoryBindingId: string;
  readonly name: string;
  readonly sourceRef: string;
  readonly environmentId: string;
  readonly runTargetIds: readonly string[];
  readonly intervalSeconds: number;
  readonly freshnessTargetSeconds: number;
  readonly maxRuntimeSeconds: number;
  readonly maxAttempts: number;
  readonly status: 'active' | 'paused';
  readonly nextDueAt: string;
  readonly lastEnqueuedAt?: string;
  readonly lastCompletedAt?: string;
  readonly lastSuccessfulAt?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface VerificationExecutionContract {
  readonly protocolVersion: 1;
  readonly repository: string;
  readonly sourceRef: string;
  readonly environmentId: string;
  readonly runTargetIds: readonly string[];
  readonly expectedBuildId: string;
}

export type VerificationJobResult =
  | {
      readonly outcome: 'verified';
      readonly buildId: string;
      readonly buildArtifactHash: string;
      readonly buildStatus: 'passed' | 'changed' | 'failed' | 'blocked' | 'cancelled';
    }
  | {
      readonly outcome: 'runner-failed';
      readonly failureCode:
        | 'checkout-failed'
        | 'environment-unavailable'
        | 'runner-error'
        | 'timed-out'
        | 'lease-expired'
        | 'cancelled';
      readonly failureDetail: string;
    };

export interface VerificationJobRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly scheduleId: string;
  readonly reason: 'schedule' | 'manual';
  readonly state: 'queued' | 'leased' | 'succeeded' | 'failed' | 'cancelled';
  readonly idempotencyKey: string;
  readonly execution: VerificationExecutionContract;
  readonly dueAt: string;
  readonly availableAt: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseId?: string;
  readonly leasedByRunnerId?: string;
  readonly leasedAt?: string;
  readonly leaseExpiresAt?: string;
  readonly deadlineAt?: string;
  readonly result?: VerificationJobResult;
  readonly resultHash?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly completedAt?: string;
}

/** A least-privilege credential used only by an external verification runner. */
export interface VerificationRunnerRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly scheduleIds: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt?: string;
  readonly revokedAt?: string;
}

export interface VerificationFreshness {
  readonly status: 'fresh' | 'due-soon' | 'stale' | 'never-verified';
  readonly targetSeconds: number;
  readonly lastSuccessfulAt?: string;
  readonly staleAt: string;
}

export interface SceneRevisionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sceneId: string;
  readonly revision: string;
  readonly scene: Scene;
  readonly privacy: PrivacySummary;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ReviewRecord {
  readonly review: Review;
  readonly workspaceId: string;
  readonly projectId: string;
}

interface ImmutableEvidenceRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly artifactHash: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface VerificationRunRecord extends ImmutableEvidenceRecord {
  readonly id: string;
  readonly sceneId: string;
  readonly sourceRevision: string;
  readonly run: RunArtifact;
}

export interface VerificationBuildRecord extends ImmutableEvidenceRecord {
  readonly id: string;
  readonly build: BuildArtifact;
}

export interface VerificationBaselineRecord extends ImmutableEvidenceRecord {
  readonly id: string;
  readonly sceneId: string;
  readonly sourceRevision: string;
  readonly sourceRunId: string;
  readonly sourceRunHash: string;
  readonly baseline: Baseline;
}

export interface ReviewApprovalRecord extends ImmutableEvidenceRecord {
  readonly id: string;
  readonly subjectKind: 'baseline' | 'release-candidate';
  readonly subjectId: string;
  readonly subjectRevision: string;
  readonly approval: Approval;
}

export interface ArtifactObjectSpec {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface ArtifactObjectRecord extends ArtifactObjectSpec {
  readonly uploadId: string;
  readonly status: 'pending' | 'staged' | 'finalized';
  readonly stagingKey?: string;
  readonly finalKey?: string;
}

export interface ArtifactUploadRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly commit: string;
  readonly ref: string;
  readonly status: 'pending' | 'staged' | 'finalized' | 'expired';
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly manifestHash?: string;
  readonly objects: readonly ArtifactObjectRecord[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly finalizedAt?: string;
}

export type EvidenceRetentionClass = 'standard' | 'diagnostic';

/**
 * Durable lifecycle state for one workspace-scoped immutable object identity.
 * The physical object is only removed after an exact claim has transitioned
 * through `deleting`; immutable evidence and Release rows remain append-only.
 */
export interface EvidenceObjectLifecycleRecord {
  readonly workspaceId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly retentionClass: EvidenceRetentionClass;
  readonly status: 'active' | 'claimed' | 'deleting' | 'deleted';
  readonly firstFinalizedAt: string;
  readonly lastFinalizedAt: string;
  readonly claimId?: string;
  readonly claimedUntil?: string;
  readonly deletedAt?: string;
}

export interface EvidenceRetentionClaimRecord extends EvidenceObjectLifecycleRecord {
  readonly projectIds: readonly string[];
  readonly status: 'claimed' | 'deleting';
  readonly claimId: string;
  readonly claimedUntil: string;
}

export interface EvidenceRetentionEvaluationRecord extends EvidenceObjectLifecycleRecord {
  readonly projectIds: readonly string[];
  readonly disposition: 'eligible' | 'protected' | 'grace-period';
  readonly reason: string;
}

export interface EvidenceRetentionEvaluationBatch {
  readonly evaluations: readonly EvidenceRetentionEvaluationRecord[];
  readonly claims: readonly EvidenceRetentionClaimRecord[];
}

export interface WorkspaceArtifactInventoryRecord {
  readonly projectId: string;
  readonly uploadId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly finalizedAt: string;
  readonly lifecycleStatus: EvidenceObjectLifecycleRecord['status'];
}

export interface EvidenceRetentionEventRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly claimId?: string;
  readonly disposition:
    | 'eligible'
    | 'dry-run-eligible'
    | 'protected'
    | 'grace-period'
    | 'deleting'
    | 'deleted'
    | 'delete-failed'
    | 'claim-lost';
  readonly reason: string;
  readonly metadata: JsonObject;
  readonly createdAt: string;
}

export interface ActiveUploadLimits {
  readonly maxActiveUploadsPerTenant: number;
  readonly maxActiveUploadsGlobal: number;
  readonly maxActiveBytesPerTenant: number;
  readonly maxActiveBytesGlobal: number;
}

export interface ChannelRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: 'public-catalog' | 'private-portal' | 'docs-sync' | 'embed' | 'static' | 'offline';
  readonly policy: ChannelPolicy;
  readonly webhookIds: readonly string[];
  readonly analyticsTokenHash: string;
  readonly currentReleaseId?: string;
  readonly sequence: number;
  readonly createdAt: string;
}

export type CustomDomainDesiredState = 'active' | 'disabled' | 'removed';

export type CustomDomainCertificateState =
  | 'not-requested'
  | 'pending'
  | 'ready'
  | 'failed'
  | 'removed';

export type CustomDomainRoutingState =
  | 'not-requested'
  | 'pending'
  | 'ready'
  | 'disabled'
  | 'failed'
  | 'removed';

/** A provider observation, never a caller-authored activation assertion. */
export interface CustomDomainProvisioningObservation {
  readonly operationKey: string;
  readonly operationId: string;
  readonly hostname: string;
  readonly desiredState: CustomDomainDesiredState;
  readonly certificate: CustomDomainCertificateState;
  readonly routing: CustomDomainRoutingState;
  readonly failureCode?: string;
}

export interface CustomDomainProvisioningRecord {
  readonly operationKey: string;
  readonly operationId?: string;
  readonly desiredState: CustomDomainDesiredState;
  readonly certificate: CustomDomainCertificateState;
  readonly routing: CustomDomainRoutingState;
  readonly requestedAt: string;
  readonly observedAt?: string;
  readonly failureCode?: string;
}

export interface CustomDomainRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly channelId: string;
  /** Canonical lower-case IDNA ASCII hostname without a trailing root dot. */
  readonly hostname: string;
  /** Canonical CNAME target configured when the claim was created. */
  readonly routingTarget: string;
  readonly status:
    | 'pending-dns'
    | 'ready-to-provision'
    | 'provisioning'
    | 'active'
    | 'disabling'
    | 'disabled'
    | 'removing'
    | 'removed'
    | 'failed';
  readonly dnsProof: {
    readonly status: 'pending' | 'verified' | 'failed';
    readonly challengeName: string;
    readonly challengeValue: string;
    readonly checkedAt?: string;
    readonly verifiedAt?: string;
  };
  readonly provisioning?: CustomDomainProvisioningRecord;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removedAt?: string;
}

export interface ReleasePromotionSceneEvidence {
  readonly sceneId: string;
  readonly runId: string;
  readonly runArtifactHash: string;
  readonly baselineId?: string;
  readonly baselineArtifactHash?: string;
  readonly visualApprovalId?: string;
  readonly visualApprovalArtifactHash?: string;
  readonly editorialApprovalId?: string;
  readonly editorialApprovalArtifactHash?: string;
}

export interface ReleasePromotionEvidence {
  readonly buildId: string;
  readonly buildArtifactHash: string;
  readonly releaseCandidateHash: string;
  readonly releaseApprovalId: string;
  readonly releaseApprovalArtifactHash: string;
  readonly artifactUploadId: string;
  readonly manifestHash: string;
  readonly scenes: readonly ReleasePromotionSceneEvidence[];
}

export interface ReleaseRecord {
  readonly release: Release;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly promotionEvidence?: ReleasePromotionEvidence;
}

/**
 * One database-snapshot view of the immutable publication currently selected
 * by a hosted route. The publication gateway consumes this read model directly;
 * the control plane never turns it into served HTML.
 */
export interface HostedPublicationRecord {
  readonly workspace: WorkspaceRecord;
  readonly project: ProjectRecord;
  readonly channel: ChannelRecord;
  readonly release?: ReleaseRecord;
  readonly customDomain?: CustomDomainRecord;
}

export interface AnalyticsEventRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly releaseId: string;
  readonly sceneId: string;
  readonly stepId?: string;
  readonly type: 'view' | 'start' | 'step' | 'complete' | 'cta' | 'error';
  readonly occurredAt: string;
  readonly anonymousIdHash?: string;
  readonly sessionIdHash?: string;
  readonly properties: Readonly<Record<string, boolean | number | string>>;
}

export interface AnalyticsAggregateRow {
  readonly scope: 'total' | 'scene' | 'step';
  readonly sceneId?: string;
  readonly stepId?: string;
  readonly type: AnalyticsEventRecord['type'];
  readonly eventCount: number;
  /**
   * Distinct session hashes, then anonymous hashes, with an individual event
   * as the privacy-safe fallback when the publisher sends no subject ID.
   */
  readonly uniqueSubjectCount: number;
}

export interface CtaSubmissionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly releaseId: string;
  readonly sceneId: string;
  readonly stepId?: string;
  readonly ctaId: string;
  readonly webhookId: string;
  readonly payloadHash: string;
  readonly encryptedPayload: string;
  readonly createdAt: string;
}

export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly submissionId: string;
  readonly webhookId: string;
  readonly status: 'pending' | 'delivering' | 'succeeded' | 'failed' | 'exhausted';
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastStatus?: number;
  readonly lastError?: string;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly workspaceId?: string;
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly requestId: string;
  readonly ipHash?: string;
  readonly metadata: JsonObject;
  readonly createdAt: string;
}

export interface UploadTokenClaims {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly commit: string;
  readonly ref: string;
  readonly workflowRef: string;
  readonly permissions: readonly ['artifact:write'];
  readonly expiresAt: number;
  readonly tokenId: string;
}
