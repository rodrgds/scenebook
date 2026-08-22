import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { artifactHash, canonicalJsonHash, sha256, stableStringify } from '@scenebook/core';
import { createPublicationGatewayApp, PortalSessionService } from '@scenebook/gateway';
import {
  BaselineSchema,
  BuildArtifactSchema,
  ReviewSchema,
  RunArtifactSchema,
} from '@scenebook/schema';
import {
  HmacHasher,
  IdentityTokenService,
  IdentityTokenVerifier,
  PostgresControlPlaneRepository,
  RunnerTokenService,
  S3ObjectStore,
  SecretBox,
  UploadTokenService,
  WebhookDispatcher,
  createControlPlaneApp,
  createJsonLogger,
  immutableObjectKey,
  runMigrations,
  type GitHubOidcClaims,
  type GitHubSourceChangeRecord,
  type GitHubOidcVerifier,
  type CustomDomainRecord,
} from '@scenebook/server';
import { describe, expect, it } from 'vitest';

import { writeReporterArtifactFixture } from './support/reporter-artifacts.js';

const gatewayIdentityKeyPair = generateKeyPairSync('ed25519');
const GATEWAY_IDENTITY_PUBLIC_KEY = gatewayIdentityKeyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
import { finalizePublicationFixture } from './support/publication.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required. Run this explicit integration target against disposable PostgreSQL and MinIO services.`,
    );
  }
  return value;
}

if (process.env.SCENEBOOK_BACKEND_INTEGRATION !== '1') {
  throw new Error(
    'SCENEBOOK_BACKEND_INTEGRATION=1 is required; backend integration tests never silently skip.',
  );
}

const POSTGRES_ADMIN_URL = requiredEnvironment('SCENEBOOK_TEST_POSTGRES_ADMIN_URL');
const MINIO_ENDPOINT = requiredEnvironment('SCENEBOOK_TEST_MINIO_ENDPOINT');
const MINIO_ACCESS_KEY_ID = requiredEnvironment('SCENEBOOK_TEST_MINIO_ACCESS_KEY_ID');
const MINIO_SECRET_ACCESS_KEY = requiredEnvironment('SCENEBOOK_TEST_MINIO_SECRET_ACCESS_KEY');
const MINIO_BUCKET = requiredEnvironment('SCENEBOOK_TEST_MINIO_BUCKET');
const NOW = new Date('2026-07-20T12:00:00.000Z');
const ADMIN_TOKEN = 'backend-integration-admin-'.padEnd(64, 'a');
const SERVER_SECRET = 'backend-integration-secret-'.padEnd(64, 's');
const IDENTITY_SECRET = 'backend-integration-identity-secret-'.padEnd(64, 'i');
const RUNNER_SECRET = 'backend-integration-runner-secret-'.padEnd(64, 'r');
const ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64url');
const REPOSITORY = 'acme/product';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const WORKFLOW_REF = 'acme/product/.github/workflows/publish.yml@refs/heads/main';

const oidcClaims: GitHubOidcClaims = {
  repository: REPOSITORY,
  commit: COMMIT_A,
  ref: 'refs/heads/main',
  workflowRef: WORKFLOW_REF,
  actor: 'integration',
  runId: 'backend-integration',
  tokenId: 'backend-integration-oidc',
};

class StaticOidcVerifier implements GitHubOidcVerifier {
  async verify(): Promise<GitHubOidcClaims> {
    return oidcClaims;
  }
}

function databaseUrl(name: string): string {
  const url = new URL(POSTGRES_ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]+$/u.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `"${value}"`;
}

function admin(body: unknown, idempotencyKey?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  };
}

function clearPrivacy() {
  return {
    status: 'clear' as const,
    scannedAt: NOW.toISOString(),
    scannerVersion: 'backend-integration',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  };
}

async function expectStatus(response: Response, status: number): Promise<void> {
  const body = await response.clone().text();
  expect(response.status, body).toBe(status);
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: MINIO_ACCESS_KEY_ID,
      secretAccessKey: MINIO_SECRET_ACCESS_KEY,
    },
  });
}

function objectStore(): S3ObjectStore {
  return new S3ObjectStore({
    bucket: MINIO_BUCKET,
    endpoint: MINIO_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    accessKeyId: MINIO_ACCESS_KEY_ID,
    secretAccessKey: MINIO_SECRET_ACCESS_KEY,
  });
}

async function proveImmutableObjectContract(store: S3ObjectStore): Promise<void> {
  const nonce = randomUUID();
  const workspaceId = `media-${nonce}`;
  const bytes = new TextEncoder().encode(JSON.stringify({ nonce }));
  const digest = sha256(bytes);
  const [jsonStaged, plainStaged] = await Promise.all([
    store.putStaged(`media-json-${nonce}`, digest, bytes, 'application/json'),
    store.putStaged(`media-plain-${nonce}`, digest, bytes, 'text/plain'),
  ]);
  const [json, plain] = await Promise.all([
    store.promote(jsonStaged, workspaceId),
    store.promote(plainStaged, workspaceId),
  ]);
  expect(json.key).toBe(immutableObjectKey(workspaceId, digest, 'application/json'));
  expect(plain.key).toBe(immutableObjectKey(workspaceId, digest, 'text/plain'));
  expect(json.key).not.toBe(plain.key);
  await expect(store.read(json)).resolves.toEqual(bytes);
  await expect(store.read(plain)).resolves.toEqual(bytes);

  const restrictedClient = s3Client();
  try {
    await expect(
      restrictedClient.send(
        new PutObjectCommand({
          Bucket: MINIO_BUCKET,
          Key: immutableObjectKey(`direct-${nonce}`, digest, 'text/plain'),
          Body: bytes,
          ContentType: 'text/plain',
          Metadata: { sha256: digest },
        }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  } finally {
    restrictedClient.destroy();
  }

  const concurrentBytes = new TextEncoder().encode(`concurrent object ${nonce}`);
  const concurrentHash = sha256(concurrentBytes);
  const staged = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.putStaged(
        `concurrent-${index}-${nonce}`,
        concurrentHash,
        concurrentBytes,
        'text/plain',
      ),
    ),
  );
  const promoted = await Promise.all(
    staged.map((candidate) => store.promote(candidate, workspaceId)),
  );
  expect(new Set(promoted.map((candidate) => candidate.key))).toEqual(
    new Set([immutableObjectKey(workspaceId, concurrentHash, 'text/plain')]),
  );
  await expect(store.read(promoted[0]!)).resolves.toEqual(concurrentBytes);
  await Promise.all(
    [...staged, jsonStaged, plainStaged].map((candidate) => store.deleteStaged(candidate)),
  );
}

async function proveGitHubCoordinationContract(
  repository: PostgresControlPlaneRepository,
): Promise<void> {
  const projectId = 'project-github-coordination';
  const repositoryBindingId = 'repository-github-coordination';
  const installationBindingId = 'installation-github-coordination';
  const changeId = 'change-github-coordination';
  await repository.createProject({
    id: projectId,
    workspaceId: 'workspace-1',
    slug: projectId,
    name: 'GitHub coordination',
    now: NOW.toISOString(),
  });
  await repository.bindRepository({
    id: repositoryBindingId,
    workspaceId: 'workspace-1',
    projectId,
    repository: 'acme/coordination',
    workflowRefPattern: '*',
    createdAt: NOW.toISOString(),
  });
  await repository.putGitHubInstallationBinding({
    id: installationBindingId,
    workspaceId: 'workspace-1',
    projectId,
    repositoryBindingId,
    installationId: '123456',
    githubRepositoryId: '987654',
    defaultBranch: 'main',
    createdBy: 'integration',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
  });

  let activeLocks = 0;
  let maximumActiveLocks = 0;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      repository.withGitHubCheckRunLock(
        `${installationBindingId}\0acme/coordination\0${COMMIT_A}\0build`,
        async () => {
          activeLocks += 1;
          maximumActiveLocks = Math.max(maximumActiveLocks, activeLocks);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeLocks -= 1;
        },
      ),
    ),
  );
  expect(maximumActiveLocks).toBe(1);

  const record: GitHubSourceChangeRecord = {
    id: changeId,
    workspaceId: 'workspace-1',
    projectId,
    installationBindingId,
    idempotencyKey: changeId,
    requestHash: '1'.repeat(64),
    status: 'pending',
    path: 'scenes/invite/scene.yaml',
    baseCommitSha: COMMIT_A,
    baseBlobSha: '2'.repeat(40),
    patchHash: '3'.repeat(64),
    branch: `scenebook/${changeId}`,
    title: 'Verify concurrent claim',
    createReviewIssue: false,
    evidenceBinding: {},
    createdBy: 'integration',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    attempts: 0,
  };
  const claims = await Promise.all([
    repository.claimGitHubSourceChange({
      record,
      leaseId: 'github-coordination-lease-a',
      leaseDurationMs: 5_000,
    }),
    repository.claimGitHubSourceChange({
      record,
      leaseId: 'github-coordination-lease-b',
      leaseDurationMs: 5_000,
    }),
  ]);
  expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
}

async function bootstrap(app: ReturnType<typeof createControlPlaneApp>): Promise<string> {
  await expectStatus(
    await app.request(
      '/v1/admin/workspaces',
      admin({ id: 'workspace-1', slug: 'acme', name: 'Acme' }),
    ),
    201,
  );
  await expectStatus(
    await app.request(
      '/v1/admin/workspaces/workspace-1/projects',
      admin({ id: 'project-1', slug: 'product', name: 'Product' }),
    ),
    201,
  );
  await expectStatus(
    await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/repositories',
      admin({ repository: REPOSITORY, workflowRefPattern: '*' }),
    ),
    201,
  );
  const channel = await app.request(
    '/v1/admin/workspaces/workspace-1/projects/project-1/channels',
    admin({
      id: 'channel-1',
      slug: 'production',
      name: 'Production',
      kind: 'public-catalog',
      webhookIds: [],
      policy: {
        requireCriticalPassing: true,
        requireVisualApproval: true,
        requireEditorialApproval: true,
        requireCompleteLocalization: false,
        publication: 'manual',
        nonCriticalFailure: 'block',
      },
    }),
  );
  await expectStatus(channel, 201);
  return ((await channel.json()) as { analyticsToken: string }).analyticsToken;
}

async function proveHostedStudioContract(
  app: ReturnType<typeof createControlPlaneApp>,
  repository: PostgresControlPlaneRepository,
): Promise<void> {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwO0GQAAAABJRU5ErkJggg==',
    'base64',
  );
  const digest = sha256(bytes);
  const base = '/v1/admin/workspaces/workspace-1/projects/project-1/studio';
  const uploaded = await app.request(`${base}/assets/${digest}?byteLength=${bytes.byteLength}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'image/png',
      'idempotency-key': 'hosted-studio-integration-image',
    },
    body: bytes,
  });
  await expectStatus(uploaded, 200);
  const document = (revision: number) => ({
    id: 'hosted-studio-scene',
    scene: {
      id: 'hosted-studio-scene',
      version: 1,
      title: revision === 1 ? 'Hosted Studio scene' : 'Hosted Studio scene updated',
      steps: [],
    },
    savedAt: NOW.getTime() + revision,
    revision,
    storageVersion: 4,
    payloadRefs: [
      {
        slot: 'step-image',
        key: 'step-1',
        sha256: digest,
        mediaType: 'image/png',
        byteLength: bytes.byteLength,
        representation: 'binary-data-uri',
      },
    ],
  });
  await expectStatus(
    await app.request(`${base}/scenes`, {
      ...admin({ writes: [{ expectedRevision: 0, record: document(1) }] }),
      method: 'PUT',
    }),
    200,
  );
  await expectStatus(
    await app.request(`${base}/scenes`, {
      ...admin({ writes: [{ expectedRevision: 1, record: document(2) }] }),
      method: 'PUT',
    }),
    200,
  );
  await expectStatus(
    await app.request(`${base}/scenes`, {
      ...admin({ writes: [{ expectedRevision: 0, record: document(1) }] }),
      method: 'PUT',
    }),
    409,
  );
  const versions = await app.request(`${base}/scenes/hosted-studio-scene/versions`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  await expectStatus(versions, 200);
  expect(
    ((await versions.json()) as { records: Array<{ revision: number }> }).records.map(
      (record) => record.revision,
    ),
  ).toEqual([2, 1]);
  const asset = await app.request(`${base}/assets/${digest}?mediaType=image%2Fpng`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  await expectStatus(asset, 200);
  expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array(bytes));
  expect(
    (
      await repository.pool.query<{ versions: string; heads: string }>(
        `SELECT
           (SELECT count(*)::text FROM studio_scene_versions) AS versions,
           (SELECT count(*)::text FROM studio_scene_documents) AS heads`,
      )
    ).rows[0],
  ).toEqual({ versions: '2', heads: '1' });
}

async function proveCustomDomainRepositoryContract(
  repository: PostgresControlPlaneRepository,
): Promise<void> {
  await repository.createChannel({
    id: 'channel-domain-secondary',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    slug: 'domain-secondary',
    name: 'Domain secondary',
    kind: 'public-catalog',
    policy: {
      requireCriticalPassing: true,
      requireVisualApproval: true,
      requireEditorialApproval: true,
      requireCompleteLocalization: false,
      publication: 'manual',
      nonCriticalFailure: 'block',
    },
    webhookIds: [],
    analyticsTokenHash: 'd'.repeat(64),
    now: NOW.toISOString(),
  });
  const initial: CustomDomainRecord = {
    id: 'domain-postgres',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    channelId: 'channel-1',
    hostname: 'stories.acme.com',
    routingTarget: 'customers.scenebook.cloud',
    status: 'pending-dns',
    dnsProof: {
      status: 'pending',
      challengeName: '_scenebook-challenge.stories.acme.com',
      challengeValue: 'scenebook-verification=postgres-contract',
    },
    version: 1,
    createdBy: 'admin',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  await expect(repository.createCustomDomain(initial)).resolves.toEqual(initial);
  await expect(
    repository.getCustomDomain('workspace-1', 'project-1', 'channel-1', initial.id),
  ).resolves.toEqual(initial);
  await expect(
    repository.listCustomDomains('workspace-1', 'project-1', 'channel-1', 10),
  ).resolves.toEqual([initial]);

  await expect(
    repository.createCustomDomain({
      ...initial,
      id: 'domain-channel-conflict',
      hostname: 'other.acme.com',
    }),
  ).rejects.toMatchObject({ code: '23505' });
  const competing: CustomDomainRecord = {
    ...initial,
    id: 'domain-host-conflict',
    channelId: 'channel-domain-secondary',
  };
  await expect(repository.createCustomDomain(competing)).resolves.toEqual(competing);

  const verified: CustomDomainRecord = {
    ...initial,
    status: 'ready-to-provision',
    dnsProof: {
      ...initial.dnsProof,
      status: 'verified',
      checkedAt: NOW.toISOString(),
      verifiedAt: NOW.toISOString(),
    },
    version: 2,
  };
  await expect(
    repository.updateCustomDomain({ record: verified, expectedVersion: 1 }),
  ).resolves.toEqual(verified);
  await expect(
    repository.updateCustomDomain({
      record: {
        ...competing,
        status: 'ready-to-provision',
        dnsProof: verified.dnsProof,
        version: 2,
      },
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: '23505' });
  await expect(
    repository.updateCustomDomain({ record: verified, expectedVersion: 1 }),
  ).rejects.toThrow('Custom domain changed');
  await expect(
    repository.updateCustomDomain({
      record: { ...verified, hostname: 'mutated.acme.com', version: 3 },
      expectedVersion: 2,
    }),
  ).rejects.toThrow('immutable identity changed');

  const active: CustomDomainRecord = {
    ...verified,
    status: 'active',
    provisioning: {
      operationKey: 'operation-active',
      operationId: 'provider-active',
      desiredState: 'active',
      certificate: 'ready',
      routing: 'ready',
      requestedAt: NOW.toISOString(),
      observedAt: NOW.toISOString(),
    },
    version: 3,
  };
  await repository.updateCustomDomain({ record: active, expectedVersion: 2 });
  await expect(
    repository.getActiveCustomDomainByHostname('STORIES.ACME.COM.'),
  ).resolves.toMatchObject({ id: initial.id, channelId: 'channel-1', status: 'active' });

  const removing: CustomDomainRecord = {
    ...active,
    status: 'removing',
    provisioning: {
      operationKey: 'operation-remove',
      operationId: 'provider-remove',
      desiredState: 'removed',
      certificate: 'pending',
      routing: 'pending',
      requestedAt: NOW.toISOString(),
      observedAt: NOW.toISOString(),
    },
    version: 4,
  };
  await repository.updateCustomDomain({ record: removing, expectedVersion: 3 });
  const removed: CustomDomainRecord = {
    ...removing,
    status: 'removed',
    provisioning: {
      ...removing.provisioning!,
      certificate: 'removed',
      routing: 'removed',
    },
    version: 5,
    removedAt: NOW.toISOString(),
  };
  await repository.updateCustomDomain({ record: removed, expectedVersion: 4 });
  await expect(
    repository.getActiveCustomDomainByHostname(initial.hostname),
  ).resolves.toBeUndefined();
  await expect(
    repository.createCustomDomain({ ...initial, id: 'domain-postgres-reclaimed' }),
  ).resolves.toMatchObject({ id: 'domain-postgres-reclaimed', hostname: initial.hostname });
}

describe('real PostgreSQL and MinIO release backend', () => {
  it('migrates a fresh database and promotes actual reporter evidence with exact provenance', async () => {
    const databaseName = `scenebook_it_${randomUUID().replaceAll('-', '')}`;
    const adminRepository = new PostgresControlPlaneRepository(POSTGRES_ADMIN_URL);
    let repository: PostgresControlPlaneRepository | undefined;
    const reporterRoot = await mkdtemp(join(tmpdir(), 'scenebook-backend-integration-'));
    try {
      await adminRepository.pool.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
      repository = new PostgresControlPlaneRepository(databaseUrl(databaseName));

      const expectedMigrations = (
        await readdir(fileURLToPath(new URL('../../server/migrations/', import.meta.url)))
      )
        .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
        .sort();
      const applied = await runMigrations(repository.pool);
      expect(applied.map((migration) => migration.name)).toEqual(expectedMigrations);
      await expect(runMigrations(repository.pool)).resolves.toEqual([]);
      const persistedMigrations = await repository.pool.query(
        'SELECT name FROM schema_migrations ORDER BY name',
      );
      expect(persistedMigrations.rows.map((row) => row.name)).toEqual(expectedMigrations);

      await repository.createWorkspace({
        id: 'workspace-1',
        slug: 'acme',
        name: 'Acme',
        now: NOW.toISOString(),
      });
      await repository.createProject({
        id: 'project-1',
        workspaceId: 'workspace-1',
        slug: 'product',
        name: 'Product',
        now: NOW.toISOString(),
      });
      await proveGitHubCoordinationContract(repository);
      const review = ReviewSchema.parse({
        schemaVersion: 1,
        artifactVersion: 1,
        id: 'review-passed',
        projectId: 'project-1',
        kind: 'review',
        createdAt: NOW.toISOString(),
        producer: { name: 'backend-integration', version: '1.0.0' },
        subject: { kind: 'run', id: 'run-review-subject', revision: 'c'.repeat(64) },
        status: 'approved',
        changeState: 'passed',
        decisions: [
          {
            id: 'review-passed-decision',
            actorId: 'admin',
            decision: 'approve',
            createdAt: NOW.toISOString(),
          },
        ],
        openedAt: NOW.toISOString(),
        closedAt: NOW.toISOString(),
      });
      await repository.createReview('workspace-1', 'project-1', review);
      expect(await repository.getReview('workspace-1', 'project-1', review.id)).toEqual({
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        review,
      });
      expect(
        (
          await repository.pool.query('SELECT status,change_state FROM reviews WHERE id=$1', [
            review.id,
          ])
        ).rows[0],
      ).toEqual({ status: 'approved', change_state: 'passed' });

      const store = objectStore();
      await store.health();
      await proveImmutableObjectContract(store);
      const uploadTokens = new UploadTokenService(SERVER_SECRET);
      const app = createControlPlaneApp({
        repository,
        objectStore: store,
        oidcVerifier: new StaticOidcVerifier(),
        uploadTokens,
        identityTokens: new IdentityTokenService(IDENTITY_SECRET),
        runnerTokens: new RunnerTokenService(RUNNER_SECRET),
        hasher: new HmacHasher(SERVER_SECRET),
        secretBox: new SecretBox(ENCRYPTION_KEY),
        webhooks: new WebhookDispatcher([]),
        logger: createJsonLogger('error', () => undefined),
        adminToken: ADMIN_TOKEN,
        publicBaseUrl: 'https://scenebook.example.com',
        publicationBaseUrl: 'https://publish.scenebook.example.com',
        identity: {
          sessionTtlSeconds: 28_800,
          apiTokenMaxTtlSeconds: 7_776_000,
          shareLinkMaxTtlSeconds: 604_800,
        },
        maxJsonBytes: 512 * 1024,
        maxObjectBytes: 4 * 1024 * 1024,
        uploadLimits: {
          maxObjectsPerUpload: 100,
          maxBytesPerUpload: 4 * 1024 * 1024,
          maxActiveUploadsPerTenant: 20,
          maxActiveUploadsGlobal: 100,
          maxActiveBytesPerTenant: 16 * 1024 * 1024,
          maxActiveBytesGlobal: 64 * 1024 * 1024,
          maxConcurrentObjectsPerTenant: 4,
          maxConcurrentObjectsGlobal: 16,
          maxConcurrentBytesPerTenant: 4 * 1024 * 1024,
          maxConcurrentBytesGlobal: 16 * 1024 * 1024,
          gcIntervalMs: 60_000,
          gcBatchSize: 100,
          gcClaimTtlSeconds: 300,
        },
        uploadTokenTtlSeconds: 300,
        runnerLeaseSeconds: 120,
        rateLimit: { requests: 1_000, aggregateRequests: 10_000, windowMs: 60_000 },
        now: () => new Date(NOW),
        id: (prefix) => `${prefix}-${randomUUID()}`,
      });
      const analyticsToken = await bootstrap(app);
      await proveHostedStudioContract(app, repository);
      await proveCustomDomainRepositoryContract(repository);

      const { scene, run, build } = await writeReporterArtifactFixture({
        root: reporterRoot,
        now: NOW,
        projectId: 'project-1',
        repository: REPOSITORY,
        commit: COMMIT_A,
        runTargetId: 'primary',
      });
      const evidenceRepository = {
        provider: 'github' as const,
        repository: REPOSITORY,
        commit: COMMIT_A,
        branch: 'main',
        ref: 'refs/heads/main',
        dirty: false,
      };
      const clear = clearPrivacy();
      const oidcRun = RunArtifactSchema.parse({
        ...run,
        repository: evidenceRepository,
        privacy: clear,
        attempts: run.attempts.map((attempt) => ({
          ...attempt,
          privacy: clear,
          states: attempt.states.map((state) => ({ ...state, privacy: clear })),
        })),
      });
      const oidcBuild = BuildArtifactSchema.parse({
        ...build,
        repository: evidenceRepository,
        runs: build.runs.map((reference) => ({
          ...reference,
          run: reference.run ? { ...reference.run, sha256: artifactHash(oidcRun) } : undefined,
        })),
      });
      const sceneEnvelope = { scene, privacy: clear };
      const runEnvelope = { run: oidcRun };
      const buildEnvelope = { build: oidcBuild };
      const wrongCommitEnvelope = {
        run: RunArtifactSchema.parse({
          ...oidcRun,
          id: 'run-wrong-commit',
          repository: { ...evidenceRepository, commit: COMMIT_B },
        }),
      };
      const envelopes = [sceneEnvelope, runEnvelope, buildEnvelope, wrongCommitEnvelope].map(
        (value) => {
          const bytes = new TextEncoder().encode(`${stableStringify(value)}\n`);
          return {
            value,
            bytes,
            object: {
              sha256: sha256(bytes),
              byteLength: bytes.byteLength,
              mediaType: 'application/json' as const,
            },
          };
        },
      );
      const screenshotReferences = new Map<
        string,
        { sha256: string; byteLength: number; mediaType: 'image/png' | 'image/jpeg'; path: string }
      >();
      for (const attempt of oidcRun.attempts) {
        for (const state of attempt.states) {
          if (!state.screenshot) continue;
          if (
            state.screenshot.mediaType !== 'image/png' &&
            state.screenshot.mediaType !== 'image/jpeg'
          ) {
            throw new Error(`Unexpected reporter screenshot type ${state.screenshot.mediaType}`);
          }
          screenshotReferences.set(state.screenshot.sha256, {
            sha256: state.screenshot.sha256,
            byteLength: state.screenshot.byteLength,
            mediaType: state.screenshot.mediaType,
            path: state.screenshot.path,
          });
        }
      }
      const screenshotEntries = await Promise.all(
        [...screenshotReferences.values()].map(async (reference) => {
          const bytes = new Uint8Array(
            await readFile(join(reporterRoot, '.scenebook/runs', reference.path)),
          );
          expect(sha256(bytes)).toBe(reference.sha256);
          expect(bytes.byteLength).toBe(reference.byteLength);
          return {
            bytes,
            object: {
              sha256: reference.sha256,
              byteLength: reference.byteLength,
              mediaType: reference.mediaType,
            },
          };
        }),
      );
      const wrongCommitObject = envelopes.at(-1)!;
      const uploadEntries = [...envelopes.slice(0, -1), ...screenshotEntries, wrongCommitObject];
      const exchange = await app.request('/v1/oidc/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          oidcToken: 'integration-oidc-token-'.padEnd(120, 'x'),
        }),
      });
      await expectStatus(exchange, 200);
      const artifactToken = ((await exchange.json()) as { token: string }).token;
      const uploadHeaders = {
        authorization: `Bearer ${artifactToken}`,
        'content-type': 'application/json',
      };
      const beginEvidence = await app.request('/v1/uploads', {
        method: 'POST',
        headers: { ...uploadHeaders, 'idempotency-key': 'backend-oidc-evidence' },
        body: JSON.stringify({ objects: uploadEntries.map((entry) => entry.object) }),
      });
      await expectStatus(beginEvidence, 201);
      const evidenceUploadId = ((await beginEvidence.json()) as { upload: { id: string } }).upload
        .id;
      const evidenceHeaders = {
        ...uploadHeaders,
        'x-scenebook-upload-id': evidenceUploadId,
      };

      const pendingRun = await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
        {
          method: 'POST',
          headers: { ...evidenceHeaders, 'idempotency-key': 'backend-pending-run' },
          body: `${stableStringify(runEnvelope)}\n`,
        },
      );
      await expectStatus(pendingRun, 409);
      expect(await pendingRun.json()).toMatchObject({
        error: { code: 'evidence_upload_not_finalized' },
      });

      for (const entry of uploadEntries.slice(0, -1)) {
        await expectStatus(
          await app.request(`/v1/uploads/${evidenceUploadId}/objects/${entry.object.sha256}`, {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${artifactToken}`,
              'content-type': entry.object.mediaType,
            },
            body: entry.bytes.slice().buffer,
          }),
          200,
        );
      }
      const manifest = {
        schemaVersion: 1 as const,
        objects: uploadEntries.map((entry) => entry.object),
        metadata: {
          kind: 'backend-oidc-evidence',
          repository: REPOSITORY,
          commit: COMMIT_A,
          ref: 'refs/heads/main',
        },
      };
      await expectStatus(
        await app.request(`/v1/uploads/${evidenceUploadId}/finalize`, {
          method: 'POST',
          headers: uploadHeaders,
          body: JSON.stringify({ manifest }),
        }),
        409,
      );
      await expectStatus(
        await app.request(
          `/v1/uploads/${evidenceUploadId}/objects/${wrongCommitObject.object.sha256}`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${artifactToken}`,
              'content-type': wrongCommitObject.object.mediaType,
            },
            body: wrongCommitObject.bytes.slice().buffer,
          },
        ),
        200,
      );
      await expectStatus(
        await app.request(`/v1/uploads/${evidenceUploadId}/finalize`, {
          method: 'POST',
          headers: uploadHeaders,
          body: JSON.stringify({ manifest }),
        }),
        200,
      );

      const wrongCommitResponse = await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
        {
          method: 'POST',
          headers: { ...evidenceHeaders, 'idempotency-key': 'backend-wrong-commit' },
          body: `${stableStringify(wrongCommitEnvelope)}\n`,
        },
      );
      await expectStatus(wrongCommitResponse, 403);
      expect(await wrongCommitResponse.json()).toMatchObject({
        error: { code: 'evidence_provenance_mismatch' },
      });
      const wrongObjectResponse = await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
        {
          method: 'POST',
          headers: { ...evidenceHeaders, 'idempotency-key': 'backend-wrong-object' },
          body: `${stableStringify({
            run: { ...oidcRun, durationMs: oidcRun.durationMs + 1 },
          })}\n`,
        },
      );
      await expectStatus(wrongObjectResponse, 422);
      expect(await wrongObjectResponse.json()).toMatchObject({
        error: { code: 'evidence_object_missing' },
      });

      const sceneResponse = await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/scenes/revisions',
        {
          method: 'POST',
          headers: { ...evidenceHeaders, 'idempotency-key': 'backend-oidc-scene' },
          body: `${stableStringify(sceneEnvelope)}\n`,
        },
      );
      await expectStatus(sceneResponse, 201);
      expect(await sceneResponse.json()).toMatchObject({
        revision: {
          sceneId: oidcRun.sceneId,
          revision: oidcRun.sourceRevision,
          createdBy: 'github-actions',
        },
      });

      const runResponse = await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
        {
          method: 'POST',
          headers: { ...evidenceHeaders, 'idempotency-key': 'backend-oidc-run' },
          body: `${stableStringify(runEnvelope)}\n`,
        },
      );
      await expectStatus(runResponse, 201);
      expect(await runResponse.json()).toMatchObject({
        run: { id: oidcRun.id, artifactHash: artifactHash(oidcRun), recordedBy: 'github-actions' },
      });
      const buildResponse = await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/builds',
        {
          method: 'POST',
          headers: { ...evidenceHeaders, 'idempotency-key': 'backend-oidc-build' },
          body: `${stableStringify(buildEnvelope)}\n`,
        },
      );
      await expectStatus(buildResponse, 201);
      expect(await buildResponse.json()).toMatchObject({
        build: {
          id: oidcBuild.id,
          artifactHash: artifactHash(oidcBuild),
          recordedBy: 'github-actions',
        },
      });

      const finalizedEvidenceUpload = await repository.getUpload(evidenceUploadId);
      expect(finalizedEvidenceUpload).toMatchObject({
        id: evidenceUploadId,
        status: 'finalized',
        repository: REPOSITORY,
        commit: COMMIT_A,
        ref: 'refs/heads/main',
        manifestHash: canonicalJsonHash(manifest),
      });
      for (const object of finalizedEvidenceUpload!.objects) {
        expect(object.finalKey).toBe(
          immutableObjectKey('workspace-1', object.sha256, object.mediaType),
        );
        await expect(
          store.read({
            key: object.finalKey!,
            sha256: object.sha256,
            byteLength: object.byteLength,
            mediaType: object.mediaType,
          }),
        ).resolves.toHaveLength(object.byteLength);
      }

      const selected = oidcRun.attempts.find(
        (attempt) => attempt.id === oidcRun.selectedAttemptId,
      )!;
      const baseline = BaselineSchema.parse({
        schemaVersion: 1,
        artifactVersion: 1,
        id: 'baseline-backend',
        projectId: 'project-1',
        kind: 'baseline',
        createdAt: NOW.toISOString(),
        producer: { name: 'backend-integration', version: '1.0.0' },
        sceneId: run.sceneId,
        runTargetId: run.runTargetId,
        sourceRunId: run.id,
        sourceAttemptId: selected.id,
        sourceRevision: run.sourceRevision,
        completeness: 'complete',
        sourceRunStatus: 'passed',
        expectedStepIds: run.expectedStepIds,
        states: selected.states.map((state) => ({
          sceneId: state.sceneId,
          stepId: state.stepId,
          phase: state.phase,
          stateId: state.id,
          screenshot: state.screenshot,
          screenshotHash: state.screenshotHash,
          ...(state.perceptualHash ? { perceptualHash: state.perceptualHash } : {}),
          route: state.route,
          viewport: state.viewport,
          ...(state.target ? { target: state.target } : {}),
          ...(state.semantic ? { semantic: state.semantic } : {}),
          privacy: state.privacy,
        })),
        checks: selected.checks,
        checksHash: canonicalJsonHash(selected.checks),
        approvals: [
          {
            id: 'baseline-backend-author',
            kind: 'visual',
            decision: 'approved',
            actorId: 'admin',
            createdAt: NOW.toISOString(),
            revision: run.sourceRevision,
          },
        ],
      });
      await expectStatus(
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/baselines',
          admin({ baseline }, 'backend-baseline'),
        ),
        201,
      );

      const releaseBytes = new TextEncoder().encode('real backend release output');
      const publicationInput = {
        app,
        uploadTokens,
        now: NOW,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: REPOSITORY,
        ref: 'refs/heads/main',
        workflowRef: WORKFLOW_REF,
        sceneId: scene.id,
        sourceRevision: run.sourceRevision,
        bytes: releaseBytes,
      } as const;
      const uploadA = await finalizePublicationFixture({
        ...publicationInput,
        commit: COMMIT_A,
        tokenId: 'backend-upload-commit-a',
        uploadKey: 'backend-upload-commit-a',
      });
      const uploadB = await finalizePublicationFixture({
        ...publicationInput,
        commit: COMMIT_B,
        tokenId: 'backend-upload-commit-b',
        uploadKey: 'backend-upload-commit-b',
      });
      expect(uploadA.manifestHash).toBe(uploadB.manifestHash);
      expect(uploadA.uploadId).not.toBe(uploadB.uploadId);
      await expect(
        repository.getFinalizedUploadByManifest(
          'workspace-1',
          'project-1',
          REPOSITORY,
          COMMIT_A,
          uploadA.manifestHash,
        ),
      ).resolves.toMatchObject({ id: uploadA.uploadId, commit: COMMIT_A });
      await expect(
        repository.getFinalizedUploadByManifest(
          'workspace-1',
          'project-1',
          REPOSITORY.toUpperCase(),
          COMMIT_B,
          uploadB.manifestHash,
        ),
      ).resolves.toMatchObject({ id: uploadB.uploadId, commit: COMMIT_B });
      await expect(
        repository.getFinalizedUploadByManifest(
          'workspace-1',
          'project-1',
          REPOSITORY,
          'd'.repeat(40),
          uploadA.manifestHash,
        ),
      ).resolves.toBeUndefined();

      const candidate = {
        schemaVersion: 1,
        artifactVersion: 1,
        id: 'release-backend',
        projectId: 'project-1',
        kind: 'release' as const,
        createdAt: NOW.toISOString(),
        producer: { name: 'backend-integration', version: '1.0.0' },
        channelId: 'channel-1',
        sourceBuildId: build.id,
        scenes: [
          {
            sceneId: scene.id,
            sourceRevision: run.sourceRevision,
            outputs: [uploadA.output],
          },
        ],
        manifestHash: uploadA.manifestHash,
        publication: uploadA.publication,
      };
      const approvalPath = '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/approvals';
      for (const [id, kind] of [
        ['visual-backend', 'visual'],
        ['editorial-backend', 'editorial'],
      ] as const) {
        await expectStatus(
          await app.request(
            approvalPath,
            admin({ id, kind, decision: 'approved', baselineId: baseline.id }, `approval-${id}`),
          ),
          201,
        );
      }
      await expectStatus(
        await app.request(
          approvalPath,
          admin(
            {
              id: 'release-backend-approval',
              kind: 'release',
              decision: 'approved',
              release: candidate,
            },
            'approval-release-backend',
          ),
        ),
        201,
      );

      const promoted = await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-1/releases',
        admin(
          {
            release: candidate,
            evidence: {
              releaseApprovalId: 'release-backend-approval',
              scenes: [
                {
                  sceneId: scene.id,
                  runId: run.id,
                  baselineId: baseline.id,
                  visualApprovalId: 'visual-backend',
                  editorialApprovalId: 'editorial-backend',
                },
              ],
            },
          },
          'promote-backend-release',
        ),
      );
      await expectStatus(promoted, 201);
      expect(await promoted.json()).toMatchObject({
        release: {
          id: candidate.id,
          sourceBuildId: build.id,
          status: 'published',
          scenes: [{ sceneId: scene.id, baselineId: baseline.id, carriedForward: false }],
        },
        policy: { allowed: true },
      });
      expect(
        (await repository.getRelease('workspace-1', 'project-1', candidate.id))?.promotionEvidence,
      ).toMatchObject({
        buildId: build.id,
        artifactUploadId: uploadA.uploadId,
        scenes: [{ sceneId: scene.id, runId: run.id, baselineId: baseline.id }],
      });
      const resolvedPublication = await repository.resolveHostedPublication({
        kind: 'path',
        workspaceSlug: 'acme',
        projectSlug: 'product',
        channelSlug: 'production',
      });
      expect(resolvedPublication).toMatchObject({
        workspace: { id: 'workspace-1', slug: 'acme' },
        project: { id: 'project-1', slug: 'product' },
        channel: { id: 'channel-1', currentReleaseId: candidate.id, sequence: 1 },
        release: { release: { id: candidate.id, status: 'published' } },
      });
      const publicationGateway = createPublicationGatewayApp({
        repository,
        objectStore: store,
        identityVerifier: new IdentityTokenVerifier(GATEWAY_IDENTITY_PUBLIC_KEY),
        portalSessions: new PortalSessionService('backend-gateway-session-'.padEnd(64, 'g')),
        bootstrapClient: {
          consume: async () => {
            throw new Error('Publication login is not used by this public integration fixture');
          },
        },
        config: {
          nodeEnv: 'test',
          publicationBaseUrl: 'http://publish.integration',
          controlPlaneBaseUrl: 'http://control.integration',
          sessionTtlSeconds: 3_600,
          maxJsonBytes: 16 * 1024,
          maxMemberBytes: 4 * 1024 * 1024,
          maxCacheBytes: 8 * 1024 * 1024,
          maxConcurrentResponses: 2,
          temporaryRoot: join(reporterRoot, 'gateway-temporary'),
        },
        now: () => new Date(NOW),
      });
      const hostedOutput = await publicationGateway.request(
        `http://publish.integration/s/acme/product/production/scenes/${scene.id}/index.html`,
        { headers: { host: 'publish.integration' } },
      );
      await expectStatus(hostedOutput, 200);
      expect(await hostedOutput.text()).toBe('real backend release output');
      expect(hostedOutput.headers.get('x-scenebook-release-id')).toBe(candidate.id);
      expect([...hostedOutput.headers.values()].join(' ')).not.toContain(MINIO_ENDPOINT);

      const stepId = scene.steps[0]!.id;
      for (const [id, type, subject] of [
        ['pg-view-1', 'view', 'subject-a'],
        ['pg-start-1', 'start', 'subject-a'],
        ['pg-step-1a', 'step', 'subject-a'],
        ['pg-step-1b', 'step', 'subject-a'],
        ['pg-complete-1', 'complete', 'subject-a'],
        ['pg-cta-1', 'cta', 'subject-a'],
        ['pg-view-2', 'view', 'subject-b'],
        ['pg-start-2', 'start', 'subject-b'],
      ] as const) {
        await repository.ingestAnalytics({
          schemaVersion: 1,
          id,
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          channelId: 'channel-1',
          releaseId: candidate.id,
          sceneId: scene.id,
          stepId,
          type,
          occurredAt: NOW.toISOString(),
          sessionIdHash: subject,
          properties: { neverReturned: 'private aggregate input' },
        });
      }
      await repository.ingestAnalytics({
        schemaVersion: 1,
        id: 'pg-outside-range',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        releaseId: candidate.id,
        sceneId: scene.id,
        stepId,
        type: 'error',
        occurredAt: '2026-07-20T10:59:59.999Z',
        sessionIdHash: 'subject-outside',
        properties: {},
      });
      const funnelPath = `/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-1/analytics/funnel?releaseId=${candidate.id}&from=2026-07-20T11%3A00%3A00.000Z&to=2026-07-20T12%3A00%3A00.000Z`;
      for (const authorization of [undefined, analyticsToken, artifactToken]) {
        await expectStatus(
          await app.request(funnelPath, {
            ...(authorization ? { headers: { authorization: `Bearer ${authorization}` } } : {}),
          }),
          401,
        );
      }
      await expectStatus(
        await app.request(
          funnelPath.replace('/workspaces/workspace-1/', '/workspaces/workspace-other/'),
          { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
        ),
        404,
      );
      await expectStatus(
        await app.request(funnelPath.replace('/projects/project-1/', '/projects/project-other/'), {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
        404,
      );
      const aggregateRows = await repository.aggregateAnalytics({
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        releaseId: candidate.id,
        from: '2026-07-20T11:00:00.000Z',
        to: NOW.toISOString(),
      });
      expect(
        aggregateRows.map(
          (row) => `${row.scope}:${row.sceneId ?? ''}:${row.stepId ?? ''}:${row.type}`,
        ),
      ).toEqual(
        ['total', 'scene', 'step'].flatMap((scope) =>
          ['complete', 'cta', 'start', 'step', 'view'].map(
            (type) =>
              `${scope}:${scope === 'total' ? '' : scene.id}:${scope === 'step' ? stepId : ''}:${type}`,
          ),
        ),
      );
      const postgresFunnel = await app.request(funnelPath, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      await expectStatus(postgresFunnel, 200);
      const postgresFunnelBody = await postgresFunnel.json();
      expect(postgresFunnelBody).toMatchObject({
        funnel: {
          releaseId: candidate.id,
          totals: {
            events: { view: 2, start: 2, step: 2, complete: 1, cta: 1, error: 0 },
            uniqueSubjects: { view: 2, start: 2, step: 1, complete: 1, cta: 1, error: 0 },
            rates: {
              startPerView: 1,
              completionPerView: 0.5,
              completionPerStart: 0.5,
              dropoffPerView: 0.5,
              ctaPerView: 0.5,
            },
          },
          scenes: [
            {
              sceneId: scene.id,
              steps: [
                {
                  stepId,
                  reaches: 4,
                  rates: { ctaPerReach: 0.25, completionPerReach: 0.25 },
                },
              ],
            },
          ],
          ctas: [{ sceneId: scene.id, stepId, events: 1, uniqueSubjects: 1 }],
        },
      });
      expect(JSON.stringify(postgresFunnelBody)).not.toMatch(
        /subject-a|subject-b|neverReturned|private aggregate input/u,
      );
    } finally {
      await repository?.close().catch(() => undefined);
      await adminRepository.pool
        .query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`)
        .catch(() => undefined);
      await adminRepository.close().catch(() => undefined);
      await rm(reporterRoot, { recursive: true, force: true });
    }
  });
});
