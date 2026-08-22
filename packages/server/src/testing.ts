import {
  ChannelPolicySchema,
  JsonValueSchema,
  ReleaseSchema,
  ReviewCommentSchema,
  ReviewDecisionSchema,
  ReviewSchema,
  type Review,
} from '@scenebook/schema';

import type {
  AnalyticsAggregateRow,
  AnalyticsEventRecord,
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
  EvidenceObjectLifecycleRecord,
  EvidenceRetentionClaimRecord,
  EvidenceRetentionEventRecord,
  EvidenceRetentionEvaluationRecord,
  WorkspaceArtifactInventoryRecord,
} from './domain.js';
import type { StoredObject } from './object-store.js';
import { artifactObjectIdentity } from './object-identity.js';
import {
  RepositoryConflictError,
  RepositoryCapacityError,
  RepositoryNotFoundError,
  type ControlPlaneRepository,
} from './repository.js';
import { canonicalJsonHash } from '@scenebook/core';
import type { JsonValue } from '@scenebook/schema';
import { nextScheduleOccurrence, scheduledJobIdentity } from './schedule.js';
import { normalizeCustomDomainHostname } from './custom-domains.js';
import { structuredAssetIdentities } from './structured-assets.js';

type ReviewComment = Review['comments'][number];
type ReviewDecision = Review['decisions'][number];

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryControlPlaneRepository implements ControlPlaneRepository {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly projects = new Map<string, ProjectRecord>();
  readonly studioScenes = new Map<string, StudioSceneDocument>();
  readonly studioSceneVersions = new Map<string, StudioSceneDocument[]>();
  readonly studioProjects = new Map<string, StudioProjectDocument>();
  readonly users = new Map<string, UserRecord>();
  readonly memberships = new Map<string, WorkspaceMembershipRecord>();
  readonly identityApiTokens = new Map<string, IdentityApiTokenRecord>();
  readonly userSessions = new Map<string, UserSessionRecord>();
  readonly portalGrants = new Map<string, PortalGrantRecord>();
  readonly privateShareLinks = new Map<string, PrivateShareLinkRecord>();
  readonly publicationLoginHandoffs = new Map<string, PublicationLoginHandoffRecord>();
  readonly bindings = new Map<string, RepositoryBinding>();
  readonly githubInstallationBindings = new Map<string, GitHubInstallationBindingRecord>();
  readonly githubSourceChanges = new Map<string, GitHubSourceChangeRecord>();
  private readonly githubCheckRunLocks = new Map<string, Promise<void>>();
  readonly verificationSchedules = new Map<string, VerificationScheduleRecord>();
  readonly verificationJobs = new Map<string, VerificationJobRecord>();
  readonly verificationRunners = new Map<string, VerificationRunnerRecord>();
  readonly oidcTokens = new Set<string>();
  readonly revisions = new Map<string, SceneRevisionRecord>();
  readonly reviews = new Map<string, ReviewRecord>();
  readonly verificationRuns = new Map<string, VerificationRunRecord>();
  readonly verificationBuilds = new Map<string, VerificationBuildRecord>();
  readonly verificationBaselines = new Map<string, VerificationBaselineRecord>();
  readonly reviewApprovals = new Map<string, ReviewApprovalRecord>();
  readonly evidenceIdempotency = new Map<string, { id: string; requestHash: string }>();
  readonly uploads = new Map<string, ArtifactUploadRecord>();
  readonly uploadIdempotency = new Map<string, string>();
  readonly uploadGcClaims = new Map<
    string,
    { claimId: string; claimedUntil: string; completedAt?: string }
  >();
  readonly evidenceObjectLifecycle = new Map<string, EvidenceObjectLifecycleRecord>();
  readonly evidenceRetentionEvents: EvidenceRetentionEventRecord[] = [];
  readonly channels = new Map<string, ChannelRecord>();
  readonly customDomains = new Map<string, CustomDomainRecord>();
  readonly releases = new Map<string, ReleaseRecord>();
  readonly releaseIdempotency = new Map<string, string>();
  readonly analytics = new Map<string, AnalyticsEventRecord>();
  readonly submissions = new Map<string, CtaSubmissionRecord>();
  readonly deliveries = new Map<string, WebhookDeliveryRecord>();
  readonly audits: Array<AuditEventRecord & { sequence: number }> = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private trustedLeaseWindow(durationMs: number): { now: string; expiresAt: string } {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1)
      throw new RepositoryConflictError('GitHub source change lease duration is invalid');
    const current = this.clock();
    if (!Number.isFinite(current.getTime()))
      throw new RepositoryConflictError('Repository clock is invalid');
    return {
      now: current.toISOString(),
      expiresAt: new Date(current.getTime() + durationMs).toISOString(),
    };
  }

  async health(): Promise<void> {}
  async close(): Promise<void> {}

  async createWorkspace(input: {
    id: string;
    slug: string;
    name: string;
    now: string;
  }): Promise<WorkspaceRecord> {
    const existing = this.workspaces.get(input.id);
    if (existing) {
      if (existing.slug !== input.slug || existing.name !== input.name)
        throw new RepositoryConflictError('Workspace idempotency conflict');
      return clone(existing);
    }
    const value = { id: input.id, slug: input.slug, name: input.name, createdAt: input.now };
    this.workspaces.set(value.id, value);
    return clone(value);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    const value = this.workspaces.get(id);
    return value ? clone(value) : undefined;
  }

  async listProjects(workspaceId: string, limit: number): Promise<readonly ProjectRecord[]> {
    return [...this.projects.values()]
      .filter((value) => value.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async createProject(input: {
    id: string;
    workspaceId: string;
    slug: string;
    name: string;
    now: string;
  }): Promise<ProjectRecord> {
    if (!this.workspaces.has(input.workspaceId))
      throw new RepositoryNotFoundError('Workspace not found');
    const existing = this.projects.get(input.id);
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.slug !== input.slug ||
        existing.name !== input.name
      ) {
        throw new RepositoryConflictError('Project idempotency conflict');
      }
      return clone(existing);
    }
    const value = {
      id: input.id,
      workspaceId: input.workspaceId,
      slug: input.slug,
      name: input.name,
      createdAt: input.now,
    };
    this.projects.set(value.id, value);
    return clone(value);
  }

  async getProject(workspaceId: string, id: string): Promise<ProjectRecord | undefined> {
    const value = this.projects.get(id);
    return value?.workspaceId === workspaceId ? clone(value) : undefined;
  }

  private studioSceneKey(workspaceId: string, projectId: string, sceneId: string): string {
    return `${workspaceId}\0${projectId}\0${sceneId}`;
  }

  private studioProjectKey(workspaceId: string, projectId: string): string {
    return `${workspaceId}\0${projectId}`;
  }

  async listStudioSceneDocuments(
    input: Parameters<ControlPlaneRepository['listStudioSceneDocuments']>[0],
  ): ReturnType<ControlPlaneRepository['listStudioSceneDocuments']> {
    return [...this.studioScenes.entries()]
      .filter(([key]) => key.startsWith(`${input.workspaceId}\0${input.projectId}\0`))
      .map(([, value]) => value)
      .filter(
        (value) =>
          !input.before ||
          value.savedAt < input.before.savedAt ||
          (value.savedAt === input.before.savedAt && value.id < input.before.sceneId),
      )
      .sort((left, right) => right.savedAt - left.savedAt || right.id.localeCompare(left.id))
      .slice(0, input.limit)
      .map(clone);
  }

  async getStudioSceneDocument(
    workspaceId: string,
    projectId: string,
    sceneId: string,
  ): Promise<StudioSceneDocument | undefined> {
    const value = this.studioScenes.get(this.studioSceneKey(workspaceId, projectId, sceneId));
    return value ? clone(value) : undefined;
  }

  async listStudioSceneVersions(
    input: Parameters<ControlPlaneRepository['listStudioSceneVersions']>[0],
  ): ReturnType<ControlPlaneRepository['listStudioSceneVersions']> {
    return (
      this.studioSceneVersions.get(
        this.studioSceneKey(input.workspaceId, input.projectId, input.sceneId),
      ) ?? []
    )
      .filter((value) => !input.beforeRevision || value.revision < input.beforeRevision)
      .sort((left, right) => right.revision - left.revision)
      .slice(0, input.limit)
      .map(clone);
  }

  async getStudioSceneVersion(
    workspaceId: string,
    projectId: string,
    sceneId: string,
    revision: number,
  ): Promise<StudioSceneDocument | undefined> {
    const value = this.studioSceneVersions
      .get(this.studioSceneKey(workspaceId, projectId, sceneId))
      ?.find((candidate) => candidate.revision === revision);
    return value ? clone(value) : undefined;
  }

  async studioPayloadIsReferenced(
    workspaceId: string,
    projectId: string,
    sha256: string,
    mediaType: string,
  ): Promise<boolean> {
    return [...this.studioSceneVersions.entries()].some(
      ([key, versions]) =>
        key.startsWith(`${workspaceId}\0${projectId}\0`) &&
        versions.some((version) =>
          version.payloadRefs.some(
            (reference) => reference.sha256 === sha256 && reference.mediaType === mediaType,
          ),
        ),
    );
  }

  private hasStudioPayload(
    workspaceId: string,
    projectId: string,
    reference: StudioSceneDocument['payloadRefs'][number],
  ): boolean {
    const available = [...this.uploads.values()].some(
      (upload) =>
        upload.workspaceId === workspaceId &&
        upload.projectId === projectId &&
        upload.repository === 'scenebook-studio' &&
        upload.status === 'finalized' &&
        upload.objects.some(
          (object) =>
            object.status === 'finalized' &&
            object.sha256 === reference.sha256 &&
            object.mediaType === reference.mediaType &&
            object.byteLength === reference.byteLength &&
            Boolean(object.finalKey),
        ),
    );
    const lifecycle = this.evidenceObjectLifecycle.get(
      `${workspaceId}\0${artifactObjectIdentity(reference.sha256, reference.mediaType)}`,
    );
    return available && (!lifecycle || lifecycle.status === 'active');
  }

  async putStudioWorkspace(
    input: Parameters<ControlPlaneRepository['putStudioWorkspace']>[0],
  ): ReturnType<ControlPlaneRepository['putStudioWorkspace']> {
    const project = this.projects.get(input.projectId);
    if (!project || project.workspaceId !== input.workspaceId) {
      throw new RepositoryNotFoundError('Project not found');
    }
    for (const write of input.writes) {
      const key = this.studioSceneKey(input.workspaceId, input.projectId, write.record.id);
      const actualRevision = this.studioScenes.get(key)?.revision ?? 0;
      if (
        actualRevision !== write.expectedRevision ||
        write.record.revision !== write.expectedRevision + 1
      ) {
        throw new RepositoryConflictError(
          `Hosted Studio Scene revision conflict: ${write.record.id}:${actualRevision}`,
        );
      }
      if (
        write.record.payloadRefs.some(
          (reference) => !this.hasStudioPayload(input.workspaceId, input.projectId, reference),
        )
      ) {
        throw new RepositoryConflictError('Hosted Studio payload is unavailable');
      }
    }
    let nextProject: StudioProjectDocument | undefined;
    if (input.project) {
      if (input.project.document.project.id !== input.projectId) {
        throw new RepositoryConflictError('Hosted Studio Project id does not match the route');
      }
      const key = this.studioProjectKey(input.workspaceId, input.projectId);
      const actualRevision = this.studioProjects.get(key)?.revision ?? 0;
      if (actualRevision !== input.project.expectedRevision) {
        throw new RepositoryConflictError(
          `Hosted Studio Project revision conflict: ${actualRevision}`,
        );
      }
      nextProject = {
        ...clone(input.project.document),
        revision: input.project.expectedRevision + 1,
      };
    }
    for (const write of input.writes) {
      const key = this.studioSceneKey(input.workspaceId, input.projectId, write.record.id);
      const value = clone(write.record);
      this.studioScenes.set(key, value);
      this.studioSceneVersions.set(
        key,
        [value, ...(this.studioSceneVersions.get(key) ?? [])]
          .sort((left, right) => right.revision - left.revision)
          .slice(0, 100),
      );
    }
    if (nextProject) {
      this.studioProjects.set(
        this.studioProjectKey(input.workspaceId, input.projectId),
        clone(nextProject),
      );
    }
    return {
      records: input.writes.map(({ record }) => clone(record)),
      ...(nextProject ? { project: clone(nextProject) } : {}),
    };
  }

  async deleteStudioSceneDocument(
    input: Parameters<ControlPlaneRepository['deleteStudioSceneDocument']>[0],
  ): Promise<boolean> {
    const key = this.studioSceneKey(input.workspaceId, input.projectId, input.sceneId);
    const current = this.studioScenes.get(key);
    if (!current || current.revision !== input.expectedRevision) return false;
    this.studioScenes.delete(key);
    this.studioSceneVersions.delete(key);
    return true;
  }

  async getStudioProjectDocument(
    workspaceId: string,
    projectId: string,
  ): Promise<StudioProjectDocument | undefined> {
    const value = this.studioProjects.get(this.studioProjectKey(workspaceId, projectId));
    return value ? clone(value) : undefined;
  }

  async putStudioProjectDocument(
    input: Parameters<ControlPlaneRepository['putStudioProjectDocument']>[0],
  ): Promise<StudioProjectDocument> {
    const result = await this.putStudioWorkspace({
      ...input,
      writes: [],
      project: { expectedRevision: input.expectedRevision, document: input.document },
    });
    if (!result.project) throw new Error('Could not save hosted Studio Project');
    return result.project;
  }

  async createUser(input: {
    id: string;
    email: string;
    displayName: string;
    now: string;
  }): Promise<UserRecord> {
    const existing = this.users.get(input.id);
    if (existing) {
      if (existing.email !== input.email || existing.displayName !== input.displayName)
        throw new RepositoryConflictError('User idempotency conflict');
      return clone(existing);
    }
    if (
      [...this.users.values()].some(
        (user) => user.email.toLowerCase() === input.email.toLowerCase(),
      )
    )
      throw new RepositoryConflictError('User email already exists');
    const value: UserRecord = {
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      createdAt: input.now,
    };
    this.users.set(value.id, value);
    return clone(value);
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const value = this.users.get(id);
    return value ? clone(value) : undefined;
  }

  async disableUser(id: string, now: string): Promise<boolean> {
    const value = this.users.get(id);
    if (!value || value.disabledAt) return false;
    this.users.set(id, { ...value, disabledAt: now });
    return true;
  }

  async putWorkspaceMembership(
    input: WorkspaceMembershipRecord,
  ): Promise<WorkspaceMembershipRecord> {
    if (!this.workspaces.has(input.workspaceId))
      throw new RepositoryNotFoundError('Workspace not found');
    if (!this.users.has(input.userId)) throw new RepositoryNotFoundError('User not found');
    const key = `${input.workspaceId}\0${input.userId}`;
    const existing = this.memberships.get(key);
    const value: WorkspaceMembershipRecord = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      createdAt: existing?.createdAt ?? input.createdAt,
      updatedAt: input.updatedAt,
      ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
    };
    this.memberships.set(key, value);
    return clone(value);
  }

  async getWorkspaceMembership(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMembershipRecord | undefined> {
    const value = this.memberships.get(`${workspaceId}\0${userId}`);
    return value ? clone(value) : undefined;
  }

  async listWorkspaceMemberships(
    workspaceId: string,
    limit: number,
  ): Promise<readonly WorkspaceMembershipRecord[]> {
    return [...this.memberships.values()]
      .filter((value) => value.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.userId.localeCompare(left.userId),
      )
      .slice(0, limit)
      .map(clone);
  }

  async revokeWorkspaceMembership(
    workspaceId: string,
    userId: string,
    now: string,
  ): Promise<boolean> {
    const key = `${workspaceId}\0${userId}`;
    const existing = this.memberships.get(key);
    if (!existing || existing.revokedAt) return false;
    this.memberships.set(key, { ...existing, revokedAt: now, updatedAt: now });
    return true;
  }

  async createIdentityApiToken(input: IdentityApiTokenRecord): Promise<IdentityApiTokenRecord> {
    const existing = this.identityApiTokens.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input))
        throw new RepositoryConflictError('API token idempotency conflict');
      return clone(existing);
    }
    if (!this.users.has(input.userId)) throw new RepositoryNotFoundError('User not found');
    this.identityApiTokens.set(input.id, clone(input));
    return clone(input);
  }

  async getIdentityApiToken(id: string): Promise<IdentityApiTokenRecord | undefined> {
    const value = this.identityApiTokens.get(id);
    return value ? clone(value) : undefined;
  }

  async listIdentityApiTokens(
    workspaceId: string,
    userId: string,
    limit: number,
  ): Promise<readonly IdentityApiTokenRecord[]> {
    return [...this.identityApiTokens.values()]
      .filter((value) => value.workspaceId === workspaceId && value.userId === userId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async touchIdentityApiToken(id: string, now: string): Promise<void> {
    const value = this.identityApiTokens.get(id);
    if (value) this.identityApiTokens.set(id, { ...value, lastUsedAt: now });
  }

  async revokeIdentityApiToken(id: string, userId: string, now: string): Promise<boolean> {
    const value = this.identityApiTokens.get(id);
    if (!value || value.userId !== userId || value.revokedAt) return false;
    this.identityApiTokens.set(id, { ...value, revokedAt: now });
    return true;
  }

  async createUserSession(input: UserSessionRecord): Promise<UserSessionRecord> {
    const existing = this.userSessions.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input))
        throw new RepositoryConflictError('Session idempotency conflict');
      return clone(existing);
    }
    if (!this.users.has(input.userId)) throw new RepositoryNotFoundError('User not found');
    const source = this.identityApiTokens.get(input.sourceTokenId);
    if (!source || source.userId !== input.userId)
      throw new RepositoryNotFoundError('Source API token not found');
    this.userSessions.set(input.id, clone(input));
    return clone(input);
  }

  async getUserSession(id: string): Promise<UserSessionRecord | undefined> {
    const value = this.userSessions.get(id);
    return value ? clone(value) : undefined;
  }

  async revokeUserSession(id: string, userId: string, now: string): Promise<boolean> {
    const value = this.userSessions.get(id);
    if (!value || value.userId !== userId || value.revokedAt) return false;
    this.userSessions.set(id, { ...value, revokedAt: now });
    return true;
  }

  async createPortalGrant(input: PortalGrantRecord): Promise<PortalGrantRecord> {
    const existing = this.portalGrants.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input))
        throw new RepositoryConflictError('Portal grant idempotency conflict');
      return clone(existing);
    }
    const channel = await this.getChannel(input.workspaceId, input.projectId, input.channelId);
    if (!channel || channel.kind !== 'private-portal')
      throw new RepositoryNotFoundError('Private portal Channel not found');
    if (input.subject.kind === 'user' && !this.users.has(input.subject.userId))
      throw new RepositoryNotFoundError('User not found');
    this.portalGrants.set(input.id, clone(input));
    return clone(input);
  }

  async getPortalGrant(id: string): Promise<PortalGrantRecord | undefined> {
    const value = this.portalGrants.get(id);
    return value ? clone(value) : undefined;
  }

  async listPortalGrants(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly PortalGrantRecord[]> {
    return [...this.portalGrants.values()]
      .filter(
        (value) =>
          value.workspaceId === workspaceId &&
          value.projectId === projectId &&
          value.channelId === channelId,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async findPortalGrantForUser(
    workspaceId: string,
    projectId: string,
    channelId: string,
    userId: string,
    now: string,
  ): Promise<PortalGrantRecord | undefined> {
    return [...this.portalGrants.values()]
      .filter(
        (grant) =>
          grant.workspaceId === workspaceId &&
          grant.projectId === projectId &&
          grant.channelId === channelId &&
          grant.subject.kind === 'user' &&
          grant.subject.userId === userId &&
          !grant.revokedAt &&
          grant.expiresAt > now,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async revokePortalGrant(id: string, workspaceId: string, now: string): Promise<boolean> {
    const value = this.portalGrants.get(id);
    if (!value || value.workspaceId !== workspaceId || value.revokedAt) return false;
    this.portalGrants.set(id, { ...value, revokedAt: now });
    return true;
  }

  async createPrivateShareLink(input: PrivateShareLinkRecord): Promise<PrivateShareLinkRecord> {
    const existing = this.privateShareLinks.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input))
        throw new RepositoryConflictError('Private share idempotency conflict');
      return clone(existing);
    }
    if (!this.portalGrants.has(input.grantId))
      throw new RepositoryNotFoundError('Portal grant not found');
    this.privateShareLinks.set(input.id, clone(input));
    return clone(input);
  }

  async getPrivateShareLink(id: string): Promise<PrivateShareLinkRecord | undefined> {
    const value = this.privateShareLinks.get(id);
    return value ? clone(value) : undefined;
  }

  async listPrivateShareLinks(
    grantId: string,
    limit: number,
  ): Promise<readonly PrivateShareLinkRecord[]> {
    return [...this.privateShareLinks.values()]
      .filter((value) => value.grantId === grantId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async revokePrivateShareLink(id: string, now: string): Promise<boolean> {
    const value = this.privateShareLinks.get(id);
    if (!value || value.revokedAt) return false;
    this.privateShareLinks.set(id, { ...value, revokedAt: now });
    return true;
  }

  async createPublicationLoginHandoff(
    input: PublicationLoginHandoffRecord,
  ): Promise<PublicationLoginHandoffRecord> {
    const existing = this.publicationLoginHandoffs.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) {
        throw new RepositoryConflictError('Publication login handoff idempotency conflict');
      }
      return clone(existing);
    }
    const session = this.userSessions.get(input.sourceSessionId);
    const grant = this.portalGrants.get(input.grantId);
    if (
      !session ||
      session.userId !== input.userId ||
      !grant ||
      grant.subject.kind !== 'user' ||
      grant.subject.userId !== input.userId ||
      grant.workspaceId !== input.workspaceId ||
      grant.projectId !== input.projectId ||
      grant.channelId !== input.channelId
    ) {
      throw new RepositoryNotFoundError('Publication login authorization not found');
    }
    for (const [id, candidate] of this.publicationLoginHandoffs) {
      if (candidate.expiresAt < input.createdAt || candidate.consumedAt) {
        this.publicationLoginHandoffs.delete(id);
      }
    }
    this.publicationLoginHandoffs.set(input.id, clone(input));
    return clone(input);
  }

  async getActivePublicationLoginHandoff(input: {
    tokenHash: string;
    audienceOrigin: string;
    now: string;
  }): Promise<PublicationLoginHandoffRecord | undefined> {
    const value = [...this.publicationLoginHandoffs.values()].find(
      (candidate) =>
        candidate.tokenHash === input.tokenHash &&
        candidate.audienceOrigin === input.audienceOrigin &&
        !candidate.consumedAt &&
        candidate.expiresAt > input.now,
    );
    return value ? clone(value) : undefined;
  }

  async consumePublicationLoginHandoffAndAudit(
    input: { tokenHash: string; audienceOrigin: string; now: string },
    audit: AuditEventRecord,
  ): Promise<PublicationLoginHandoffRecord | undefined> {
    const value = await this.getActivePublicationLoginHandoff(input);
    if (!value) return undefined;
    const auditSnapshot = clone(this.audits);
    try {
      await this.appendAudit(audit);
    } catch (error) {
      this.audits.splice(0, this.audits.length, ...auditSnapshot);
      throw error;
    }
    const current = this.publicationLoginHandoffs.get(value.id);
    if (!current || current.consumedAt) {
      this.audits.splice(0, this.audits.length, ...auditSnapshot);
      return undefined;
    }
    const consumed = { ...value, consumedAt: input.now };
    this.publicationLoginHandoffs.set(value.id, consumed);
    return clone(consumed);
  }

  async bindRepository(input: RepositoryBinding): Promise<RepositoryBinding> {
    if (!(await this.getProject(input.workspaceId, input.projectId)))
      throw new RepositoryNotFoundError('Project not found');
    this.bindings.set(`${input.projectId}\0${input.repository.toLowerCase()}`, clone(input));
    return clone(input);
  }

  async getRepositoryBinding(
    workspaceId: string,
    projectId: string,
    repository: string,
  ): Promise<RepositoryBinding | undefined> {
    const value = this.bindings.get(`${projectId}\0${repository.toLowerCase()}`);
    return value?.workspaceId === workspaceId ? clone(value) : undefined;
  }

  async getRepositoryBindingById(
    workspaceId: string,
    projectId: string,
    bindingId: string,
  ): Promise<RepositoryBinding | undefined> {
    const value = [...this.bindings.values()].find(
      (candidate) =>
        candidate.id === bindingId &&
        candidate.workspaceId === workspaceId &&
        candidate.projectId === projectId,
    );
    return value ? clone(value) : undefined;
  }

  async listRepositoryBindings(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly RepositoryBinding[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.workspaceId === workspaceId && binding.projectId === projectId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async putGitHubInstallationBinding(
    input: GitHubInstallationBindingRecord,
  ): Promise<GitHubInstallationBindingRecord> {
    if (
      !(await this.getRepositoryBindingById(
        input.workspaceId,
        input.projectId,
        input.repositoryBindingId,
      ))
    )
      throw new RepositoryNotFoundError('Repository binding not found');
    const active = [...this.githubInstallationBindings.values()].find(
      (candidate) =>
        candidate.workspaceId === input.workspaceId &&
        candidate.projectId === input.projectId &&
        candidate.repositoryBindingId === input.repositoryBindingId &&
        !candidate.revokedAt,
    );
    if (active) {
      if (
        active.installationId !== input.installationId ||
        active.githubRepositoryId !== input.githubRepositoryId ||
        active.defaultBranch !== input.defaultBranch
      ) {
        throw new RepositoryConflictError(
          'Repository already has an active GitHub installation binding',
        );
      }
      return clone(active);
    }
    this.githubInstallationBindings.set(input.id, clone(input));
    return clone(input);
  }

  async getGitHubInstallationBinding(
    workspaceId: string,
    projectId: string,
    bindingId: string,
  ): Promise<GitHubInstallationBindingRecord | undefined> {
    const value = this.githubInstallationBindings.get(bindingId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async getActiveGitHubInstallationBindingForRepository(
    workspaceId: string,
    projectId: string,
    repositoryBindingId: string,
  ): Promise<GitHubInstallationBindingRecord | undefined> {
    const value = [...this.githubInstallationBindings.values()].find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.projectId === projectId &&
        candidate.repositoryBindingId === repositoryBindingId &&
        !candidate.revokedAt,
    );
    return value ? clone(value) : undefined;
  }

  async withGitHubCheckRunLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
    if (lockKey.length < 1 || lockKey.length > 1_000)
      throw new RepositoryConflictError('GitHub Check Run lock key is invalid');
    const previous = this.githubCheckRunLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.githubCheckRunLocks.set(lockKey, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.githubCheckRunLocks.get(lockKey) === tail) this.githubCheckRunLocks.delete(lockKey);
    }
  }

  async listGitHubInstallationBindings(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly GitHubInstallationBindingRecord[]> {
    return [...this.githubInstallationBindings.values()]
      .filter((value) => value.workspaceId === workspaceId && value.projectId === projectId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async revokeGitHubInstallationBinding(input: {
    workspaceId: string;
    projectId: string;
    bindingId: string;
    expectedVersion: number;
    now: string;
  }): Promise<GitHubInstallationBindingRecord> {
    const value = await this.getGitHubInstallationBinding(
      input.workspaceId,
      input.projectId,
      input.bindingId,
    );
    if (!value) throw new RepositoryNotFoundError('GitHub installation binding not found');
    if (value.version !== input.expectedVersion)
      throw new RepositoryConflictError('GitHub installation binding version conflict');
    if (value.revokedAt) return value;
    const updated: GitHubInstallationBindingRecord = {
      ...value,
      revokedAt: input.now,
      updatedAt: input.now,
      version: value.version + 1,
    };
    this.githubInstallationBindings.set(value.id, updated);
    return clone(updated);
  }

  async claimGitHubSourceChange(input: {
    record: GitHubSourceChangeRecord;
    leaseId: string;
    leaseDurationMs: number;
  }): Promise<{ readonly record: GitHubSourceChangeRecord; readonly claimed: boolean }> {
    const lease = this.trustedLeaseWindow(input.leaseDurationMs);
    const existing = [...this.githubSourceChanges.values()].find(
      (candidate) =>
        candidate.workspaceId === input.record.workspaceId &&
        candidate.idempotencyKey === input.record.idempotencyKey,
    );
    if (existing && existing.requestHash !== input.record.requestHash)
      throw new RepositoryConflictError('GitHub source change idempotency conflict');
    if (
      existing?.status === 'succeeded' ||
      (existing?.leaseExpiresAt &&
        new Date(existing.leaseExpiresAt).getTime() > new Date(lease.now).getTime())
    ) {
      return { record: clone(existing), claimed: false };
    }
    const base = existing ?? input.record;
    const claimed: GitHubSourceChangeRecord = {
      ...base,
      status: 'pending',
      attempts: base.attempts + 1,
      leaseId: input.leaseId,
      leaseExpiresAt: lease.expiresAt,
      updatedAt: lease.now,
      ...(existing?.failureCode ? {} : {}),
    };
    const { failureCode: _failureCode, ...withoutFailure } = claimed;
    this.githubSourceChanges.set(claimed.id, withoutFailure);
    return { record: clone(withoutFailure), claimed: true };
  }

  async renewGitHubSourceChangeLease(input: {
    workspaceId: string;
    projectId: string;
    changeId: string;
    leaseId: string;
    leaseDurationMs: number;
  }): Promise<GitHubSourceChangeRecord> {
    const lease = this.trustedLeaseWindow(input.leaseDurationMs);
    const value = await this.getGitHubSourceChange(
      input.workspaceId,
      input.projectId,
      input.changeId,
    );
    if (
      !value ||
      value.status !== 'pending' ||
      value.leaseId !== input.leaseId ||
      !value.leaseExpiresAt ||
      new Date(value.leaseExpiresAt).getTime() <= new Date(lease.now).getTime()
    ) {
      throw new RepositoryConflictError('GitHub source change lease was lost');
    }
    const updated: GitHubSourceChangeRecord = {
      ...value,
      leaseExpiresAt: lease.expiresAt,
      updatedAt: lease.now,
    };
    this.githubSourceChanges.set(value.id, updated);
    return clone(updated);
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
    const trustedNow = this.trustedLeaseWindow(1).now;
    const value = await this.getGitHubSourceChange(
      input.workspaceId,
      input.projectId,
      input.changeId,
    );
    if (!value) throw new RepositoryNotFoundError('GitHub source change not found');
    if (
      value.status !== 'pending' ||
      value.leaseId !== input.leaseId ||
      !value.leaseExpiresAt ||
      new Date(value.leaseExpiresAt).getTime() <= new Date(trustedNow).getTime()
    )
      throw new RepositoryConflictError('GitHub source change lease was lost');
    const {
      leaseId: _leaseId,
      leaseExpiresAt: _leaseExpiresAt,
      failureCode: _failureCode,
      ...base
    } = value;
    const updated: GitHubSourceChangeRecord = {
      ...base,
      status: 'succeeded',
      updatedAt: trustedNow,
      headCommitSha: input.result.headCommitSha!,
      headBlobSha: input.result.headBlobSha!,
      pullRequestNumber: input.result.pullRequestNumber!,
      pullRequestUrl: input.result.pullRequestUrl!,
      ...(input.result.issueNumber === undefined ? {} : { issueNumber: input.result.issueNumber }),
      ...(input.result.issueUrl === undefined ? {} : { issueUrl: input.result.issueUrl }),
    };
    this.githubSourceChanges.set(value.id, updated);
    return clone(updated);
  }

  async failGitHubSourceChange(input: {
    workspaceId: string;
    projectId: string;
    changeId: string;
    leaseId: string;
    failureCode: string;
  }): Promise<GitHubSourceChangeRecord> {
    const trustedNow = this.trustedLeaseWindow(1).now;
    const value = await this.getGitHubSourceChange(
      input.workspaceId,
      input.projectId,
      input.changeId,
    );
    if (!value) throw new RepositoryNotFoundError('GitHub source change not found');
    if (
      value.status !== 'pending' ||
      value.leaseId !== input.leaseId ||
      !value.leaseExpiresAt ||
      new Date(value.leaseExpiresAt).getTime() <= new Date(trustedNow).getTime()
    )
      throw new RepositoryConflictError('GitHub source change lease was lost');
    const { leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...base } = value;
    const updated: GitHubSourceChangeRecord = {
      ...base,
      status: 'failed',
      updatedAt: trustedNow,
      failureCode: input.failureCode,
    };
    this.githubSourceChanges.set(value.id, updated);
    return clone(updated);
  }

  async getGitHubSourceChange(
    workspaceId: string,
    projectId: string,
    changeId: string,
  ): Promise<GitHubSourceChangeRecord | undefined> {
    const value = this.githubSourceChanges.get(changeId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async createVerificationSchedule(
    input: VerificationScheduleRecord,
  ): Promise<VerificationScheduleRecord> {
    const existing = this.verificationSchedules.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input))
        throw new RepositoryConflictError('Verification Schedule idempotency conflict');
      return clone(existing);
    }
    const binding = await this.getRepositoryBindingById(
      input.workspaceId,
      input.projectId,
      input.repositoryBindingId,
    );
    if (!binding) throw new RepositoryNotFoundError('Repository binding not found');
    this.verificationSchedules.set(input.id, clone(input));
    return clone(input);
  }

  async getVerificationSchedule(
    workspaceId: string,
    projectId: string,
    scheduleId: string,
  ): Promise<VerificationScheduleRecord | undefined> {
    const value = this.verificationSchedules.get(scheduleId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listVerificationSchedules(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationScheduleRecord[]> {
    return [...this.verificationSchedules.values()]
      .filter((value) => value.workspaceId === workspaceId && value.projectId === projectId)
      .sort(
        (left, right) =>
          left.nextDueAt.localeCompare(right.nextDueAt) || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async updateVerificationSchedule(
    input: Parameters<ControlPlaneRepository['updateVerificationSchedule']>[0],
  ): Promise<VerificationScheduleRecord> {
    const current = await this.getVerificationSchedule(
      input.workspaceId,
      input.projectId,
      input.scheduleId,
    );
    if (!current) throw new RepositoryNotFoundError('Verification Schedule not found');
    if (current.version !== input.expectedVersion)
      throw new RepositoryConflictError('Verification Schedule version conflict');
    const value: VerificationScheduleRecord = {
      ...current,
      ...clone(input.patch),
      updatedAt: input.now,
      version: current.version + 1,
    };
    if (value.freshnessTargetSeconds < value.intervalSeconds)
      throw new RepositoryConflictError('Freshness target cannot be shorter than interval');
    this.verificationSchedules.set(value.id, value);
    return clone(value);
  }

  async setVerificationScheduleStatus(
    input: Parameters<ControlPlaneRepository['setVerificationScheduleStatus']>[0],
  ): Promise<VerificationScheduleRecord> {
    const current = await this.getVerificationSchedule(
      input.workspaceId,
      input.projectId,
      input.scheduleId,
    );
    if (!current) throw new RepositoryNotFoundError('Verification Schedule not found');
    if (current.status === input.status && input.nextDueAt === undefined) return current;
    const value: VerificationScheduleRecord = {
      ...current,
      status: input.status,
      ...(input.nextDueAt ? { nextDueAt: input.nextDueAt } : {}),
      updatedAt: input.now,
      version: current.version + 1,
    };
    this.verificationSchedules.set(value.id, value);
    return clone(value);
  }

  async materializeDueVerificationJobs(
    now: string,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]> {
    const schedules = [...this.verificationSchedules.values()]
      .filter((schedule) => schedule.status === 'active' && schedule.nextDueAt <= now)
      .sort(
        (left, right) =>
          left.nextDueAt.localeCompare(right.nextDueAt) || left.id.localeCompare(right.id),
      )
      .slice(0, limit);
    const jobs: VerificationJobRecord[] = [];
    for (const schedule of schedules) {
      const binding = await this.getRepositoryBindingById(
        schedule.workspaceId,
        schedule.projectId,
        schedule.repositoryBindingId,
      );
      if (!binding) throw new RepositoryNotFoundError('Repository binding not found');
      const identity = scheduledJobIdentity(schedule.id, schedule.nextDueAt);
      const job: VerificationJobRecord = {
        id: identity.id,
        workspaceId: schedule.workspaceId,
        projectId: schedule.projectId,
        scheduleId: schedule.id,
        reason: 'schedule',
        state: 'queued',
        idempotencyKey: identity.idempotencyKey,
        execution: {
          protocolVersion: 1,
          repository: binding.repository,
          sourceRef: schedule.sourceRef,
          environmentId: schedule.environmentId,
          runTargetIds: schedule.runTargetIds,
          expectedBuildId: identity.expectedBuildId,
        },
        dueAt: schedule.nextDueAt,
        availableAt: now,
        attempts: 0,
        maxAttempts: schedule.maxAttempts,
        createdBy: 'scheduler',
        createdAt: now,
      };
      const existing = this.verificationJobs.get(job.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(job))
        throw new RepositoryConflictError('Scheduled verification Job conflict');
      if (!existing) {
        this.verificationJobs.set(job.id, clone(job));
        jobs.push(job);
      }
      this.verificationSchedules.set(schedule.id, {
        ...schedule,
        nextDueAt: nextScheduleOccurrence(schedule.nextDueAt, now, schedule.intervalSeconds),
        lastEnqueuedAt: now,
        updatedAt: now,
        version: schedule.version + 1,
      });
    }
    return clone(jobs);
  }

  async createManualVerificationJob(input: VerificationJobRecord): Promise<VerificationJobRecord> {
    if (
      input.reason !== 'manual' ||
      input.state !== 'queued' ||
      input.attempts !== 0 ||
      !input.idempotencyKey.startsWith('manual:')
    )
      throw new RepositoryConflictError('Invalid manual Verification Job initial state');
    const schedule = await this.getVerificationSchedule(
      input.workspaceId,
      input.projectId,
      input.scheduleId,
    );
    if (!schedule) throw new RepositoryNotFoundError('Verification Schedule not found');
    const existing = [...this.verificationJobs.values()].find(
      (job) => job.scheduleId === input.scheduleId && job.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input))
        throw new RepositoryConflictError('Manual verification Job idempotency conflict');
      return clone(existing);
    }
    this.verificationJobs.set(input.id, clone(input));
    return clone(input);
  }

  async getVerificationJob(
    workspaceId: string,
    projectId: string,
    jobId: string,
  ): Promise<VerificationJobRecord | undefined> {
    const value = this.verificationJobs.get(jobId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listVerificationJobs(
    workspaceId: string,
    projectId: string,
    scheduleId: string | undefined,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]> {
    return [...this.verificationJobs.values()]
      .filter(
        (job) =>
          job.workspaceId === workspaceId &&
          job.projectId === projectId &&
          (scheduleId === undefined || job.scheduleId === scheduleId),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async cancelVerificationJob(
    input: Parameters<ControlPlaneRepository['cancelVerificationJob']>[0],
  ): Promise<VerificationJobRecord> {
    const current = await this.getVerificationJob(input.workspaceId, input.projectId, input.jobId);
    if (!current) throw new RepositoryNotFoundError('Verification Job not found');
    if (current.state === 'cancelled' && current.resultHash === input.resultHash) return current;
    if (['succeeded', 'failed', 'cancelled'].includes(current.state))
      throw new RepositoryConflictError('Verification Job is already terminal');
    const value: VerificationJobRecord = {
      ...current,
      state: 'cancelled',
      result: input.result,
      resultHash: input.resultHash,
      completedAt: input.now,
    };
    this.verificationJobs.set(value.id, value);
    return clone(value);
  }

  async requeueExpiredVerificationJobs(
    now: string,
    limit: number,
  ): Promise<readonly VerificationJobRecord[]> {
    const expired = [...this.verificationJobs.values()]
      .filter(
        (job) =>
          job.state === 'leased' && job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now,
      )
      .sort(
        (left, right) =>
          left.leaseExpiresAt!.localeCompare(right.leaseExpiresAt!) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
    const values: VerificationJobRecord[] = [];
    for (const job of expired) {
      let value: VerificationJobRecord;
      if (job.attempts >= job.maxAttempts) {
        const result = {
          outcome: 'runner-failed' as const,
          failureCode: 'lease-expired' as const,
          failureDetail: 'Runner lease expired after the maximum number of attempts',
        };
        value = {
          ...job,
          state: 'failed',
          result,
          resultHash: canonicalJsonHash(result),
          completedAt: now,
        };
      } else {
        const {
          leaseId: _leaseId,
          leasedByRunnerId: _runner,
          leasedAt: _leasedAt,
          leaseExpiresAt: _leaseExpiresAt,
          deadlineAt: _deadlineAt,
          ...rest
        } = job;
        value = { ...rest, state: 'queued', availableAt: now };
      }
      this.verificationJobs.set(value.id, value);
      values.push(value);
    }
    return clone(values);
  }

  async createVerificationRunner(
    input: VerificationRunnerRecord,
  ): Promise<VerificationRunnerRecord> {
    const existing = this.verificationRunners.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input))
        throw new RepositoryConflictError('Verification Runner idempotency conflict');
      return clone(existing);
    }
    for (const scheduleId of input.scheduleIds) {
      if (!(await this.getVerificationSchedule(input.workspaceId, input.projectId, scheduleId)))
        throw new RepositoryNotFoundError('Verification Schedule not found');
    }
    this.verificationRunners.set(input.id, clone(input));
    return clone(input);
  }

  async getVerificationRunner(id: string): Promise<VerificationRunnerRecord | undefined> {
    const value = this.verificationRunners.get(id);
    return value ? clone(value) : undefined;
  }

  async listVerificationRunners(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationRunnerRecord[]> {
    return [...this.verificationRunners.values()]
      .filter((runner) => runner.workspaceId === workspaceId && runner.projectId === projectId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async rotateVerificationRunnerToken(
    input: Parameters<ControlPlaneRepository['rotateVerificationRunnerToken']>[0],
  ): Promise<VerificationRunnerRecord> {
    const current = this.verificationRunners.get(input.runnerId);
    if (
      !current ||
      current.workspaceId !== input.workspaceId ||
      current.projectId !== input.projectId
    )
      throw new RepositoryNotFoundError('Verification Runner not found');
    if (current.revokedAt)
      throw new RepositoryConflictError('Revoked Verification Runner cannot be rotated');
    const value = { ...current, tokenHash: input.tokenHash };
    this.verificationRunners.set(value.id, value);
    return clone(value);
  }

  async revokeVerificationRunner(
    input: Parameters<ControlPlaneRepository['revokeVerificationRunner']>[0],
  ): Promise<boolean> {
    const current = this.verificationRunners.get(input.runnerId);
    if (
      !current ||
      current.workspaceId !== input.workspaceId ||
      current.projectId !== input.projectId ||
      current.revokedAt
    )
      return false;
    this.verificationRunners.set(current.id, { ...current, revokedAt: input.now });
    return true;
  }

  async touchVerificationRunner(runnerId: string, now: string): Promise<void> {
    const current = this.verificationRunners.get(runnerId);
    if (current && !current.revokedAt)
      this.verificationRunners.set(current.id, { ...current, lastSeenAt: now });
  }

  async claimVerificationJob(
    input: Parameters<ControlPlaneRepository['claimVerificationJob']>[0],
  ): Promise<VerificationJobRecord | undefined> {
    const runner = this.verificationRunners.get(input.runnerId);
    if (!runner || runner.revokedAt || runner.expiresAt <= input.now)
      throw new RepositoryNotFoundError('Active Verification Runner not found');
    const job = [...this.verificationJobs.values()]
      .filter(
        (candidate) =>
          candidate.state === 'queued' &&
          candidate.availableAt <= input.now &&
          runner.scheduleIds.includes(candidate.scheduleId),
      )
      .sort(
        (left, right) => left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id),
      )[0];
    if (!job) return undefined;
    const schedule = this.verificationSchedules.get(job.scheduleId)!;
    const deadlineAt = new Date(
      new Date(input.now).getTime() + schedule.maxRuntimeSeconds * 1_000,
    ).toISOString();
    const leaseExpiresAt = new Date(
      Math.min(
        new Date(input.now).getTime() + input.leaseSeconds * 1_000,
        new Date(deadlineAt).getTime(),
      ),
    ).toISOString();
    const value: VerificationJobRecord = {
      ...job,
      state: 'leased',
      attempts: job.attempts + 1,
      leaseId: input.leaseId,
      leasedByRunnerId: runner.id,
      leasedAt: input.now,
      leaseExpiresAt,
      deadlineAt,
    };
    this.verificationJobs.set(value.id, value);
    await this.touchVerificationRunner(runner.id, input.now);
    return clone(value);
  }

  async renewVerificationJobLease(
    input: Parameters<ControlPlaneRepository['renewVerificationJobLease']>[0],
  ): Promise<VerificationJobRecord> {
    const runner = this.verificationRunners.get(input.runnerId);
    if (!runner || runner.revokedAt || runner.expiresAt <= input.now)
      throw new RepositoryConflictError('Verification Runner is revoked or expired');
    const job = this.verificationJobs.get(input.jobId);
    if (
      !job ||
      job.state !== 'leased' ||
      job.leasedByRunnerId !== input.runnerId ||
      job.leaseId !== input.leaseId ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= input.now ||
      !job.deadlineAt ||
      job.deadlineAt <= input.now
    )
      throw new RepositoryConflictError('Verification Job lease is invalid or expired');
    const value = {
      ...job,
      leaseExpiresAt: new Date(
        Math.min(
          new Date(input.now).getTime() + input.leaseSeconds * 1_000,
          new Date(job.deadlineAt).getTime(),
        ),
      ).toISOString(),
    };
    this.verificationJobs.set(value.id, value);
    await this.touchVerificationRunner(input.runnerId, input.now);
    return clone(value);
  }

  async completeVerificationJob(
    input: Parameters<ControlPlaneRepository['completeVerificationJob']>[0],
  ): Promise<VerificationJobRecord> {
    const runner = this.verificationRunners.get(input.runnerId);
    if (!runner || runner.revokedAt || runner.expiresAt <= input.now)
      throw new RepositoryConflictError('Verification Runner is revoked or expired');
    const job = this.verificationJobs.get(input.jobId);
    if (!job) throw new RepositoryNotFoundError('Verification Job not found');
    if (['succeeded', 'failed'].includes(job.state) && job.resultHash === input.resultHash) {
      if (job.leasedByRunnerId === input.runnerId && job.leaseId === input.leaseId)
        return clone(job);
      throw new RepositoryConflictError('Verification Job completion lease does not match');
    }
    if (
      job.state !== 'leased' ||
      job.leasedByRunnerId !== input.runnerId ||
      job.leaseId !== input.leaseId ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= input.now ||
      !job.deadlineAt ||
      job.deadlineAt <= input.now
    )
      throw new RepositoryConflictError('Verification Job lease is invalid or expired');
    const succeeded =
      input.result.outcome === 'verified' &&
      (input.result.buildStatus === 'passed' || input.result.buildStatus === 'changed');
    const value: VerificationJobRecord = {
      ...job,
      state: succeeded ? 'succeeded' : 'failed',
      result: clone(input.result),
      resultHash: input.resultHash,
      completedAt: input.now,
    };
    this.verificationJobs.set(value.id, value);
    const schedule = this.verificationSchedules.get(job.scheduleId);
    if (schedule) {
      this.verificationSchedules.set(schedule.id, {
        ...schedule,
        lastCompletedAt: input.now,
        ...(succeeded ? { lastSuccessfulAt: input.now } : {}),
        updatedAt: input.now,
        version: schedule.version + 1,
      });
    }
    await this.touchVerificationRunner(input.runnerId, input.now);
    return clone(value);
  }

  async consumeOidcToken(input: { tokenId: string }): Promise<boolean> {
    if (this.oidcTokens.has(input.tokenId)) return false;
    this.oidcTokens.add(input.tokenId);
    return true;
  }

  async createSceneRevision(
    input: Parameters<ControlPlaneRepository['createSceneRevision']>[0],
  ): Promise<SceneRevisionRecord> {
    const key = `${input.projectId}\0${input.scene.id}\0${input.revision}`;
    const existing = this.revisions.get(key);
    if (existing) return clone(existing);
    this.assertLifecycleAssetsActive(input.workspaceId, JsonValueSchema.parse(input.scene), true);
    const value: SceneRevisionRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      sceneId: input.scene.id,
      revision: input.revision,
      scene: clone(input.scene),
      privacy: clone(input.privacy),
      createdBy: input.createdBy,
      createdAt: input.now,
    };
    this.revisions.set(key, value);
    return clone(value);
  }

  async getSceneRevision(
    workspaceId: string,
    projectId: string,
    sceneId: string,
    revision: string,
  ): Promise<SceneRevisionRecord | undefined> {
    const value = this.revisions.get(`${projectId}\0${sceneId}\0${revision}`);
    return value?.workspaceId === workspaceId ? clone(value) : undefined;
  }

  async listSceneRevisions(
    workspaceId: string,
    projectId: string,
    sceneId: string,
    limit: number,
  ): Promise<readonly SceneRevisionRecord[]> {
    return [...this.revisions.values()]
      .filter(
        (value) =>
          value.workspaceId === workspaceId &&
          value.projectId === projectId &&
          value.sceneId === sceneId,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async listSceneHeads(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly SceneRevisionRecord[]> {
    const latest = new Map<string, SceneRevisionRecord>();
    for (const value of [...this.revisions.values()].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )) {
      if (value.workspaceId !== workspaceId || value.projectId !== projectId) continue;
      if (!latest.has(value.sceneId)) latest.set(value.sceneId, value);
    }
    return [...latest.values()].slice(0, limit).map(clone);
  }

  async createReview(
    workspaceId: string,
    projectId: string,
    review: Review,
  ): Promise<ReviewRecord> {
    const existing = this.reviews.get(review.id);
    if (existing) return clone(existing);
    const value = { workspaceId, projectId, review: ReviewSchema.parse(review) };
    this.reviews.set(review.id, value);
    return clone(value);
  }

  async getReview(
    workspaceId: string,
    projectId: string,
    reviewId: string,
  ): Promise<ReviewRecord | undefined> {
    const value = this.reviews.get(reviewId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listReviews(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ReviewRecord[]> {
    return [...this.reviews.values()]
      .filter((value) => value.workspaceId === workspaceId && value.projectId === projectId)
      .sort(
        (left, right) =>
          right.review.openedAt.localeCompare(left.review.openedAt) ||
          right.review.id.localeCompare(left.review.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async addReviewComment(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    comment: ReviewComment,
  ): Promise<ReviewRecord> {
    const record = await this.getReview(workspaceId, projectId, reviewId);
    if (!record) throw new RepositoryNotFoundError('Review not found');
    const normalized = ReviewCommentSchema.parse(comment);
    const existing = record.review.comments.find((candidate) => candidate.id === normalized.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(normalized))
        throw new RepositoryConflictError('Review comment idempotency conflict');
      return record;
    }
    const review = ReviewSchema.parse({
      ...record.review,
      comments: [...record.review.comments, normalized],
    });
    const updated = { ...record, review };
    this.reviews.set(reviewId, updated);
    return clone(updated);
  }

  async setReviewCommentResolution(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    commentId: string,
    expectedResolvedAt: string | undefined,
    resolution: { readonly resolvedAt?: string; readonly resolvedBy?: string },
  ): Promise<ReviewRecord> {
    const record = await this.getReview(workspaceId, projectId, reviewId);
    if (!record) throw new RepositoryNotFoundError('Review not found');
    const index = record.review.comments.findIndex((comment) => comment.id === commentId);
    const comment = record.review.comments[index];
    if (!comment) throw new RepositoryNotFoundError('Review comment not found');
    if (comment.resolvedAt !== expectedResolvedAt) {
      throw new RepositoryConflictError('Review comment resolution changed concurrently');
    }
    const comments = [...record.review.comments];
    const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...openComment } = comment;
    comments[index] = ReviewCommentSchema.parse({ ...openComment, ...resolution });
    const updated = {
      ...record,
      review: ReviewSchema.parse({ ...record.review, comments }),
    };
    this.reviews.set(reviewId, updated);
    return clone(updated);
  }

  async setReviewAssignees(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    expectedAssignedTo: readonly string[],
    assignedTo: readonly string[],
  ): Promise<ReviewRecord> {
    const record = await this.getReview(workspaceId, projectId, reviewId);
    if (!record) throw new RepositoryNotFoundError('Review not found');
    if (JSON.stringify(record.review.assignedTo) !== JSON.stringify(expectedAssignedTo)) {
      throw new RepositoryConflictError('Review assignment changed concurrently');
    }
    const updated = {
      ...record,
      review: ReviewSchema.parse({ ...record.review, assignedTo }),
    };
    this.reviews.set(reviewId, updated);
    return clone(updated);
  }

  async addReviewDecision(
    workspaceId: string,
    projectId: string,
    reviewId: string,
    decision: ReviewDecision,
  ): Promise<ReviewRecord> {
    const record = await this.getReview(workspaceId, projectId, reviewId);
    if (!record) throw new RepositoryNotFoundError('Review not found');
    const normalized = ReviewDecisionSchema.parse(decision);
    const existing = record.review.decisions.find((candidate) => candidate.id === normalized.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(normalized))
        throw new RepositoryConflictError('Review decision idempotency conflict');
      return record;
    }
    if (normalized.decision === 'approve' && record.review.subject.kind === 'run') {
      const run = this.verificationRuns.get(record.review.subject.id);
      if (!run || run.workspaceId !== workspaceId || run.projectId !== projectId) {
        throw new RepositoryConflictError('Review Run evidence is unavailable');
      }
      this.assertLifecycleAssetsActive(workspaceId, JsonValueSchema.parse(run.run));
    }
    const status =
      normalized.decision === 'approve'
        ? 'approved'
        : normalized.decision === 'reject'
          ? 'rejected'
          : normalized.decision === 'request-change'
            ? 'changes-requested'
            : record.review.status;
    const closed = status === 'approved' || status === 'rejected';
    const review = ReviewSchema.parse({
      ...record.review,
      status,
      decisions: [...record.review.decisions, normalized],
      ...(closed ? { closedAt: normalized.createdAt } : { closedAt: undefined }),
    });
    const updated = { ...record, review };
    this.reviews.set(reviewId, updated);
    return clone(updated);
  }

  private recordEvidence<
    T extends {
      id: string;
      workspaceId: string;
      projectId: string;
      idempotencyKey: string;
      requestHash: string;
    },
  >(kind: string, values: Map<string, T>, input: T): T {
    const idempotencyKey = `${kind}\0${input.workspaceId}\0${input.projectId}\0${input.idempotencyKey}`;
    const replay = this.evidenceIdempotency.get(idempotencyKey);
    if (replay) {
      if (replay.requestHash !== input.requestHash)
        throw new RepositoryConflictError(`${kind} evidence idempotency conflict`);
      const existing = values.get(replay.id);
      if (!existing) throw new RepositoryConflictError(`${kind} evidence replay is inconsistent`);
      return clone(existing);
    }
    const existing = values.get(input.id);
    if (existing) {
      if (
        existing.requestHash !== input.requestHash ||
        existing.idempotencyKey !== input.idempotencyKey
      )
        throw new RepositoryConflictError(`${kind} evidence ID is already in use`);
      return clone(existing);
    }
    values.set(input.id, clone(input));
    this.evidenceIdempotency.set(idempotencyKey, {
      id: input.id,
      requestHash: input.requestHash,
    });
    return clone(input);
  }

  private assertLifecycleAssetsActive(
    workspaceId: string,
    value: JsonValue,
    requireExisting = false,
  ): void {
    for (const asset of structuredAssetIdentities(value)) {
      const lifecycle = this.evidenceObjectLifecycle.get(
        `${workspaceId}\0${artifactObjectIdentity(asset.sha256, asset.mediaType)}`,
      );
      if ((requireExisting && !lifecycle) || (lifecycle && lifecycle.status !== 'active')) {
        throw new RepositoryConflictError(
          `Evidence object is not active: ${asset.sha256}:${asset.mediaType}`,
        );
      }
    }
  }

  async recordVerificationRun(input: VerificationRunRecord): Promise<VerificationRunRecord> {
    this.assertLifecycleAssetsActive(input.workspaceId, JsonValueSchema.parse(input.run));
    const recorded = this.recordEvidence('run', this.verificationRuns, input);
    const diagnostic = input.run.attempts.flatMap((attempt) => [
      ...(attempt.trace ? [attempt.trace] : []),
      ...attempt.attachments.filter((asset) => asset.role === 'trace' || asset.role === 'video'),
    ]);
    for (const asset of diagnostic) {
      const key = `${input.workspaceId}\0${artifactObjectIdentity(asset.sha256, asset.mediaType)}`;
      const lifecycle = this.evidenceObjectLifecycle.get(key);
      if (lifecycle)
        this.evidenceObjectLifecycle.set(key, { ...lifecycle, retentionClass: 'diagnostic' });
    }
    return recorded;
  }

  async getVerificationRun(
    workspaceId: string,
    projectId: string,
    runId: string,
  ): Promise<VerificationRunRecord | undefined> {
    const value = this.verificationRuns.get(runId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listVerificationRuns(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationRunRecord[]> {
    return [...this.verificationRuns.values()]
      .filter((value) => value.workspaceId === workspaceId && value.projectId === projectId)
      .sort(
        (left, right) =>
          right.recordedAt.localeCompare(left.recordedAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async recordVerificationBuild(input: VerificationBuildRecord): Promise<VerificationBuildRecord> {
    return this.recordEvidence('build', this.verificationBuilds, input);
  }

  async getVerificationBuild(
    workspaceId: string,
    projectId: string,
    buildId: string,
  ): Promise<VerificationBuildRecord | undefined> {
    const value = this.verificationBuilds.get(buildId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listVerificationBuilds(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationBuildRecord[]> {
    return [...this.verificationBuilds.values()]
      .filter((value) => value.workspaceId === workspaceId && value.projectId === projectId)
      .sort(
        (left, right) =>
          right.recordedAt.localeCompare(left.recordedAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async recordVerificationBaseline(
    input: VerificationBaselineRecord,
  ): Promise<VerificationBaselineRecord> {
    this.assertLifecycleAssetsActive(input.workspaceId, JsonValueSchema.parse(input.baseline));
    const sourceRun = this.verificationRuns.get(input.sourceRunId);
    if (sourceRun)
      this.assertLifecycleAssetsActive(input.workspaceId, JsonValueSchema.parse(sourceRun.run));
    return this.recordEvidence('baseline', this.verificationBaselines, input);
  }

  async getVerificationBaseline(
    workspaceId: string,
    projectId: string,
    baselineId: string,
  ): Promise<VerificationBaselineRecord | undefined> {
    const value = this.verificationBaselines.get(baselineId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listVerificationBaselines(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly VerificationBaselineRecord[]> {
    return [...this.verificationBaselines.values()]
      .filter((value) => value.workspaceId === workspaceId && value.projectId === projectId)
      .sort(
        (left, right) =>
          right.recordedAt.localeCompare(left.recordedAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async recordReviewApproval(input: ReviewApprovalRecord): Promise<ReviewApprovalRecord> {
    return this.recordEvidence('approval', this.reviewApprovals, input);
  }

  async getReviewApproval(
    workspaceId: string,
    projectId: string,
    approvalId: string,
  ): Promise<ReviewApprovalRecord | undefined> {
    const value = this.reviewApprovals.get(approvalId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listReviewApprovals(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ReviewApprovalRecord[]> {
    return [...this.reviewApprovals.values()]
      .filter((value) => value.workspaceId === workspaceId && value.projectId === projectId)
      .sort(
        (left, right) =>
          right.recordedAt.localeCompare(left.recordedAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
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
    const idempotency = `${input.workspaceId}\0${input.idempotencyKey}`;
    const existingId = this.uploadIdempotency.get(idempotency);
    if (existingId) {
      const existing = this.uploads.get(existingId)!;
      if (existing.requestHash !== input.requestHash)
        throw new RepositoryConflictError('Upload idempotency conflict');
      return clone(existing);
    }
    if (this.uploads.has(input.id))
      throw new RepositoryConflictError('Upload ID is already in use');
    for (const object of input.objects) {
      const lifecycle = this.evidenceObjectLifecycle.get(
        `${input.workspaceId}\0${artifactObjectIdentity(object.sha256, object.mediaType)}`,
      );
      if (lifecycle && (lifecycle.status === 'claimed' || lifecycle.status === 'deleting')) {
        throw new RepositoryConflictError('Object is being retained or deleted; retry upload');
      }
    }
    const active = [...this.uploads.values()].filter(
      (upload) =>
        (upload.status === 'pending' || upload.status === 'staged') && upload.expiresAt > input.now,
    );
    const tenant = active.filter((upload) => upload.workspaceId === input.workspaceId);
    const bytes = (uploads: readonly ArtifactUploadRecord[]): number =>
      uploads.reduce(
        (total, upload) =>
          total +
          upload.objects.reduce((objectTotal, object) => objectTotal + object.byteLength, 0),
        0,
      );
    const requestedBytes = input.objects.reduce((total, object) => total + object.byteLength, 0);
    if (tenant.length + 1 > input.limits.maxActiveUploadsPerTenant) {
      throw new RepositoryCapacityError('tenant', 'uploads');
    }
    if (active.length + 1 > input.limits.maxActiveUploadsGlobal) {
      throw new RepositoryCapacityError('global', 'uploads');
    }
    if (bytes(tenant) + requestedBytes > input.limits.maxActiveBytesPerTenant) {
      throw new RepositoryCapacityError('tenant', 'bytes');
    }
    if (bytes(active) + requestedBytes > input.limits.maxActiveBytesGlobal) {
      throw new RepositoryCapacityError('global', 'bytes');
    }
    const value: ArtifactUploadRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      repository: input.repository,
      commit: input.commit,
      ref: input.ref,
      status: 'pending',
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      objects: input.objects.map((object) => ({
        ...object,
        uploadId: input.id,
        status: 'pending',
      })),
      createdAt: input.now,
      expiresAt: input.expiresAt,
    };
    this.uploads.set(value.id, value);
    this.uploadIdempotency.set(idempotency, value.id);
    return clone(value);
  }

  async getUpload(uploadId: string): Promise<ArtifactUploadRecord | undefined> {
    const value = this.uploads.get(uploadId);
    return value ? clone(value) : undefined;
  }

  async listWorkspaceFinalizedUploads(
    workspaceId: string,
    limit: number,
  ): Promise<readonly ArtifactUploadRecord[]> {
    return [...this.uploads.values()]
      .filter((upload) => upload.workspaceId === workspaceId && upload.status === 'finalized')
      .sort(
        (left, right) =>
          (right.finalizedAt ?? '').localeCompare(left.finalizedAt ?? '') ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async getFinalizedUploadByManifest(
    workspaceId: string,
    projectId: string,
    repository: string,
    commit: string,
    manifestHash: string,
  ): Promise<ArtifactUploadRecord | undefined> {
    const value = [...this.uploads.values()].find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.projectId === projectId &&
        candidate.status === 'finalized' &&
        candidate.repository.toLowerCase() === repository.toLowerCase() &&
        candidate.commit === commit &&
        candidate.manifestHash === manifestHash,
    );
    return value ? clone(value) : undefined;
  }

  async getFinalizedObject(
    workspaceId: string,
    projectId: string,
    hash: string,
    mediaType: string,
  ): Promise<StoredObject | undefined> {
    const lifecycle = this.evidenceObjectLifecycle.get(
      `${workspaceId}\0${artifactObjectIdentity(hash, mediaType)}`,
    );
    if (lifecycle && lifecycle.status !== 'active') return undefined;
    for (const upload of this.uploads.values()) {
      if (
        upload.workspaceId !== workspaceId ||
        upload.projectId !== projectId ||
        upload.status !== 'finalized'
      ) {
        continue;
      }
      const object = upload.objects.find(
        (candidate) =>
          candidate.sha256 === hash &&
          candidate.mediaType === mediaType &&
          candidate.status === 'finalized' &&
          candidate.finalKey,
      );
      if (object?.finalKey) {
        return {
          key: object.finalKey,
          sha256: object.sha256,
          byteLength: object.byteLength,
          mediaType: object.mediaType,
        };
      }
    }
    return undefined;
  }

  async markObjectStaged(
    uploadId: string,
    hash: string,
    mediaType: string,
    stagingKey: string,
    now: string,
  ): Promise<ArtifactUploadRecord> {
    const existing = this.uploads.get(uploadId);
    if (!existing) throw new RepositoryNotFoundError('Upload not found');
    if (
      existing.status === 'expired' ||
      existing.status === 'finalized' ||
      existing.expiresAt <= now
    ) {
      throw new RepositoryConflictError('Upload no longer accepts staged objects');
    }
    const objects = existing.objects.map((object) =>
      object.sha256 === hash && object.mediaType === mediaType && object.status !== 'finalized'
        ? { ...object, status: 'staged' as const, stagingKey }
        : object,
    );
    if (!objects.some((object) => object.sha256 === hash && object.mediaType === mediaType))
      throw new RepositoryNotFoundError('Upload object not found');
    const status = objects.every((object) => object.status === 'staged')
      ? 'staged'
      : existing.status;
    const updated = { ...existing, status, objects };
    this.uploads.set(uploadId, updated);
    return clone(updated);
  }

  async claimExpiredUploads(
    input: Parameters<ControlPlaneRepository['claimExpiredUploads']>[0],
  ): Promise<readonly ArtifactUploadRecord[]> {
    const candidates = [...this.uploads.values()]
      .filter((upload) => {
        if (upload.status === 'finalized' || upload.expiresAt > input.now) return false;
        const claim = this.uploadGcClaims.get(upload.id);
        return !claim?.completedAt && (!claim || claim.claimedUntil <= input.now);
      })
      .sort(
        (left, right) =>
          left.expiresAt.localeCompare(right.expiresAt) || left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
    for (const upload of candidates) {
      this.uploads.set(upload.id, { ...upload, status: 'expired' });
      this.uploadGcClaims.set(upload.id, {
        claimId: input.claimId,
        claimedUntil: input.claimedUntil,
      });
    }
    return candidates.map((upload) => clone({ ...upload, status: 'expired' as const }));
  }

  async completeExpiredUpload(uploadId: string, claimId: string, now: string): Promise<boolean> {
    const upload = this.uploads.get(uploadId);
    const claim = this.uploadGcClaims.get(uploadId);
    if (!upload || upload.status !== 'expired' || claim?.claimId !== claimId) return false;
    if (!claim.completedAt) this.uploadGcClaims.set(uploadId, { ...claim, completedAt: now });
    return true;
  }

  async listEvidenceRetentionWorkspaceIds(
    input: Parameters<ControlPlaneRepository['listEvidenceRetentionWorkspaceIds']>[0],
  ): Promise<readonly string[]> {
    return [
      ...new Set(
        [...this.evidenceObjectLifecycle.values()]
          .filter((value) => value.status !== 'deleted')
          .map((value) => value.workspaceId),
      ),
    ]
      .filter((workspaceId) => workspaceId > (input.afterWorkspaceId ?? ''))
      .sort()
      .slice(0, input.limit);
  }

  private lifecycleIsProtected(value: EvidenceObjectLifecycleRecord): boolean {
    const identity = artifactObjectIdentity(value.sha256, value.mediaType);
    const hasAsset = (input: unknown): boolean => {
      if (!input || typeof input !== 'object') return false;
      if (Array.isArray(input)) return input.some(hasAsset);
      const record = input as Record<string, unknown>;
      if (record.sha256 === value.sha256 && record.mediaType === value.mediaType) return true;
      return Object.values(record).some(hasAsset);
    };
    for (const scene of this.revisions.values()) {
      if (scene.workspaceId === value.workspaceId && hasAsset(scene.scene)) return true;
    }
    for (const [key, versions] of this.studioSceneVersions) {
      if (key.startsWith(`${value.workspaceId}\0`) && versions.some(hasAsset)) return true;
    }
    for (const baseline of this.verificationBaselines.values()) {
      if (baseline.workspaceId !== value.workspaceId) continue;
      if (hasAsset(baseline.baseline)) return true;
      const sourceRun = this.verificationRuns.get(baseline.sourceRunId);
      if (sourceRun && hasAsset(sourceRun.run)) return true;
    }
    for (const release of this.releases.values()) {
      if (release.workspaceId !== value.workspaceId) continue;
      if (hasAsset(release.release)) return true;
      const uploadId = release.promotionEvidence?.artifactUploadId;
      const upload = uploadId ? this.uploads.get(uploadId) : undefined;
      if (
        upload?.objects.some(
          (object) => artifactObjectIdentity(object.sha256, object.mediaType) === identity,
        )
      ) {
        return true;
      }
      for (const scene of release.promotionEvidence?.scenes ?? []) {
        const run = this.verificationRuns.get(scene.runId);
        if (run && hasAsset(run.run)) return true;
      }
    }
    for (const review of this.reviews.values()) {
      if (review.workspaceId !== value.workspaceId || review.review.status !== 'approved') continue;
      if (review.review.subject.kind === 'run') {
        const run = this.verificationRuns.get(review.review.subject.id);
        if (run && hasAsset(run.run)) return true;
      }
    }
    return false;
  }

  async claimEvidenceRetentionObjects(
    input: Parameters<ControlPlaneRepository['claimEvidenceRetentionObjects']>[0],
  ): ReturnType<ControlPlaneRepository['claimEvidenceRetentionObjects']> {
    const candidates = [...this.evidenceObjectLifecycle.values()]
      .filter((value) => {
        if (value.workspaceId !== input.workspaceId || value.status === 'deleted') return false;
        if (value.status === 'active') return true;
        return (value.claimedUntil ?? '') <= input.now;
      })
      .sort(
        (left, right) =>
          left.lastFinalizedAt.localeCompare(right.lastFinalizedAt) ||
          left.sha256.localeCompare(right.sha256) ||
          left.mediaType.localeCompare(right.mediaType),
      )
      .slice(0, input.limit);
    const evaluations: EvidenceRetentionEvaluationRecord[] = [];
    const claims: EvidenceRetentionClaimRecord[] = [];
    for (const candidate of candidates) {
      const projectIds = [
        ...new Set(
          [...this.uploads.values()]
            .filter(
              (upload) =>
                upload.workspaceId === candidate.workspaceId &&
                upload.objects.some(
                  (object) =>
                    object.sha256 === candidate.sha256 && object.mediaType === candidate.mediaType,
                ),
            )
            .map((upload) => upload.projectId),
        ),
      ].sort();
      const cutoff =
        candidate.retentionClass === 'diagnostic' ? input.diagnosticCutoff : input.standardCutoff;
      const activeUpload = [...this.uploads.values()].some(
        (upload) =>
          upload.workspaceId === candidate.workspaceId &&
          (upload.status === 'pending' || upload.status === 'staged') &&
          upload.objects.some(
            (object) =>
              object.sha256 === candidate.sha256 && object.mediaType === candidate.mediaType,
          ),
      );
      const disposition =
        candidate.lastFinalizedAt > cutoff
          ? ('grace-period' as const)
          : this.lifecycleIsProtected(candidate) || activeUpload
            ? ('protected' as const)
            : ('eligible' as const);
      const reason =
        disposition === 'grace-period'
          ? `${candidate.retentionClass} grace period has not elapsed`
          : disposition === 'protected'
            ? activeUpload
              ? 'matching active upload exists'
              : 'hosted Studio, immutable evidence, or Release reference exists'
            : 'grace elapsed and no protected reference or active upload exists';
      evaluations.push({ ...candidate, projectIds, disposition, reason });
      if (disposition !== 'eligible') continue;
      const claim: EvidenceRetentionClaimRecord = {
        ...candidate,
        status: 'claimed',
        claimId: input.claimId,
        claimedUntil: input.claimedUntil,
        projectIds,
      };
      if (!input.dryRun) {
        const { projectIds: _projectIds, ...lifecycle } = claim;
        this.evidenceObjectLifecycle.set(
          `${candidate.workspaceId}\0${artifactObjectIdentity(candidate.sha256, candidate.mediaType)}`,
          lifecycle,
        );
      }
      claims.push(clone(claim));
    }
    return Promise.resolve({ evaluations: clone(evaluations), claims });
  }

  async beginFinalEvidenceDeletion(
    input: Parameters<ControlPlaneRepository['beginFinalEvidenceDeletion']>[0],
  ): Promise<EvidenceRetentionClaimRecord | undefined> {
    const key = `${input.workspaceId}\0${artifactObjectIdentity(input.sha256, input.mediaType)}`;
    const value = this.evidenceObjectLifecycle.get(key);
    if (
      !value ||
      value.status !== 'claimed' ||
      value.claimId !== input.claimId ||
      (value.claimedUntil ?? '') <= input.now ||
      this.lifecycleIsProtected(value)
    ) {
      return undefined;
    }
    const deleting: EvidenceObjectLifecycleRecord = { ...value, status: 'deleting' };
    this.evidenceObjectLifecycle.set(key, deleting);
    const projects = [...this.uploads.values()]
      .filter(
        (upload) =>
          upload.workspaceId === input.workspaceId &&
          upload.objects.some(
            (object) => object.sha256 === input.sha256 && object.mediaType === input.mediaType,
          ),
      )
      .map((upload) => upload.projectId);
    return clone({
      ...deleting,
      status: 'deleting',
      claimId: input.claimId,
      claimedUntil: value.claimedUntil!,
      projectIds: [...new Set(projects)].sort(),
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
    const key = `${input.workspaceId}\0${artifactObjectIdentity(input.sha256, input.mediaType)}`;
    const value = this.evidenceObjectLifecycle.get(key);
    if (!value || value.status !== 'deleting' || value.claimId !== input.claimId) return false;
    if (
      this.evidenceRetentionEvents.some((candidate) => candidate.id === input.event.id) ||
      this.audits.some((candidate) => candidate.id === input.audit.id)
    ) {
      throw new RepositoryConflictError('Final evidence deletion audit ID is already in use');
    }
    const event = clone(input.event);
    const audit = { ...clone(input.audit), sequence: this.audits.length + 1 };
    this.evidenceObjectLifecycle.set(key, {
      workspaceId: value.workspaceId,
      sha256: value.sha256,
      byteLength: value.byteLength,
      mediaType: value.mediaType,
      retentionClass: value.retentionClass,
      status: 'deleted',
      firstFinalizedAt: value.firstFinalizedAt,
      lastFinalizedAt: value.lastFinalizedAt,
      deletedAt: input.now,
    });
    this.evidenceRetentionEvents.push(event);
    this.audits.push(audit);
    return true;
  }

  async releaseFinalEvidenceDeletion(
    input: Parameters<ControlPlaneRepository['releaseFinalEvidenceDeletion']>[0],
  ): Promise<boolean> {
    const key = `${input.workspaceId}\0${artifactObjectIdentity(input.sha256, input.mediaType)}`;
    const value = this.evidenceObjectLifecycle.get(key);
    if (
      !value ||
      !['claimed', 'deleting'].includes(value.status) ||
      value.claimId !== input.claimId
    )
      return false;
    this.evidenceObjectLifecycle.set(key, {
      workspaceId: value.workspaceId,
      sha256: value.sha256,
      byteLength: value.byteLength,
      mediaType: value.mediaType,
      retentionClass: value.retentionClass,
      status: 'active',
      firstFinalizedAt: value.firstFinalizedAt,
      lastFinalizedAt: value.lastFinalizedAt,
    });
    return true;
  }

  async appendEvidenceRetentionEvent(event: EvidenceRetentionEventRecord): Promise<void> {
    if (!this.evidenceRetentionEvents.some((candidate) => candidate.id === event.id)) {
      this.evidenceRetentionEvents.push(clone(event));
    }
  }

  async appendEvidenceRetentionEventAndAudit(
    event: EvidenceRetentionEventRecord,
    audit: AuditEventRecord,
  ): Promise<void> {
    const hasEvent = this.evidenceRetentionEvents.some((candidate) => candidate.id === event.id);
    const hasAudit = this.audits.some((candidate) => candidate.id === audit.id);
    if (!hasEvent) this.evidenceRetentionEvents.push(clone(event));
    if (!hasAudit) this.audits.push({ ...clone(audit), sequence: this.audits.length + 1 });
  }

  async listWorkspaceArtifactInventory(
    workspaceId: string,
    limit: number,
  ): Promise<readonly WorkspaceArtifactInventoryRecord[]> {
    return [...this.uploads.values()]
      .filter((upload) => upload.workspaceId === workspaceId && upload.status === 'finalized')
      .flatMap((upload) =>
        upload.objects.map((object) => ({
          projectId: upload.projectId,
          uploadId: upload.id,
          sha256: object.sha256,
          byteLength: object.byteLength,
          mediaType: object.mediaType,
          finalizedAt: upload.finalizedAt!,
          lifecycleStatus:
            this.evidenceObjectLifecycle.get(
              `${workspaceId}\0${artifactObjectIdentity(object.sha256, object.mediaType)}`,
            )?.status ?? 'active',
        })),
      )
      .sort(
        (left, right) =>
          left.projectId.localeCompare(right.projectId) ||
          left.sha256.localeCompare(right.sha256) ||
          left.mediaType.localeCompare(right.mediaType) ||
          left.uploadId.localeCompare(right.uploadId),
      )
      .slice(0, limit)
      .map(clone);
  }

  async finalizeUpload(
    uploadId: string,
    manifestHash: string,
    promoted: readonly StoredObject[],
    now: string,
  ): Promise<ArtifactUploadRecord> {
    const existing = this.uploads.get(uploadId);
    if (!existing) throw new RepositoryNotFoundError('Upload not found');
    if (existing.status === 'finalized') {
      if (existing.manifestHash !== manifestHash)
        throw new RepositoryConflictError('Finalized upload has another manifest');
      return clone(existing);
    }
    if (
      existing.status !== 'staged' ||
      existing.objects.some((object) => object.status !== 'staged')
    ) {
      throw new RepositoryConflictError('Every object must be staged');
    }
    const byIdentity = new Map(
      promoted.map((object) => [artifactObjectIdentity(object.sha256, object.mediaType), object]),
    );
    if (byIdentity.size !== existing.objects.length)
      throw new RepositoryConflictError('Promoted objects are incomplete');
    const objects = existing.objects.map((object) => {
      const final = byIdentity.get(artifactObjectIdentity(object.sha256, object.mediaType));
      if (!final || final.byteLength !== object.byteLength || final.mediaType !== object.mediaType)
        throw new RepositoryConflictError('Promoted objects are incomplete');
      return { ...object, status: 'finalized' as const, finalKey: final.key };
    });
    const updated = {
      ...existing,
      status: 'finalized' as const,
      manifestHash,
      finalizedAt: now,
      objects,
    };
    this.uploads.set(uploadId, updated);
    for (const object of objects) {
      const key = `${updated.workspaceId}\0${artifactObjectIdentity(object.sha256, object.mediaType)}`;
      const current = this.evidenceObjectLifecycle.get(key);
      this.evidenceObjectLifecycle.set(key, {
        workspaceId: updated.workspaceId,
        sha256: object.sha256,
        byteLength: object.byteLength,
        mediaType: object.mediaType,
        retentionClass:
          object.mediaType === 'video/mp4' || object.mediaType === 'video/webm'
            ? 'diagnostic'
            : (current?.retentionClass ?? 'standard'),
        status: 'active',
        firstFinalizedAt: current?.firstFinalizedAt ?? now,
        lastFinalizedAt: now,
      });
    }
    return clone(updated);
  }

  async createChannel(
    input: Parameters<ControlPlaneRepository['createChannel']>[0],
  ): Promise<ChannelRecord> {
    const existing = this.channels.get(input.id);
    if (existing) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.projectId !== input.projectId ||
        existing.slug !== input.slug ||
        existing.name !== input.name ||
        existing.kind !== input.kind ||
        JSON.stringify(existing.policy) !== JSON.stringify(input.policy) ||
        JSON.stringify(existing.webhookIds) !== JSON.stringify(input.webhookIds) ||
        existing.analyticsTokenHash !== input.analyticsTokenHash
      ) {
        throw new RepositoryConflictError('Channel idempotency conflict');
      }
      return clone(existing);
    }
    const value: ChannelRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      policy: ChannelPolicySchema.parse(input.policy),
      webhookIds: [...input.webhookIds],
      analyticsTokenHash: input.analyticsTokenHash,
      sequence: 0,
      createdAt: input.now,
    };
    this.channels.set(value.id, value);
    return clone(value);
  }

  async getChannel(
    workspaceId: string,
    projectId: string,
    channelId: string,
  ): Promise<ChannelRecord | undefined> {
    const value = this.channels.get(channelId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listChannels(
    workspaceId: string,
    projectId: string,
    limit: number,
  ): Promise<readonly ChannelRecord[]> {
    return [...this.channels.values()]
      .filter((value) => value.workspaceId === workspaceId && value.projectId === projectId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
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
    const domain =
      route.kind === 'hostname'
        ? [...this.customDomains.values()].find(
            (candidate) =>
              candidate.hostname === normalizeCustomDomainHostname(route.hostname) &&
              candidate.status === 'active',
          )
        : undefined;
    const workspace =
      route.kind === 'path'
        ? [...this.workspaces.values()].find((candidate) => candidate.slug === route.workspaceSlug)
        : domain
          ? this.workspaces.get(domain.workspaceId)
          : undefined;
    const project = workspace
      ? [...this.projects.values()].find(
          (candidate) =>
            candidate.workspaceId === workspace.id &&
            (route.kind === 'path'
              ? candidate.slug === route.projectSlug
              : candidate.id === domain?.projectId),
        )
      : undefined;
    const value = project
      ? [...this.channels.values()].find(
          (candidate) =>
            candidate.workspaceId === workspace!.id &&
            candidate.projectId === project.id &&
            (route.kind === 'path'
              ? candidate.slug === route.channelSlug
              : candidate.id === domain?.channelId),
        )
      : undefined;
    if (!workspace || !project || !value) return undefined;
    const release = value.currentReleaseId ? this.releases.get(value.currentReleaseId) : undefined;
    return clone({
      workspace,
      project,
      channel: value,
      ...(release ? { release } : {}),
      ...(domain ? { customDomain: domain } : {}),
    });
  }

  async createCustomDomain(input: CustomDomainRecord): Promise<CustomDomainRecord> {
    const existing = this.customDomains.get(input.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) {
        throw new RepositoryConflictError('Custom domain idempotency conflict');
      }
      return clone(existing);
    }
    const channel = this.channels.get(input.channelId);
    if (
      !channel ||
      channel.workspaceId !== input.workspaceId ||
      channel.projectId !== input.projectId
    ) {
      throw new RepositoryNotFoundError('Channel not found');
    }
    if (input.version !== 1)
      throw new RepositoryConflictError('Custom domain must start at version 1');
    const conflict = [...this.customDomains.values()].find(
      (candidate) =>
        candidate.status !== 'removed' &&
        ((candidate.status !== 'pending-dns' &&
          input.status !== 'pending-dns' &&
          candidate.hostname === input.hostname) ||
          (candidate.workspaceId === input.workspaceId &&
            candidate.projectId === input.projectId &&
            candidate.channelId === input.channelId)),
    );
    if (conflict) throw new RepositoryConflictError('Custom domain or Channel already has a claim');
    this.customDomains.set(input.id, clone(input));
    return clone(input);
  }

  async getCustomDomain(
    workspaceId: string,
    projectId: string,
    channelId: string,
    domainId: string,
  ): Promise<CustomDomainRecord | undefined> {
    const value = this.customDomains.get(domainId);
    return value?.workspaceId === workspaceId &&
      value.projectId === projectId &&
      value.channelId === channelId
      ? clone(value)
      : undefined;
  }

  async getActiveCustomDomainByHostname(hostname: string): Promise<CustomDomainRecord | undefined> {
    const normalized = normalizeCustomDomainHostname(hostname);
    const value = [...this.customDomains.values()].find(
      (candidate) => candidate.hostname === normalized && candidate.status === 'active',
    );
    return value ? clone(value) : undefined;
  }

  async listCustomDomains(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly CustomDomainRecord[]> {
    return [...this.customDomains.values()]
      .filter(
        (value) =>
          value.workspaceId === workspaceId &&
          value.projectId === projectId &&
          value.channelId === channelId,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async updateCustomDomain(input: {
    record: CustomDomainRecord;
    expectedVersion: number;
  }): Promise<CustomDomainRecord> {
    const current = this.customDomains.get(input.record.id);
    if (!current) throw new RepositoryNotFoundError('Custom domain not found');
    if (current.version !== input.expectedVersion) {
      throw new RepositoryConflictError('Custom domain changed');
    }
    if (
      input.record.version !== input.expectedVersion + 1 ||
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
    if (input.record.status !== 'removed') {
      const conflict = [...this.customDomains.values()].find(
        (candidate) =>
          candidate.id !== input.record.id &&
          candidate.status !== 'removed' &&
          ((candidate.status !== 'pending-dns' &&
            input.record.status !== 'pending-dns' &&
            candidate.hostname === input.record.hostname) ||
            (candidate.workspaceId === input.record.workspaceId &&
              candidate.projectId === input.record.projectId &&
              candidate.channelId === input.record.channelId)),
      );
      if (conflict)
        throw new RepositoryConflictError('Custom domain or Channel already has a claim');
    }
    this.customDomains.set(input.record.id, clone(input.record));
    return clone(input.record);
  }

  async promoteRelease(
    input: Parameters<ControlPlaneRepository['promoteRelease']>[0],
  ): Promise<ReleaseRecord> {
    const idempotency = `${input.channelId}\0${input.idempotencyKey}`;
    const existingId = this.releaseIdempotency.get(idempotency);
    if (existingId) {
      const existing = this.releases.get(existingId)!;
      if (existing.requestHash !== input.requestHash)
        throw new RepositoryConflictError('Release idempotency conflict');
      return clone(existing);
    }
    const artifactUploadId = input.promotionEvidence?.artifactUploadId;
    const artifactUpload = artifactUploadId ? this.uploads.get(artifactUploadId) : undefined;
    if (artifactUpload) {
      this.assertLifecycleAssetsActive(
        input.workspaceId,
        JsonValueSchema.parse(artifactUpload.objects),
      );
    }
    const current = this.channels.get(input.channelId);
    if (
      !current ||
      current.workspaceId !== input.workspaceId ||
      current.projectId !== input.projectId
    ) {
      throw new RepositoryNotFoundError('Channel not found');
    }
    if (current.currentReleaseId !== input.expectedCurrentReleaseId)
      throw new RepositoryConflictError('Channel current Release changed');
    const release = ReleaseSchema.parse({
      ...input.release,
      channelId: input.channelId,
      sequence: current.sequence + 1,
      status: 'published',
      publishedAt: input.now,
      ...(current.currentReleaseId ? { supersedesReleaseId: current.currentReleaseId } : {}),
    });
    const value = {
      release,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      ...(input.promotionEvidence ? { promotionEvidence: clone(input.promotionEvidence) } : {}),
    };
    if (current.currentReleaseId) {
      const previous = this.releases.get(current.currentReleaseId);
      if (previous) {
        this.releases.set(current.currentReleaseId, {
          ...previous,
          release: ReleaseSchema.parse({ ...previous.release, status: 'superseded' }),
        });
      }
    }
    this.releases.set(release.id, value);
    this.releaseIdempotency.set(idempotency, release.id);
    this.channels.set(current.id, {
      ...current,
      currentReleaseId: release.id,
      sequence: release.sequence,
    });
    return clone(value);
  }

  async rollbackRelease(
    input: Parameters<ControlPlaneRepository['rollbackRelease']>[0],
  ): Promise<ReleaseRecord> {
    const idempotency = `${input.channelId}\0${input.idempotencyKey}`;
    const existingId = this.releaseIdempotency.get(idempotency);
    if (existingId) {
      const existing = this.releases.get(existingId)!;
      if (existing.requestHash !== input.requestHash)
        throw new RepositoryConflictError('Rollback idempotency conflict');
      return clone(existing);
    }
    const current = this.channels.get(input.channelId);
    if (!current || current.currentReleaseId !== input.expectedCurrentReleaseId)
      throw new RepositoryConflictError('Channel current Release changed');
    const target = this.releases.get(input.targetReleaseId);
    if (!target || target.release.channelId !== input.channelId)
      throw new RepositoryNotFoundError('Rollback target not found');
    const result = await this.promoteRelease({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      channelId: input.channelId,
      release: { ...target.release, id: input.newReleaseId },
      expectedCurrentReleaseId: input.expectedCurrentReleaseId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      now: input.now,
    });
    const rolledBack = this.releases.get(input.expectedCurrentReleaseId);
    if (rolledBack) {
      this.releases.set(input.expectedCurrentReleaseId, {
        ...rolledBack,
        release: ReleaseSchema.parse({ ...rolledBack.release, status: 'rolled-back' }),
      });
    }
    return result;
  }

  async getRelease(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | undefined> {
    const value = this.releases.get(releaseId);
    return value?.workspaceId === workspaceId && value.projectId === projectId
      ? clone(value)
      : undefined;
  }

  async listReleases(
    workspaceId: string,
    projectId: string,
    channelId: string,
    limit: number,
  ): Promise<readonly ReleaseRecord[]> {
    return [...this.releases.values()]
      .filter(
        (value) =>
          value.workspaceId === workspaceId &&
          value.projectId === projectId &&
          value.release.channelId === channelId,
      )
      .sort(
        (left, right) =>
          right.release.sequence - left.release.sequence ||
          right.release.id.localeCompare(left.release.id),
      )
      .slice(0, limit)
      .map(clone);
  }

  async ingestAnalytics(event: AnalyticsEventRecord): Promise<boolean> {
    if (this.analytics.has(event.id)) return false;
    const release = this.releases.get(event.releaseId);
    if (!release || release.release.channelId !== event.channelId) return false;
    this.analytics.set(event.id, clone(event));
    return true;
  }

  async aggregateAnalytics(input: {
    workspaceId: string;
    projectId: string;
    channelId: string;
    releaseId: string;
    from: string;
    to: string;
  }): Promise<readonly AnalyticsAggregateRow[]> {
    const from = new Date(input.from).getTime();
    const to = new Date(input.to).getTime();
    const aggregates = new Map<
      string,
      {
        scope: AnalyticsAggregateRow['scope'];
        sceneId?: string;
        stepId?: string;
        type: AnalyticsEventRecord['type'];
        eventCount: number;
        subjects: Set<string>;
      }
    >();
    const record = (
      scope: AnalyticsAggregateRow['scope'],
      event: AnalyticsEventRecord,
      subject: string,
    ): void => {
      const sceneId = scope === 'total' ? undefined : event.sceneId;
      const stepId = scope === 'step' ? event.stepId : undefined;
      const key = `${scope}\u0000${sceneId ?? ''}\u0000${stepId ?? ''}\u0000${event.type}`;
      let aggregate = aggregates.get(key);
      if (!aggregate) {
        aggregate = {
          scope,
          ...(sceneId ? { sceneId } : {}),
          ...(stepId ? { stepId } : {}),
          type: event.type,
          eventCount: 0,
          subjects: new Set(),
        };
        aggregates.set(key, aggregate);
      }
      aggregate.eventCount += 1;
      aggregate.subjects.add(subject);
    };
    for (const event of this.analytics.values()) {
      if (
        event.workspaceId !== input.workspaceId ||
        event.projectId !== input.projectId ||
        event.channelId !== input.channelId ||
        event.releaseId !== input.releaseId ||
        new Date(event.occurredAt).getTime() < from ||
        new Date(event.occurredAt).getTime() > to
      ) {
        continue;
      }
      const subject = event.sessionIdHash ?? event.anonymousIdHash ?? `event:${event.id}`;
      record('total', event, subject);
      record('scene', event, subject);
      if (event.stepId) record('step', event, subject);
    }
    const scopeOrder: Readonly<Record<AnalyticsAggregateRow['scope'], number>> = {
      total: 0,
      scene: 1,
      step: 2,
    };
    return [...aggregates.values()]
      .map(({ subjects, ...aggregate }) => ({
        ...aggregate,
        uniqueSubjectCount: subjects.size,
      }))
      .sort(
        (left, right) =>
          scopeOrder[left.scope] - scopeOrder[right.scope] ||
          (left.sceneId ?? '').localeCompare(right.sceneId ?? '') ||
          (left.stepId ?? '').localeCompare(right.stepId ?? '') ||
          left.type.localeCompare(right.type),
      );
  }

  async createCtaSubmission(
    input: CtaSubmissionRecord,
    delivery: WebhookDeliveryRecord,
  ): Promise<boolean> {
    if (this.submissions.has(input.id)) return false;
    const release = this.releases.get(input.releaseId);
    if (!release || release.release.channelId !== input.channelId) return false;
    this.submissions.set(input.id, clone(input));
    this.deliveries.set(delivery.id, clone(delivery));
    return true;
  }

  async claimWebhookDeliveries(
    now: string,
    limit: number,
  ): Promise<readonly WebhookDeliveryRecord[]> {
    const claimed = [...this.deliveries.values()]
      .filter(
        (delivery) =>
          (delivery.status === 'pending' || delivery.status === 'failed') &&
          delivery.nextAttemptAt <= now,
      )
      .sort(
        (left, right) =>
          left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((delivery) => ({
        ...delivery,
        status: 'delivering' as const,
        attempts: delivery.attempts + 1,
      }));
    for (const delivery of claimed) this.deliveries.set(delivery.id, delivery);
    return clone(claimed);
  }

  async completeWebhookDelivery(
    input: Parameters<ControlPlaneRepository['completeWebhookDelivery']>[0],
  ): Promise<void> {
    const delivery = this.deliveries.get(input.id);
    if (!delivery) throw new RepositoryNotFoundError('Webhook delivery not found');
    this.deliveries.set(input.id, {
      ...delivery,
      status: input.succeeded ? 'succeeded' : input.terminal ? 'exhausted' : 'failed',
      ...(input.status === undefined ? {} : { lastStatus: input.status }),
      ...(input.error === undefined ? {} : { lastError: input.error }),
      ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: input.nextAttemptAt }),
    });
  }

  async getCtaSubmission(id: string): Promise<CtaSubmissionRecord | undefined> {
    const value = this.submissions.get(id);
    return value ? clone(value) : undefined;
  }

  async appendAudit(event: AuditEventRecord): Promise<void> {
    if (this.audits.some((candidate) => candidate.id === event.id)) return;
    this.audits.push({ ...clone(event), sequence: this.audits.length + 1 });
  }

  async listAudit(
    workspaceId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly (AuditEventRecord & { sequence: number })[]> {
    return clone(
      this.audits
        .filter((event) => event.workspaceId === workspaceId && event.sequence > afterSequence)
        .slice(0, limit),
    );
  }
}
