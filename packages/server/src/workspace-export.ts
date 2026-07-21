import { sha256, stableStringify } from '@scenebook/core';
import { Zip, ZipPassThrough } from 'fflate';

import type {
  ArtifactUploadRecord,
  AuditEventRecord,
  ChannelRecord,
  CustomDomainRecord,
  GitHubInstallationBindingRecord,
  VerificationJobRecord,
  VerificationRunnerRecord,
  WorkspaceArtifactInventoryRecord,
} from './domain.js';
import type { ImmutableObjectStore, StoredObject } from './object-store.js';
import type { ControlPlaneRepository } from './repository.js';

const encoder = new TextEncoder();
const ZIP_EPOCH = new Date('1980-01-01T00:00:00.000Z');

export class WorkspaceExportLimitError extends Error {
  constructor(
    readonly kind:
      'records' | 'assets' | 'bytes' | 'metadata-bytes' | 'total-bytes' | 'concurrent-change',
  ) {
    super(
      kind === 'concurrent-change'
        ? 'Workspace changed while its export snapshot was assembled'
        : `Workspace export ${kind} limit exceeded`,
    );
    this.name = 'WorkspaceExportLimitError';
  }
}

export interface WorkspaceExportOptions {
  readonly repository: ControlPlaneRepository;
  readonly objectStore: ImmutableObjectStore;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly maxRecords: number;
  readonly maxAssets: number;
  readonly maxAssetBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxTotalBytes: number;
}

interface ExportAsset {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly disposition: 'included' | 'withheld' | 'unavailable';
  readonly reason: string;
  readonly referencedBy: readonly string[];
  readonly privacyExclusions: readonly string[];
  readonly requiredForRestore: boolean;
  readonly projectIds: readonly string[];
  readonly uploadIds: readonly string[];
  readonly object?: StoredObject;
}

interface ExportMember {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface PreparedWorkspaceExport {
  readonly filename: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly body: ReadableStream<Uint8Array>;
}

export class WorkspaceExportIntegrityError extends Error {
  constructor(readonly objectIdentity: string) {
    super(`Workspace export cannot restore referenced object ${objectIdentity}`);
    this.name = 'WorkspaceExportIntegrityError';
  }
}

function withoutSecrets(value: unknown, key = '', depth = 0): unknown {
  if (depth > 24) return '[depth-limit]';
  if (
    /token|secret|password|credential|encrypted|challengevalue|operationid|operationkey|iphash/iu.test(
      key,
    )
  ) {
    return '[withheld]';
  }
  if (Array.isArray(value)) return value.map((item) => withoutSecrets(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        withoutSecrets(child, childKey, depth + 1),
      ]),
    );
  }
  return value;
}

function safeChannel(channel: ChannelRecord): Omit<ChannelRecord, 'analyticsTokenHash'> {
  const { analyticsTokenHash: _analyticsTokenHash, ...safe } = channel;
  return safe;
}

function safeRunner(runner: VerificationRunnerRecord): Omit<VerificationRunnerRecord, 'tokenHash'> {
  const { tokenHash: _tokenHash, ...safe } = runner;
  return safe;
}

function safeJob(job: VerificationJobRecord): Omit<VerificationJobRecord, 'leaseId'> {
  const { leaseId: _leaseId, ...safe } = job;
  return safe;
}

function safeDomain(domain: CustomDomainRecord): Readonly<Record<string, unknown>> {
  return withoutSecrets(domain) as Readonly<Record<string, unknown>>;
}

function safeGitHubInstallationBinding(
  binding: GitHubInstallationBindingRecord,
): Readonly<Record<string, unknown>> {
  return {
    id: binding.id,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    repositoryBindingId: binding.repositoryBindingId,
    installationId: binding.installationId,
    githubRepositoryId: binding.githubRepositoryId,
    defaultBranch: binding.defaultBranch,
    createdBy: binding.createdBy,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    version: binding.version,
    ...(binding.revokedAt ? { revokedAt: binding.revokedAt } : {}),
  };
}

function safeUpload(upload: ArtifactUploadRecord): Readonly<Record<string, unknown>> {
  return {
    id: upload.id,
    workspaceId: upload.workspaceId,
    projectId: upload.projectId,
    repository: upload.repository,
    commit: upload.commit,
    ref: upload.ref,
    status: upload.status,
    manifestHash: upload.manifestHash,
    createdAt: upload.createdAt,
    expiresAt: upload.expiresAt,
    finalizedAt: upload.finalizedAt,
    objects: upload.objects.map((object) => ({
      sha256: object.sha256,
      byteLength: object.byteLength,
      mediaType: object.mediaType,
      status: object.status,
    })),
  };
}

function safeAudit(
  audit: AuditEventRecord & { sequence: number },
): Readonly<Record<string, unknown>> {
  return {
    sequence: audit.sequence,
    id: audit.id,
    workspaceId: audit.workspaceId,
    actorId: audit.actorId,
    action: audit.action,
    targetType: audit.targetType,
    targetId: audit.targetId,
    requestId: audit.requestId,
    metadata: withoutSecrets(audit.metadata),
    createdAt: audit.createdAt,
  };
}

function assetIdentity(asset: { sha256: string; mediaType: string }): string {
  return `${asset.sha256}\0${asset.mediaType}`;
}

function exportAssetPath(sha: string, mediaType: string): string {
  return `assets/${sha}.${Buffer.from(mediaType, 'utf8').toString('base64url')}`;
}

interface ReferencedAssetPolicy {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly projectIds: Set<string>;
  readonly allowedReferences: Set<string>;
  readonly privacyExclusions: Set<string>;
  publicRelease: boolean;
}

function collectReferencedAssetPolicies(records: {
  readonly scenes: readonly Awaited<
    ReturnType<ControlPlaneRepository['listSceneRevisions']>
  >[number][];
  readonly runs: readonly Awaited<
    ReturnType<ControlPlaneRepository['listVerificationRuns']>
  >[number][];
  readonly baselines: readonly Awaited<
    ReturnType<ControlPlaneRepository['listVerificationBaselines']>
  >[number][];
  readonly releases: readonly Awaited<ReturnType<ControlPlaneRepository['listReleases']>>[number][];
}): Map<string, ReferencedAssetPolicy> {
  const policies = new Map<string, ReferencedAssetPolicy>();
  const reference = (
    asset: { sha256: string; byteLength: number; mediaType: string },
    projectId: string,
    source: string,
    privacyStatus: string | undefined,
    publicRelease = false,
  ): void => {
    const identity = assetIdentity(asset);
    const current = policies.get(identity);
    if (current && current.byteLength !== asset.byteLength) {
      throw new WorkspaceExportIntegrityError(identity);
    }
    const policy =
      current ??
      ({
        sha256: asset.sha256,
        byteLength: asset.byteLength,
        mediaType: asset.mediaType,
        projectIds: new Set<string>(),
        allowedReferences: new Set<string>(),
        privacyExclusions: new Set<string>(),
        publicRelease: false,
      } satisfies ReferencedAssetPolicy);
    policy.projectIds.add(projectId);
    if (publicRelease || privacyStatus === 'clear') policy.allowedReferences.add(source);
    else policy.privacyExclusions.add(`${source}:${privacyStatus ?? 'unknown'}`);
    if (publicRelease) policy.publicRelease = true;
    policies.set(identity, policy);
  };
  for (const revision of records.scenes) {
    for (const asset of revision.scene.assets) {
      reference(
        asset,
        revision.projectId,
        `scene:${revision.sceneId}:${revision.revision}:asset`,
        revision.privacy.status,
      );
    }
    for (const step of revision.scene.steps) {
      for (const [phase, state] of Object.entries(step.states)) {
        if (!state?.screenshot) continue;
        reference(
          state.screenshot,
          revision.projectId,
          `scene:${revision.sceneId}:${revision.revision}:state:${step.id}:${phase}`,
          revision.privacy.status,
        );
      }
    }
  }
  for (const baseline of records.baselines) {
    for (const state of baseline.baseline.states) {
      reference(
        state.screenshot,
        baseline.projectId,
        `baseline:${baseline.id}:state:${state.stateId}`,
        state.privacy.status,
      );
    }
  }
  for (const run of records.runs) {
    for (const attempt of run.run.attempts) {
      for (const state of attempt.states) {
        reference(
          state.screenshot,
          run.projectId,
          `run:${run.id}:attempt:${attempt.id}:state:${state.id}`,
          state.privacy.status,
        );
      }
      if (attempt.trace) {
        reference(
          attempt.trace,
          run.projectId,
          `run:${run.id}:attempt:${attempt.id}:trace`,
          attempt.privacy.status,
        );
      }
      for (const [index, attachment] of attempt.attachments.entries()) {
        reference(
          attachment,
          run.projectId,
          `run:${run.id}:attempt:${attempt.id}:attachment:${index}`,
          attempt.privacy.status,
        );
      }
    }
  }
  for (const release of records.releases) {
    for (const scene of release.release.scenes) {
      for (const output of scene.outputs) {
        reference(
          output.asset,
          release.projectId,
          `release:${release.release.id}:scene:${scene.sceneId}:output:${output.format}`,
          undefined,
          true,
        );
      }
    }
    const publication = release.release.publication;
    if (publication) {
      for (const [kind, object] of [
        ['archive', publication.archive],
        ['inventory', publication.inventory],
        ['compiler-manifest', publication.compilerManifest],
      ] as const) {
        reference(
          object,
          release.projectId,
          `release:${release.release.id}:publication:${kind}`,
          undefined,
          true,
        );
      }
    }
  }
  return policies;
}

async function allAudit(
  repository: ControlPlaneRepository,
  workspaceId: string,
  maximum: number,
  maxSerializedBytes: number,
): Promise<readonly (AuditEventRecord & { sequence: number })[]> {
  const values: (AuditEventRecord & { sequence: number })[] = [];
  let serializedBytes = 0;
  let after = 0;
  const pageLimit = Math.min(100, maximum + 1);
  while (values.length <= maximum) {
    const page = await repository.listAudit(workspaceId, after, pageLimit);
    for (const event of page) {
      serializedBytes += serializedJsonByteLength(safeAudit(event));
      if (serializedBytes > maxSerializedBytes) {
        throw new WorkspaceExportLimitError('metadata-bytes');
      }
    }
    values.push(...page);
    if (page.length < pageLimit) break;
    after = page.at(-1)!.sequence;
  }
  if (values.length > maximum) throw new WorkspaceExportLimitError('records');
  return values;
}

function assertBounded<T>(values: readonly T[], maximum: number): readonly T[] {
  if (values.length > maximum) throw new WorkspaceExportLimitError('records');
  return values;
}

const ZIP_INPUT_CHUNK_BYTES = 64 * 1024;
const ZIP_MAX_QUEUED_BYTES = 1024 * 1024;
const ZIP_MAX_ENTRIES = 65_535;

interface ZipMemberInput {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly object?: StoredObject;
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(`${stableStringify(value)}\n`);
}

function serializedJsonByteLength(value: unknown): number {
  return encoder.encode(stableStringify(value)).byteLength;
}

function exactZipByteLength(members: readonly ZipMemberInput[]): number {
  let total = 22;
  for (const member of members) {
    const payloadBytes = member.bytes?.byteLength ?? member.object?.byteLength;
    if (payloadBytes === undefined) {
      throw new Error(`Workspace export member has no source: ${member.path}`);
    }
    const pathBytes = encoder.encode(member.path).byteLength;
    total += payloadBytes + 92 + pathBytes * 2;
    if (!Number.isSafeInteger(total)) throw new WorkspaceExportLimitError('total-bytes');
  }
  return total;
}

async function* byteChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += ZIP_INPUT_CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + ZIP_INPUT_CHUNK_BYTES));
  }
}

function memberSource(
  member: ZipMemberInput,
  objectStore: ImmutableObjectStore,
): AsyncIterable<Uint8Array> {
  if (member.bytes) return byteChunks(member.bytes);
  if (!member.object) throw new Error(`Workspace export member has no source: ${member.path}`);
  const source = objectStore.readStream?.(member.object);
  if (!source) {
    throw new Error('Workspace export requires a streaming immutable object store');
  }
  return source;
}

export function createWorkspaceZipStream(
  members: readonly ZipMemberInput[],
  objectStore: ImmutableObjectStore,
): ReadableStream<Uint8Array> {
  let zip: Zip | undefined;
  let current:
    | {
        readonly file: ZipPassThrough;
        readonly source: AsyncIterator<Uint8Array>;
      }
    | undefined;
  let memberIndex = 0;
  let zipEnded = false;
  let zipFinal = false;
  let cancelled = false;
  let failure: unknown;
  let queuedBytes = 0;
  const queue: Uint8Array[] = [];

  const closeCurrent = async (): Promise<void> => {
    const source = current?.source;
    current = undefined;
    await source?.return?.().catch(() => undefined);
  };

  const initialize = (): void => {
    if (zip) return;
    zip = new Zip((error, chunk, final) => {
      if (cancelled) return;
      if (error) {
        failure = error;
        return;
      }
      if (chunk.byteLength > 0) {
        const stable = chunk.slice();
        queuedBytes += stable.byteLength;
        if (queuedBytes > ZIP_MAX_QUEUED_BYTES) {
          failure = new Error('Workspace ZIP encoder exceeded its bounded output queue');
          zip?.terminate();
          return;
        }
        queue.push(stable);
      }
      if (final) zipFinal = true;
    });
  };

  const advance = async (): Promise<void> => {
    initialize();
    if (failure || cancelled || zipFinal) return;
    if (current) {
      const next = await current.source.next();
      if (cancelled) return;
      if (next.done) {
        current.file.push(new Uint8Array(), true);
        current = undefined;
        return;
      }
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      if (chunk.byteLength > ZIP_MAX_QUEUED_BYTES) {
        throw new Error('Workspace export object source emitted an unbounded chunk');
      }
      current.file.push(chunk, false);
      return;
    }
    const member = members[memberIndex];
    if (member) {
      memberIndex += 1;
      const file = new ZipPassThrough(member.path);
      file.mtime = ZIP_EPOCH;
      file.os = 3;
      file.attrs = 0o100644 << 16;
      zip!.add(file);
      current = {
        file,
        source: memberSource(member, objectStore)[Symbol.asyncIterator](),
      };
      return;
    }
    if (!zipEnded) {
      zipEnded = true;
      zip!.end();
    }
  };

  const fillOne = async (): Promise<void> => {
    while (queue.length === 0 && !zipFinal && !failure && !cancelled) {
      try {
        await advance();
      } catch (error) {
        failure = error;
        zip?.terminate();
      }
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        await fillOne();
        if (failure) {
          await closeCurrent();
          controller.error(failure);
          return;
        }
        const chunk = queue.shift();
        if (chunk) {
          queuedBytes -= chunk.byteLength;
          controller.enqueue(chunk);
          return;
        }
        if (zipFinal) controller.close();
      },
      async cancel() {
        cancelled = true;
        queue.length = 0;
        queuedBytes = 0;
        zip?.terminate();
        await closeCurrent();
      },
    },
    { highWaterMark: 1, size: () => 1 },
  );
}

export async function prepareWorkspaceExport(
  options: WorkspaceExportOptions,
): Promise<PreparedWorkspaceExport> {
  const workspace = await options.repository.getWorkspace(options.workspaceId);
  if (!workspace) throw new Error('Workspace not found');
  const initialAudit = await allAudit(
    options.repository,
    options.workspaceId,
    options.maxRecords,
    options.maxMetadataBytes,
  );
  let materializedRecordBytes = 0;
  const reserveRecordBytes = (value: unknown): void => {
    materializedRecordBytes += serializedJsonByteLength(value);
    if (materializedRecordBytes > options.maxMetadataBytes) {
      throw new WorkspaceExportLimitError('metadata-bytes');
    }
  };
  reserveRecordBytes(workspace);
  reserveRecordBytes(initialAudit.map(safeAudit));
  let remaining = options.maxRecords - initialAudit.length;
  const take = <T>(values: readonly T[]): readonly T[] => {
    assertBounded(values, remaining);
    remaining -= values.length;
    return values;
  };
  const projects = take(
    await options.repository.listProjects(
      options.workspaceId,
      Math.min(remaining + 1, options.maxRecords + 1),
    ),
  );
  const memberships = take(
    await options.repository.listWorkspaceMemberships(
      options.workspaceId,
      Math.min(remaining + 1, options.maxRecords + 1),
    ),
  );
  const users = [];
  for (const membership of memberships) {
    const user = await options.repository.getUser(membership.userId);
    if (user) users.push(...take([user]));
  }
  reserveRecordBytes({ users, memberships });
  const projectRecords: Record<string, unknown>[] = [];
  const allSceneRevisions: Awaited<
    ReturnType<ControlPlaneRepository['listSceneRevisions']>
  >[number][] = [];
  const allRuns: Awaited<ReturnType<ControlPlaneRepository['listVerificationRuns']>>[number][] = [];
  const allBaselines: Awaited<
    ReturnType<ControlPlaneRepository['listVerificationBaselines']>
  >[number][] = [];
  const allReleases: Awaited<ReturnType<ControlPlaneRepository['listReleases']>>[number][] = [];

  for (const project of projects) {
    const limit = (): number => Math.min(remaining + 1, options.maxRecords + 1);
    const heads = take(
      await options.repository.listSceneHeads(options.workspaceId, project.id, limit()),
    );
    const revisions = [];
    for (const head of heads) {
      revisions.push(
        ...take(
          await options.repository.listSceneRevisions(
            options.workspaceId,
            project.id,
            head.sceneId,
            limit(),
          ),
        ),
      );
    }
    const reviews = take(
      await options.repository.listReviews(options.workspaceId, project.id, limit()),
    );
    const runs = take(
      await options.repository.listVerificationRuns(options.workspaceId, project.id, limit()),
    );
    const builds = take(
      await options.repository.listVerificationBuilds(options.workspaceId, project.id, limit()),
    );
    const baselines = take(
      await options.repository.listVerificationBaselines(options.workspaceId, project.id, limit()),
    );
    const approvals = take(
      await options.repository.listReviewApprovals(options.workspaceId, project.id, limit()),
    );
    const repositories = take(
      await options.repository.listRepositoryBindings(options.workspaceId, project.id, limit()),
    );
    const githubInstallationBindings = take(
      await options.repository.listGitHubInstallationBindings(
        options.workspaceId,
        project.id,
        limit(),
      ),
    );
    const schedules = take(
      await options.repository.listVerificationSchedules(options.workspaceId, project.id, limit()),
    );
    const jobs = take(
      await options.repository.listVerificationJobs(
        options.workspaceId,
        project.id,
        undefined,
        limit(),
      ),
    );
    const runners = take(
      await options.repository.listVerificationRunners(options.workspaceId, project.id, limit()),
    );
    const channels = take(
      await options.repository.listChannels(options.workspaceId, project.id, limit()),
    );
    const releases = [];
    const domains = [];
    const grants = [];
    const shareLinks: Record<string, unknown>[] = [];
    for (const channel of channels) {
      releases.push(
        ...take(
          await options.repository.listReleases(
            options.workspaceId,
            project.id,
            channel.id,
            limit(),
          ),
        ),
      );
      domains.push(
        ...take(
          await options.repository.listCustomDomains(
            options.workspaceId,
            project.id,
            channel.id,
            limit(),
          ),
        ),
      );
      const channelGrants = take(
        await options.repository.listPortalGrants(
          options.workspaceId,
          project.id,
          channel.id,
          limit(),
        ),
      );
      grants.push(...channelGrants);
      for (const grant of channelGrants) {
        const links = take(await options.repository.listPrivateShareLinks(grant.id, limit()));
        shareLinks.push(
          ...links.map((link) => ({
            id: link.id,
            grantId: link.grantId,
            createdBy: link.createdBy,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
            revokedAt: link.revokedAt,
          })),
        );
      }
    }
    allRuns.push(...runs);
    allBaselines.push(...baselines);
    allReleases.push(...releases);
    allSceneRevisions.push(...revisions);
    const projectRecord = {
      project,
      repositoryBindings: repositories,
      githubInstallationBindings: githubInstallationBindings.map(safeGitHubInstallationBinding),
      verification: {
        schedules,
        jobs: jobs.map(safeJob),
        runners: runners.map(safeRunner),
      },
      scenes: { revisions },
      reviews,
      evidence: { runs, builds, baselines, approvals },
      publication: {
        channels: channels.map(safeChannel),
        releases,
        customDomains: domains.map(safeDomain),
        portalGrants: grants,
        privateShareLinks: shareLinks,
      },
    };
    reserveRecordBytes(projectRecord);
    projectRecords.push(projectRecord);
  }

  const finalizedUploads = take(
    await options.repository.listWorkspaceFinalizedUploads(
      options.workspaceId,
      Math.min(remaining + 1, options.maxRecords + 1),
    ),
  );
  reserveRecordBytes(finalizedUploads.map(safeUpload));

  const inventory = await options.repository.listWorkspaceArtifactInventory(
    options.workspaceId,
    options.maxAssets + 1,
  );
  if (inventory.length > options.maxAssets) throw new WorkspaceExportLimitError('assets');
  reserveRecordBytes(inventory);
  const latestAudit = await allAudit(
    options.repository,
    options.workspaceId,
    options.maxRecords,
    options.maxMetadataBytes,
  );
  if (
    initialAudit.length !== latestAudit.length ||
    initialAudit.at(-1)?.sequence !== latestAudit.at(-1)?.sequence
  ) {
    throw new WorkspaceExportLimitError('concurrent-change');
  }
  const referenced = collectReferencedAssetPolicies({
    scenes: allSceneRevisions,
    runs: allRuns,
    baselines: allBaselines,
    releases: allReleases,
  });
  const grouped = new Map<
    string,
    {
      sample?: WorkspaceArtifactInventoryRecord;
      projectIds: Set<string>;
      uploadIds: Set<string>;
    }
  >();
  for (const item of inventory) {
    const key = assetIdentity(item);
    const value = grouped.get(key) ?? {
      sample: item,
      projectIds: new Set<string>(),
      uploadIds: new Set<string>(),
    };
    if (value.sample && value.sample.byteLength !== item.byteLength) {
      throw new WorkspaceExportIntegrityError(key);
    }
    value.projectIds.add(item.projectId);
    value.uploadIds.add(item.uploadId);
    grouped.set(key, value);
  }
  for (const [identity, policy] of referenced) {
    const value = grouped.get(identity) ?? {
      projectIds: new Set<string>(),
      uploadIds: new Set<string>(),
    };
    for (const projectId of policy.projectIds) value.projectIds.add(projectId);
    grouped.set(identity, value);
  }
  if (grouped.size > options.maxAssets) throw new WorkspaceExportLimitError('assets');
  const assets: ExportAsset[] = [];
  let includedBytes = 0;
  for (const [identity, value] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const policy = referenced.get(identity);
    const item = value.sample ?? policy;
    if (!item) throw new WorkspaceExportIntegrityError(identity);
    const allowed = Boolean(
      policy &&
      (policy.publicRelease ||
        (policy.allowedReferences.size > 0 && policy.privacyExclusions.size === 0)),
    );
    const referencedBy = policy
      ? [...policy.allowedReferences, ...policy.privacyExclusions].sort()
      : [];
    const privacyExclusions = policy ? [...policy.privacyExclusions].sort() : [];
    const requiredForRestore = Boolean(policy);
    const common = {
      path: exportAssetPath(item.sha256, item.mediaType),
      sha256: item.sha256,
      byteLength: item.byteLength,
      mediaType: item.mediaType,
      projectIds: [...value.projectIds].sort(),
      uploadIds: [...value.uploadIds].sort(),
      referencedBy,
      privacyExclusions,
      requiredForRestore,
    };
    if (!policy) {
      assets.push({
        ...common,
        disposition: 'withheld',
        reason: 'no exported immutable record supplies a privacy classification for this object',
      });
      continue;
    }
    if (!allowed) {
      assets.push({
        ...common,
        disposition: 'withheld',
        reason: 'referenced object is excluded by the immutable record privacy policy',
      });
      continue;
    }
    if (!value.sample) throw new WorkspaceExportIntegrityError(identity);
    if (value.sample.byteLength !== policy.byteLength) {
      throw new WorkspaceExportIntegrityError(identity);
    }
    if (value.sample.lifecycleStatus !== 'active') {
      assets.push({
        ...common,
        disposition: 'unavailable',
        reason: `object lifecycle is ${value.sample.lifecycleStatus}`,
      });
      throw new WorkspaceExportIntegrityError(identity);
    }
    let object: StoredObject | undefined;
    for (const projectId of common.projectIds) {
      object = await options.repository.getFinalizedObject(
        options.workspaceId,
        projectId,
        item.sha256,
        item.mediaType,
      );
      if (object) break;
    }
    if (!object || !(await options.objectStore.verify(object))) {
      assets.push({
        ...common,
        disposition: 'unavailable',
        reason: 'finalized object is missing or failed integrity verification',
      });
      throw new WorkspaceExportIntegrityError(identity);
    }
    includedBytes += object.byteLength;
    if (includedBytes > options.maxAssetBytes) throw new WorkspaceExportLimitError('bytes');
    assets.push({
      ...common,
      disposition: 'included',
      reason: policy.publicRelease
        ? 'required by an immutable published Release'
        : 'referenced by privacy-clear immutable workspace records',
      object,
    });
  }

  const records = {
    schemaVersion: 1,
    workspace,
    identity: { users, memberships },
    projects: projectRecords,
    artifactUploads: finalizedUploads.map(safeUpload),
    artifactInventory: inventory,
    audit: latestAudit.map(safeAudit),
    exclusions: {
      identityCredentials: 'excluded',
      apiTokens: 'excluded',
      sessions: 'excluded',
      runnerTokenHashes: 'excluded',
      analyticsIdentifiers: 'excluded',
      ctaPayloads: 'excluded',
      webhookSecrets: 'excluded',
    },
  };
  const recordsBytes = encodeJson(records);
  const recordMember: ExportMember = {
    path: 'workspace.json',
    sha256: sha256(recordsBytes),
    byteLength: recordsBytes.byteLength,
    mediaType: 'application/json',
  };
  const assetMembers: ExportMember[] = assets
    .filter((asset) => asset.disposition === 'included')
    .map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      mediaType: asset.mediaType,
    }));
  if (assetMembers.length > 0 && !options.objectStore.readStream) {
    throw new WorkspaceExportIntegrityError('object-store-streaming-capability');
  }
  const inventoryValue = assets.map(({ object: _object, ...asset }) => asset);
  const referencedAssets = assets.filter((asset) => asset.requiredForRestore);
  const includedReferencedAssets = referencedAssets.filter(
    (asset) => asset.disposition === 'included',
  );
  const missingReferences = referencedAssets
    .filter((asset) => asset.disposition !== 'included')
    .map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      mediaType: asset.mediaType,
      projectIds: asset.projectIds,
      uploadIds: asset.uploadIds,
      referencedBy: asset.referencedBy,
      reason: asset.reason,
    }));
  const restorable = missingReferences.length === 0;
  const restoration = {
    schemaVersion: 1,
    kind: 'scenebook-workspace-restoration-plan',
    workspaceId: workspace.id,
    recordsMember: recordMember.path,
    restorable,
    objects: includedReferencedAssets.map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      mediaType: asset.mediaType,
      projectIds: asset.projectIds,
      uploadIds: asset.uploadIds,
      referencedBy: asset.referencedBy,
    })),
    missingReferences,
    privacyExclusions: missingReferences,
  };
  const restorationBytes = encodeJson(restoration);
  const restorationMember: ExportMember = {
    path: 'restoration.json',
    sha256: sha256(restorationBytes),
    byteLength: restorationBytes.byteLength,
    mediaType: 'application/json',
  };
  const manifestBase = {
    schemaVersion: 1,
    kind: 'scenebook-workspace-export',
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    createdAt: options.createdAt,
    integrity: {
      algorithm: 'sha256',
      recordsHash: recordMember.sha256,
      restorationHash: restorationMember.sha256,
      assetInventoryHash: sha256(stableStringify(inventoryValue)),
    },
    restoration: {
      member: restorationMember.path,
      restorable,
      requiredObjectCount: referencedAssets.length,
      includedObjectCount: includedReferencedAssets.length,
      missingObjectCount: missingReferences.length,
      privacyExclusionCount: missingReferences.length,
    },
    members: [recordMember, restorationMember, ...assetMembers],
    assets: inventoryValue,
  };
  const manifest = {
    ...manifestBase,
    manifestHash: sha256(stableStringify(manifestBase)),
  };
  const manifestBytes = encodeJson(manifest);
  const metadataBytes =
    manifestBytes.byteLength + recordsBytes.byteLength + restorationBytes.byteLength;
  if (metadataBytes > options.maxMetadataBytes) {
    throw new WorkspaceExportLimitError('metadata-bytes');
  }
  const members: ZipMemberInput[] = [
    { path: 'manifest.json', bytes: manifestBytes },
    { path: recordMember.path, bytes: recordsBytes },
    { path: restorationMember.path, bytes: restorationBytes },
    ...assets
      .filter((asset): asset is ExportAsset & { object: StoredObject } =>
        Boolean(asset.disposition === 'included' && asset.object),
      )
      .map((asset) => ({ path: asset.path, object: asset.object })),
  ];
  if (members.length > ZIP_MAX_ENTRIES) throw new WorkspaceExportLimitError('assets');
  if (exactZipByteLength(members) > options.maxTotalBytes) {
    throw new WorkspaceExportLimitError('total-bytes');
  }
  return {
    filename: `${workspace.slug}-scenebook-export-${options.createdAt.slice(0, 10)}.zip`,
    manifest,
    body: createWorkspaceZipStream(members, options.objectStore),
  };
}
