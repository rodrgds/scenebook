import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stableStringify, sha256 } from '@scenebook/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CreateSceneRevisionRequestSchema,
  RecordVerificationBuildRequestSchema,
  RecordVerificationRunRequestSchema,
} from '../src/api-schemas.js';
import { createControlPlaneApp } from '../src/app.js';
import { IdentityTokenService } from '../src/auth.js';
import { HmacHasher, SecretBox, UploadTokenService } from '../src/crypto.js';
import { createJsonLogger } from '../src/logger.js';
import {
  FileSystemObjectStore,
  immutableObjectKey,
  stagingObjectKey,
} from '../src/object-store.js';
import type { GitHubOidcClaims, GitHubOidcVerifier } from '../src/oidc.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import { WebhookDispatcher } from '../src/webhook.js';
import { RunnerTokenService } from '../src/runner-token.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const ADMIN = 'admin-secret-'.padEnd(64, 'a');
const SECRET = 'server-secret-'.padEnd(64, 's');
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
const OIDC_CLAIMS: GitHubOidcClaims = {
  repository: 'acme/product',
  commit: 'a'.repeat(40),
  ref: 'refs/heads/main',
  workflowRef: 'acme/product/.github/workflows/publish.yml@refs/heads/main',
  actor: 'octocat',
  runId: '1001',
  tokenId: 'github-oidc-ingestion-jti',
};

class FakeOidcVerifier implements GitHubOidcVerifier {
  async verify(): Promise<GitHubOidcClaims> {
    return OIDC_CLAIMS;
  }
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture() {
  const repository = new MemoryControlPlaneRepository();
  const root = await mkdtemp(join(tmpdir(), 'scenebook-oidc-ingestion-'));
  temporaryRoots.push(root);
  const uploadTokens = new UploadTokenService(SECRET);
  const objectStore = new FileSystemObjectStore(root);
  const app = createControlPlaneApp({
    repository,
    objectStore,
    oidcVerifier: new FakeOidcVerifier(),
    uploadTokens,
    identityTokens: new IdentityTokenService('identity-secret-'.padEnd(64, 'i')),
    runnerTokens: new RunnerTokenService('runner-secret-'.padEnd(64, 'r')),
    hasher: new HmacHasher(SECRET),
    secretBox: new SecretBox(ENCRYPTION_KEY),
    webhooks: new WebhookDispatcher([]),
    logger: createJsonLogger('error', () => undefined),
    adminToken: ADMIN,
    publicBaseUrl: 'https://scenebook.example.com',
    publicationBaseUrl: 'https://publish.scenebook.example.com',
    maxJsonBytes: 128 * 1024,
    maxObjectBytes: 1024 * 1024,
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
    identity: {
      sessionTtlSeconds: 28_800,
      apiTokenMaxTtlSeconds: 7_776_000,
      shareLinkMaxTtlSeconds: 604_800,
    },
    runnerLeaseSeconds: 120,
    rateLimit: { requests: 1_000, aggregateRequests: 10_000, windowMs: 60_000 },
    now: () => new Date(NOW),
  });
  return { app, objectStore, repository, uploadTokens };
}

type TestApp = ReturnType<typeof createControlPlaneApp>;

function admin(body?: unknown, extraHeaders: HeadersInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function artifactRequest(
  token: string,
  body: unknown,
  key: string,
  uploadId?: string,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
      ...(uploadId ? { 'x-scenebook-upload-id': uploadId } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function bootstrap(app: TestApp): Promise<string> {
  expect(
    (
      await app.request(
        '/v1/admin/workspaces',
        admin({ id: 'workspace-1', slug: 'acme', name: 'Acme' }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request(
        '/v1/admin/workspaces/workspace-1/projects',
        admin({ id: 'project-1', slug: 'product', name: 'Product' }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/repositories',
        admin({
          repository: OIDC_CLAIMS.repository,
          workflowRefPattern: 'acme/product/.github/workflows/*.yml@refs/heads/main',
        }),
      )
    ).status,
  ).toBe(201);

  const exchange = await app.request('/v1/oidc/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      oidcToken: 'x'.repeat(120),
    }),
  });
  expect(exchange.status).toBe(200);
  return ((await exchange.json()) as { token: string }).token;
}

async function uploadEnvelope(
  app: TestApp,
  token: string,
  envelope: unknown,
  key: string,
  options: { readonly finalize?: boolean; readonly bytes?: Uint8Array } = {},
): Promise<string> {
  const bytes = options.bytes ?? new TextEncoder().encode(`${stableStringify(envelope)}\n`);
  const object = {
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'application/json',
  } as const;
  const begin = await app.request('/v1/uploads', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `${key}-upload`,
    },
    body: JSON.stringify({ objects: [object] }),
  });
  expect(begin.status).toBe(201);
  const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;
  const put = await app.request(`/v1/uploads/${uploadId}/objects/${object.sha256}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': object.mediaType },
    body: Uint8Array.from(bytes).buffer,
  });
  expect(put.status).toBe(200);

  if (options.finalize === false) return uploadId;

  const manifest = { schemaVersion: 1, objects: [object], metadata: { envelope: key } };
  const finalize = await app.request(`/v1/uploads/${uploadId}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  expect(finalize.status).toBe(200);
  return uploadId;
}

const CLEAR_PRIVACY = {
  status: 'clear' as const,
  scannedAt: NOW.toISOString(),
  scannerVersion: '1.0.0',
  counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
  findings: [],
};

type SceneRevisionEnvelope = ReturnType<typeof CreateSceneRevisionRequestSchema.parse>;

function sceneEnvelope(privacy: SceneRevisionEnvelope['privacy'] = CLEAR_PRIVACY) {
  return CreateSceneRevisionRequestSchema.parse({
    scene: {
      schemaVersion: 1,
      id: 'oidc-scene',
      title: 'OIDC ingestion contract',
      slug: 'oidc-ingestion-contract',
      criticality: 'critical',
      steps: [{ id: 'verify-step', kind: 'explanation', title: 'Verify the immutable output' }],
    },
    privacy,
  });
}

async function persistSceneAsAdmin(app: TestApp): Promise<string> {
  const response = await app.request(
    '/v1/admin/workspaces/workspace-1/projects/project-1/scenes/revisions',
    admin(sceneEnvelope()),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { revision: { revision: string } }).revision.revision;
}

function runEnvelope(sourceRevision: string) {
  return RecordVerificationRunRequestSchema.parse({
    run: {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'oidc-run',
      kind: 'run',
      projectId: 'project-1',
      sceneId: 'oidc-scene',
      runTargetId: 'primary',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      repository: {
        provider: 'github',
        repository: OIDC_CLAIMS.repository,
        commit: OIDC_CLAIMS.commit,
        branch: 'main',
        ref: OIDC_CLAIMS.ref,
        dirty: false,
      },
      sourceRevision,
      status: 'passed',
      changeState: 'passed',
      expectedStepIds: ['verify-step'],
      attempts: [
        {
          id: 'attempt-1',
          index: 0,
          status: 'passed',
          startedAt: NOW.toISOString(),
          endedAt: NOW.toISOString(),
          durationMs: 10,
          actions: [],
          checks: [
            {
              checkId: 'check-1',
              stepId: 'verify-step',
              status: 'passed',
              message: 'The Playwright assertion passed.',
              source: { path: 'tests/verified.spec.ts', line: 10, column: 3 },
            },
          ],
          states: [],
          errors: [],
          attachments: [],
          privacy: CLEAR_PRIVACY,
        },
      ],
      selectedAttemptId: 'attempt-1',
      startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
      durationMs: 10,
      privacy: CLEAR_PRIVACY,
    },
  });
}

function buildEnvelope(runHash: string) {
  return RecordVerificationBuildRequestSchema.parse({
    build: {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'oidc-build',
      kind: 'build',
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      repository: {
        provider: 'github',
        repository: OIDC_CLAIMS.repository,
        commit: OIDC_CLAIMS.commit,
        branch: 'main',
        ref: OIDC_CLAIMS.ref,
        dirty: false,
      },
      trigger: 'push',
      status: 'passed',
      expectedRunPlan: [{ sceneId: 'oidc-scene', runTargetId: 'primary', required: true }],
      runs: [
        {
          sceneId: 'oidc-scene',
          runTargetId: 'primary',
          required: true,
          run: { id: 'oidc-run', kind: 'run', sha256: runHash },
          status: 'passed',
          changeState: 'passed',
        },
      ],
      startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
      summary: { total: 1, passed: 1, changed: 0, broken: 0, blocked: 0, pending: 0 },
    },
  });
}

describe('OIDC artifact ingestion contract', () => {
  it('limits upload tokens to the three exact write routes and their Workspace/Project', async () => {
    const { app } = await fixture();
    const token = await bootstrap(app);
    const bearer = { authorization: `Bearer ${token}` };

    const denied = [
      await app.request('/v1/admin/workspaces/workspace-1', { headers: bearer }),
      await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/scenes/oidc-scene/revisions',
        { headers: bearer },
      ),
      await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/baselines',
        artifactRequest(token, {}, 'denied-baseline'),
      ),
      await app.request(
        '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/approvals',
        artifactRequest(token, {}, 'denied-approval'),
      ),
    ];
    for (const response of denied) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_admin_token' } });
    }

    for (const path of [
      '/v1/admin/workspaces/another-workspace/projects/project-1/scenes/revisions',
      '/v1/admin/workspaces/workspace-1/projects/another-project/scenes/revisions',
      '/v1/admin/workspaces/another-workspace/projects/project-1/evidence/runs',
      '/v1/admin/workspaces/workspace-1/projects/another-project/evidence/builds',
    ]) {
      const response = await app.request(path, artifactRequest(token, {}, 'wrong-scope'));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'token_scope_mismatch' } });
    }
  });

  it('selects upload objects by the composite digest and media identity', async () => {
    const { app, objectStore, repository } = await fixture();
    const token = await bootstrap(app);
    const bytes = new TextEncoder().encode('{"status":"ok"}');
    const digest = sha256(bytes);
    const jsonObject = {
      sha256: digest,
      byteLength: bytes.byteLength,
      mediaType: 'application/json',
    } as const;
    const plainObject = { ...jsonObject, mediaType: 'text/plain' as const };

    const duplicate = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'duplicate-media-identity',
      },
      body: JSON.stringify({ objects: [jsonObject, jsonObject] }),
    });
    expect(duplicate.status).toBe(422);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'validation_failed' } });

    const begin = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'composite-media-identity',
      },
      body: JSON.stringify({ objects: [jsonObject, plainObject] }),
    });
    expect(begin.status).toBe(201);
    const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;

    const undeclaredMedia = await app.request(`/v1/uploads/${uploadId}/objects/${digest}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown' },
      body: Uint8Array.from(bytes).buffer,
    });
    expect(undeclaredMedia.status).toBe(415);
    expect(await undeclaredMedia.json()).toMatchObject({
      error: { code: 'media_type_mismatch' },
    });

    for (const object of [jsonObject, plainObject]) {
      const put = await app.request(`/v1/uploads/${uploadId}/objects/${digest}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': object.mediaType },
        body: Uint8Array.from(bytes).buffer,
      });
      expect(put.status).toBe(200);
    }

    const staged = await repository.getUpload(uploadId);
    expect(staged?.status).toBe('staged');
    expect(staged?.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sha256: digest,
          mediaType: 'application/json',
          stagingKey: stagingObjectKey(uploadId, digest, 'application/json'),
        }),
        expect.objectContaining({
          sha256: digest,
          mediaType: 'text/plain',
          stagingKey: stagingObjectKey(uploadId, digest, 'text/plain'),
        }),
      ]),
    );
    expect(new Set(staged?.objects.map((object) => object.stagingKey)).size).toBe(2);

    const manifest = {
      schemaVersion: 1,
      objects: [jsonObject, plainObject],
      metadata: { contract: 'composite-media-identity' },
    };
    const duplicateManifest = await app.request(`/v1/uploads/${uploadId}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { ...manifest, objects: [jsonObject, jsonObject] } }),
    });
    expect(duplicateManifest.status).toBe(422);
    expect(await duplicateManifest.json()).toMatchObject({
      error: { code: 'validation_failed' },
    });

    const finalize = await app.request(`/v1/uploads/${uploadId}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    expect(finalize.status).toBe(200);

    const finalized = await repository.getUpload(uploadId);
    expect(finalized?.status).toBe('finalized');
    const json = finalized?.objects.find((object) => object.mediaType === 'application/json');
    const plain = finalized?.objects.find((object) => object.mediaType === 'text/plain');
    expect(json?.finalKey).toBe(immutableObjectKey('workspace-1', digest, 'application/json'));
    expect(plain?.finalKey).toBe(immutableObjectKey('workspace-1', digest, 'text/plain'));
    expect(json?.finalKey).not.toBe(plain?.finalKey);
    expect(
      await objectStore.read({
        key: json!.finalKey!,
        sha256: json!.sha256,
        byteLength: json!.byteLength,
        mediaType: json!.mediaType,
      }),
    ).toEqual(bytes);
    expect(
      await objectStore.read({
        key: plain!.finalKey!,
        sha256: plain!.sha256,
        byteLength: plain!.byteLength,
        mediaType: plain!.mediaType,
      }),
    ).toEqual(bytes);
  });

  it('requires a finalized upload with the exact stable Scene envelope and records its actor idempotently', async () => {
    const { app, repository } = await fixture();
    const token = await bootstrap(app);
    const path = '/v1/admin/workspaces/workspace-1/projects/project-1/scenes/revisions';
    const envelope = sceneEnvelope();

    const missing = await app.request(path, artifactRequest(token, envelope, 'scene-missing'));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'evidence_upload_required' } });

    const pendingUpload = await uploadEnvelope(app, token, envelope, 'scene-pending', {
      finalize: false,
    });
    const pending = await app.request(
      path,
      artifactRequest(token, envelope, 'scene-pending', pendingUpload),
    );
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({
      error: { code: 'evidence_upload_not_finalized' },
    });

    const nonCanonicalUpload = await uploadEnvelope(app, token, envelope, 'scene-noncanonical', {
      bytes: new TextEncoder().encode(JSON.stringify(envelope)),
    });
    const nonCanonical = await app.request(
      path,
      artifactRequest(token, envelope, 'scene-noncanonical', nonCanonicalUpload),
    );
    expect(nonCanonical.status).toBe(422);
    expect(await nonCanonical.json()).toMatchObject({
      error: { code: 'evidence_object_missing' },
    });

    const warningEnvelope = sceneEnvelope({ ...CLEAR_PRIVACY, status: 'warning' as const });
    const warningUpload = await uploadEnvelope(app, token, warningEnvelope, 'scene-warning');
    const warning = await app.request(
      path,
      artifactRequest(token, warningEnvelope, 'scene-warning', warningUpload),
    );
    expect(warning.status).toBe(422);
    expect(await warning.json()).toMatchObject({
      error: { code: 'evidence_privacy_not_clear' },
    });

    const uploadId = await uploadEnvelope(app, token, envelope, 'scene-valid');
    const first = await app.request(
      path,
      artifactRequest(token, envelope, 'scene-valid', uploadId),
    );
    expect(first.status).toBe(201);
    const firstRecord = (await first.json()) as {
      revision: { id: string; revision: string; createdBy: string };
    };
    expect(firstRecord.revision.createdBy).toBe('github-actions');

    const retry = await app.request(
      path,
      artifactRequest(token, envelope, 'scene-valid', uploadId),
    );
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({
      revision: {
        id: firstRecord.revision.id,
        revision: firstRecord.revision.revision,
        createdBy: 'github-actions',
      },
    });
    expect(repository.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'scene.revision-created',
          actorId: 'github-actions',
          metadata: expect.objectContaining({ uploadId }),
        }),
      ]),
    );
  });

  it('requires functionally passed, privacy-clear Runs with exact clean GitHub provenance', async () => {
    const { app } = await fixture();
    const token = await bootstrap(app);
    const sourceRevision = await persistSceneAsAdmin(app);
    const path = '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs';
    const envelope = runEnvelope(sourceRevision);

    const failedEnvelope = RecordVerificationRunRequestSchema.parse({
      run: {
        ...envelope.run,
        status: 'failed',
        attempts: [{ ...envelope.run.attempts[0], status: 'failed' }],
      },
    });
    const failedUpload = await uploadEnvelope(app, token, failedEnvelope, 'run-failed');
    const failed = await app.request(
      path,
      artifactRequest(token, failedEnvelope, 'run-failed', failedUpload),
    );
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ error: { code: 'evidence_not_passed' } });

    const warningEnvelope = RecordVerificationRunRequestSchema.parse({
      run: {
        ...envelope.run,
        attempts: [
          {
            ...envelope.run.attempts[0],
            privacy: { ...CLEAR_PRIVACY, status: 'warning' },
          },
        ],
      },
    });
    const warningUpload = await uploadEnvelope(app, token, warningEnvelope, 'run-warning');
    const warning = await app.request(
      path,
      artifactRequest(token, warningEnvelope, 'run-warning', warningUpload),
    );
    expect(warning.status).toBe(422);
    expect(await warning.json()).toMatchObject({ error: { code: 'evidence_not_clear' } });

    const secretEnvelope = RecordVerificationRunRequestSchema.parse({
      run: {
        ...envelope.run,
        producer: {
          ...envelope.run.producer,
          runtime: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
        },
      },
    });
    const secretUpload = await uploadEnvelope(app, token, secretEnvelope, 'run-secret');
    const secret = await app.request(
      path,
      artifactRequest(token, secretEnvelope, 'run-secret', secretUpload),
    );
    expect(secret.status).toBe(422);
    expect(await secret.json()).toMatchObject({
      error: { code: 'evidence_privacy_not_clear' },
    });

    const provenanceCases = [
      { provider: 'generic' as const },
      { repository: 'acme/another-product' },
      { commit: 'b'.repeat(40) },
      { branch: 'release' },
      { dirty: true },
      { ref: 'refs/heads/release' },
      { ref: undefined },
    ];
    for (const [index, repositoryChange] of provenanceCases.entries()) {
      const mismatched = RecordVerificationRunRequestSchema.parse({
        run: {
          ...envelope.run,
          repository: { ...envelope.run.repository, ...repositoryChange },
        },
      });
      const response = await app.request(
        path,
        artifactRequest(token, mismatched, `run-provenance-${index}`),
      );
      expect(
        response.status,
        `Run provenance mutation was accepted: ${JSON.stringify(repositoryChange)}`,
      ).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'evidence_provenance_mismatch' },
      });
    }

    const changedEnvelope = RecordVerificationRunRequestSchema.parse({
      run: { ...envelope.run, id: 'run-reviewable-change', changeState: 'changed' },
    });
    const changedUpload = await uploadEnvelope(
      app,
      token,
      changedEnvelope,
      'run-reviewable-change',
    );
    const changed = await app.request(
      path,
      artifactRequest(token, changedEnvelope, 'run-reviewable-change', changedUpload),
    );
    expect(changed.status).toBe(201);
  });

  it('records exact Run and Build envelopes as github-actions and retries them idempotently', async () => {
    const { app, repository } = await fixture();
    const token = await bootstrap(app);
    const sourceRevision = await persistSceneAsAdmin(app);
    const runPath = '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs';
    const runBody = runEnvelope(sourceRevision);
    const pendingRunUpload = await uploadEnvelope(app, token, runBody, 'run-pending', {
      finalize: false,
    });
    const pendingRun = await app.request(
      runPath,
      artifactRequest(token, runBody, 'run-pending', pendingRunUpload),
    );
    expect(pendingRun.status).toBe(409);
    expect(await pendingRun.json()).toMatchObject({
      error: { code: 'evidence_upload_not_finalized' },
    });

    const wrongRunUpload = await uploadEnvelope(
      app,
      token,
      { ...runBody, run: { ...runBody.run, id: 'another-run' } },
      'run-wrong-envelope',
    );
    const wrongRun = await app.request(
      runPath,
      artifactRequest(token, runBody, 'run-wrong-envelope', wrongRunUpload),
    );
    expect(wrongRun.status).toBe(422);
    expect(await wrongRun.json()).toMatchObject({ error: { code: 'evidence_object_missing' } });

    const runUpload = await uploadEnvelope(app, token, runBody, 'run-valid');
    const firstRun = await app.request(
      runPath,
      artifactRequest(token, runBody, 'run-valid', runUpload),
    );
    expect(firstRun.status).toBe(201);
    const runRecord = (await firstRun.json()) as {
      run: { id: string; artifactHash: string; recordedBy: string };
    };
    expect(runRecord.run.recordedBy).toBe('github-actions');
    const retryRun = await app.request(
      runPath,
      artifactRequest(token, runBody, 'run-valid', runUpload),
    );
    expect(retryRun.status).toBe(201);
    expect(await retryRun.json()).toMatchObject({
      run: {
        id: runRecord.run.id,
        artifactHash: runRecord.run.artifactHash,
        recordedBy: 'github-actions',
      },
    });

    const buildPath = '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/builds';
    const buildBody = buildEnvelope(runRecord.run.artifactHash);
    const pendingBuildUpload = await uploadEnvelope(app, token, buildBody, 'build-pending', {
      finalize: false,
    });
    const pendingBuild = await app.request(
      buildPath,
      artifactRequest(token, buildBody, 'build-pending', pendingBuildUpload),
    );
    expect(pendingBuild.status).toBe(409);
    expect(await pendingBuild.json()).toMatchObject({
      error: { code: 'evidence_upload_not_finalized' },
    });

    const failedBuild = RecordVerificationBuildRequestSchema.parse({
      build: { ...buildBody.build, status: 'failed' },
    });
    const failedBuildUpload = await uploadEnvelope(app, token, failedBuild, 'build-failed');
    const rejectedBuild = await app.request(
      buildPath,
      artifactRequest(token, failedBuild, 'build-failed', failedBuildUpload),
    );
    expect(rejectedBuild.status).toBe(422);
    expect(await rejectedBuild.json()).toMatchObject({ error: { code: 'evidence_not_passed' } });

    const secretBuild = RecordVerificationBuildRequestSchema.parse({
      build: {
        ...buildBody.build,
        producer: {
          ...buildBody.build.producer,
          runtime: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
        },
      },
    });
    const secretBuildUpload = await uploadEnvelope(app, token, secretBuild, 'build-secret');
    const rejectedSecretBuild = await app.request(
      buildPath,
      artifactRequest(token, secretBuild, 'build-secret', secretBuildUpload),
    );
    expect(rejectedSecretBuild.status).toBe(422);
    expect(await rejectedSecretBuild.json()).toMatchObject({
      error: { code: 'evidence_privacy_not_clear' },
    });

    const wrongBuildUpload = await uploadEnvelope(
      app,
      token,
      { ...buildBody, build: { ...buildBody.build, id: 'another-build' } },
      'build-wrong-envelope',
    );
    const wrongBuild = await app.request(
      buildPath,
      artifactRequest(token, buildBody, 'build-wrong-envelope', wrongBuildUpload),
    );
    expect(wrongBuild.status).toBe(422);
    expect(await wrongBuild.json()).toMatchObject({ error: { code: 'evidence_object_missing' } });

    const buildUpload = await uploadEnvelope(app, token, buildBody, 'build-valid');
    const firstBuild = await app.request(
      buildPath,
      artifactRequest(token, buildBody, 'build-valid', buildUpload),
    );
    expect(firstBuild.status).toBe(201);
    const buildRecord = (await firstBuild.json()) as {
      build: { id: string; artifactHash: string; recordedBy: string };
    };
    expect(buildRecord.build.recordedBy).toBe('github-actions');
    const retryBuild = await app.request(
      buildPath,
      artifactRequest(token, buildBody, 'build-valid', buildUpload),
    );
    expect(retryBuild.status).toBe(201);
    expect(await retryBuild.json()).toMatchObject({
      build: {
        id: buildRecord.build.id,
        artifactHash: buildRecord.build.artifactHash,
        recordedBy: 'github-actions',
      },
    });

    expect(repository.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'evidence.run-recorded', actorId: 'github-actions' }),
        expect.objectContaining({ action: 'evidence.build-recorded', actorId: 'github-actions' }),
      ]),
    );

    for (const [index, repositoryChange] of [
      { repository: 'acme/another-product' },
      { commit: 'b'.repeat(40) },
      { branch: 'release' },
      { dirty: true },
      { ref: 'refs/heads/release' },
      { ref: undefined },
    ].entries()) {
      const mismatched = RecordVerificationBuildRequestSchema.parse({
        build: {
          ...buildBody.build,
          repository: { ...buildBody.build.repository, ...repositoryChange },
        },
      });
      const response = await app.request(
        buildPath,
        artifactRequest(token, mismatched, `build-provenance-${index}`),
      );
      expect(
        response.status,
        `Build provenance mutation was accepted: ${JSON.stringify(repositoryChange)}`,
      ).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'evidence_provenance_mismatch' },
      });
    }
  });
});
