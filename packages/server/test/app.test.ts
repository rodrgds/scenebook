import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256, stableStringify } from '@scenebook/core';
import { ReleaseSchema, SceneSchema } from '@scenebook/schema';
import { unzipSync, Zip, ZipDeflate } from 'fflate';

import { createControlPlaneApp } from '../src/app.js';
import { IdentityTokenService } from '../src/auth.js';
import { HmacHasher, SecretBox, UploadTokenService } from '../src/crypto.js';
import { EvidenceRetentionWorker } from '../src/evidence-retention.js';
import { createJsonLogger } from '../src/logger.js';
import { MetricsRegistry } from '../src/metrics.js';
import {
  FileSystemFinalObjectDeleter,
  FileSystemObjectStore,
  type ImmutableObjectStore,
} from '../src/object-store.js';
import type { GitHubOidcClaims, GitHubOidcVerifier } from '../src/oidc.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import { WebhookDispatcher } from '../src/webhook.js';
import { RunnerTokenService } from '../src/runner-token.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const ADMIN = 'admin-secret-'.padEnd(64, 'a');
const SECRET = 'server-secret-'.padEnd(64, 's');
const IDENTITY_SECRET = 'identity-secret-'.padEnd(64, 'i');
const RUNNER_SECRET = 'runner-secret-'.padEnd(64, 'r');
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64url');
const UPLOAD_LIMITS = {
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
};
const oidcClaims: GitHubOidcClaims = {
  repository: 'acme/product',
  commit: 'a'.repeat(40),
  ref: 'refs/heads/main',
  workflowRef: 'acme/product/.github/workflows/publish.yml@refs/heads/main',
  actor: 'octocat',
  runId: '1234',
  tokenId: 'github-jti-1',
};

class FakeOidcVerifier implements GitHubOidcVerifier {
  async verify(): Promise<GitHubOidcClaims> {
    return oidcClaims;
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: {
    readonly storeFactory?: (root: string) => ImmutableObjectStore;
    readonly rateLimit?: {
      readonly requests: number;
      readonly aggregateRequests: number;
      readonly windowMs: number;
    };
    readonly uploadLimits?: typeof UPLOAD_LIMITS;
    readonly enableRetention?: boolean;
  } = {},
) {
  const repository = new MemoryControlPlaneRepository();
  const root = await mkdtemp(join(tmpdir(), 'scenebook-app-'));
  roots.push(root);
  const uploadTokens = new UploadTokenService(SECRET);
  const hasher = new HmacHasher(SECRET);
  const objectStore = options.storeFactory
    ? options.storeFactory(root)
    : new FileSystemObjectStore(root);
  const evidenceRetention = options.enableRetention
    ? new EvidenceRetentionWorker({
        repository,
        finalDeleter: new FileSystemFinalObjectDeleter(root),
        logger: createJsonLogger('error', () => undefined),
        metrics: new MetricsRegistry(),
        intervalMs: 60_000,
        batchSize: 20,
        claimTtlSeconds: 300,
        standardGraceSeconds: 7 * 24 * 60 * 60,
        diagnosticGraceSeconds: 24 * 60 * 60,
        now: () => new Date(NOW),
      })
    : undefined;
  const app = createControlPlaneApp({
    repository,
    objectStore,
    oidcVerifier: new FakeOidcVerifier(),
    uploadTokens,
    identityTokens: new IdentityTokenService(IDENTITY_SECRET),
    runnerTokens: new RunnerTokenService(RUNNER_SECRET),
    hasher,
    secretBox: new SecretBox(ENCRYPTION_KEY),
    webhooks: new WebhookDispatcher([
      { id: 'crm', url: 'https://example.com/hook', secret: SECRET, timeoutMs: 1_000 },
      {
        id: 'crm-secondary',
        url: 'https://example.com/secondary-hook',
        secret: SECRET,
        timeoutMs: 1_000,
      },
    ]),
    logger: createJsonLogger('error', () => undefined),
    adminToken: ADMIN,
    publicBaseUrl: 'https://scenebook.example.com',
    publicationBaseUrl: 'https://publish.scenebook.example.com',
    maxJsonBytes: 128 * 1024,
    maxObjectBytes: 1024 * 1024,
    uploadLimits: options.uploadLimits ?? UPLOAD_LIMITS,
    uploadTokenTtlSeconds: 300,
    identity: {
      sessionTtlSeconds: 28_800,
      apiTokenMaxTtlSeconds: 7_776_000,
      shareLinkMaxTtlSeconds: 604_800,
    },
    runnerLeaseSeconds: 120,
    rateLimit: options.rateLimit ?? {
      requests: 1_000,
      aggregateRequests: 10_000,
      windowMs: 60_000,
    },
    ...(evidenceRetention ? { evidenceRetention } : {}),
    now: () => new Date(NOW),
  });
  return { app, repository, objectStore, uploadTokens, hasher };
}

function admin(body?: unknown, extra: HeadersInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function bootstrap(app: ReturnType<typeof createControlPlaneApp>) {
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
          repository: 'acme/product',
          workflowRefPattern: 'acme/product/.github/workflows/*.yml@refs/heads/main',
        }),
      )
    ).status,
  ).toBe(201);
}

async function finalizePublication(
  app: ReturnType<typeof createControlPlaneApp>,
  uploadTokens: UploadTokenService,
  input: {
    commit: string;
    tokenId: string;
    uploadKey: string;
    bytes: Uint8Array;
    sceneId: string;
    sourceRevision: string;
    archiveOutputBytes?: Uint8Array;
    omitEvidenceFile?: boolean;
  },
) {
  const token = await uploadTokens.issue(
    {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      repository: 'acme/product',
      commit: input.commit,
      ref: 'refs/heads/main',
      workflowRef: oidcClaims.workflowRef,
      permissions: ['artifact:write'],
      expiresAt: Math.floor(NOW.getTime() / 1_000) + 300,
      tokenId: input.tokenId,
    },
    Math.floor(NOW.getTime() / 1_000),
  );
  const outputPath = `scenes/${input.sceneId}/index.html`;
  const output = {
    path: outputPath,
    sha256: sha256(input.bytes),
    byteLength: input.bytes.byteLength,
    mediaType: 'text/html',
  } as const;
  const compilerManifestBytes = new TextEncoder().encode(
    `${stableStringify({
      format: 'scenebook-catalog',
      version: 1,
      privacy: { status: 'passed', scanner: 'fixture' },
      scenes: [
        {
          id: input.sceneId,
          slug: input.sceneId,
          sourceHash: input.sourceRevision,
          locale: 'en',
          evidence: `scenes/${input.sceneId}/evidence.json`,
          outputs: { catalog: [outputPath] },
        },
      ],
    })}\n`,
  );
  const compilerManifest = {
    path: 'manifest.json',
    sha256: sha256(compilerManifestBytes),
    byteLength: compilerManifestBytes.byteLength,
    mediaType: 'application/json',
  } as const;
  const evidenceBytes = new TextEncoder().encode('{}\n');
  const evidence = {
    path: `scenes/${input.sceneId}/evidence.json`,
    sha256: sha256(evidenceBytes),
    byteLength: evidenceBytes.byteLength,
    mediaType: 'application/json',
  } as const;
  const files = [compilerManifest, output, ...(input.omitEvidenceFile ? [] : [evidence])].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
  const archiveChunks: Uint8Array[] = [];
  let archiveError: unknown;
  const zip = new Zip((error, bytes) => {
    if (error) archiveError = error;
    else archiveChunks.push(bytes);
  });
  const publicationBytes = new Map<string, Uint8Array>([
    ['manifest.json', compilerManifestBytes],
    [outputPath, input.archiveOutputBytes ?? input.bytes],
    [`scenes/${input.sceneId}/evidence.json`, evidenceBytes],
  ]);
  for (const file of files) {
    const entry = new ZipDeflate(file.path, { level: 9 });
    entry.mtime = new Date(1980, 0, 1, 0, 0, 0, 0);
    entry.os = 3;
    entry.attrs = (0o100644 << 16) >>> 0;
    zip.add(entry);
    entry.push(publicationBytes.get(file.path)!, true);
  }
  zip.end();
  if (archiveError) throw archiveError;
  const archiveBytes = new Uint8Array(
    Buffer.concat(archiveChunks.map((chunk) => Buffer.from(chunk))),
  );
  const archive = {
    sha256: sha256(archiveBytes),
    byteLength: archiveBytes.byteLength,
    mediaType: 'application/zip',
  } as const;
  const treeHash = sha256(stableStringify({ files }));
  const inventoryBytes = new TextEncoder().encode(
    `${stableStringify({
      format: 'scenebook-publication-archive',
      version: 1,
      archive,
      treeHash,
      byteLength: files.reduce((total, file) => total + file.byteLength, 0),
      compilerManifest,
      files,
    })}\n`,
  );
  const inventory = {
    sha256: sha256(inventoryBytes),
    byteLength: inventoryBytes.byteLength,
    mediaType: 'application/json',
  } as const;
  const compilerManifestObject = {
    sha256: compilerManifest.sha256,
    byteLength: compilerManifest.byteLength,
    mediaType: 'application/json',
  } as const;
  const objects = [archive, inventory, compilerManifestObject];
  const begin = await app.request('/v1/uploads', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': input.uploadKey,
    },
    body: JSON.stringify({ objects }),
  });
  expect(begin.status).toBe(201);
  const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;
  for (const [object, bytes] of [
    [archive, archiveBytes],
    [inventory, inventoryBytes],
    [compilerManifestObject, compilerManifestBytes],
  ] as const) {
    expect(
      (
        await app.request(`/v1/uploads/${uploadId}/objects/${object.sha256}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': object.mediaType },
          body: new Uint8Array(bytes).buffer,
        })
      ).status,
    ).toBe(200);
  }
  const manifest = {
    schemaVersion: 1,
    objects,
    metadata: {
      publication: { archive, inventory, compilerManifest: compilerManifestObject, treeHash },
    },
  };
  const finalized = await app.request(`/v1/uploads/${uploadId}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  expect(finalized.status).toBe(200);
  return {
    manifestHash: sha256(stableStringify(manifest)),
    publication: { archive, inventory, compilerManifest: compilerManifestObject, treeHash },
    output: {
      format: 'catalog' as const,
      locale: 'en',
      entrypoint: outputPath,
      asset: { ...output, role: 'document' as const },
    },
  };
}

describe('control-plane HTTP API', () => {
  it('protects admin routes and exposes liveness plus readiness', async () => {
    const { app } = await fixture();
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/readyz')).status).toBe(200);
    expect((await app.request('/v1/admin/workspaces/workspace-1')).status).toBe(401);
    expect(
      (
        await app.request('/v1/admin/workspaces/workspace-1', {
          headers: { authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
  });

  it('serves the first-party Console with nonce-bound assets and parseable client code', async () => {
    const { app } = await fixture();
    const response = await app.request('/console');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('unsafe-inline');
    const html = await response.text();
    const nonce = /<script nonce="([a-f0-9]+)">/u.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(policy).toContain(`script-src 'nonce-${nonce}'`);
    expect(policy).toContain(`style-src 'nonce-${nonce}'`);
    expect(html).toContain('id="signin-form"');
    expect(html).toContain('Paste a personal API token from your workspace owner');
    expect(html).toContain('Side by side');
    expect(html).toContain('Difference is an inspection blend');
    expect(html).toContain('Comment on this visual region');
    expect(html).toContain('Assign reviewers');
    expect(html).toContain('Comment reopened');
    expect(html).toContain('Create a verification schedule');
    expect(html).toContain('Schedule recurring verification and inspect runner health');
    expect(html).toContain('Add a custom domain');
    expect(html).toContain('DNS proof alone never changes routing');
    expect(html).toContain('Workspace export');
    expect(html).toContain('Retention preview');
    const script = new RegExp(`<script nonce="${nonce}">([\\s\\S]*?)<\\/script>`, 'u').exec(
      html,
    )?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('streams a no-store portable Workspace export and fails closed when retention is disabled', async () => {
    const { app, repository } = await fixture();
    await bootstrap(app);
    const response = await app.request('/v1/admin/workspaces/workspace-1/export', {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toContain('acme-scenebook-export');
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      'manifest.json',
      'restoration.json',
      'workspace.json',
    ]);
    expect(JSON.parse(new TextDecoder().decode(files['manifest.json']))).toMatchObject({
      kind: 'scenebook-workspace-export',
      workspaceId: 'workspace-1',
    });
    expect(repository.audits.at(-1)?.action).toBe('workspace.export-created');
    const retention = await app.request(
      '/v1/admin/workspaces/workspace-1/retention/run?dryRun=true',
      { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } },
    );
    expect(retention.status).toBe(503);
    expect((await retention.json()) as unknown).toMatchObject({
      error: { code: 'evidence_retention_disabled' },
    });
  });

  it('scopes an Owner-triggered retention pass to the authenticated route workspace', async () => {
    const { app, repository } = await fixture({ enableRetention: true });
    await bootstrap(app);
    const ownHash = sha256('owner workspace object');
    const otherHash = sha256('other workspace object');
    for (const [workspaceId, hash] of [
      ['workspace-1', ownHash],
      ['workspace-2', otherHash],
    ] as const) {
      repository.evidenceObjectLifecycle.set(`${workspaceId}\0${hash}\0text/plain`, {
        workspaceId,
        sha256: hash,
        byteLength: 22,
        mediaType: 'text/plain',
        retentionClass: 'standard',
        status: 'active',
        firstFinalizedAt: '2026-06-01T00:00:00.000Z',
        lastFinalizedAt: '2026-06-01T00:00:00.000Z',
      });
    }
    const response = await app.request(
      '/v1/admin/workspaces/workspace-1/retention/run?dryRun=true',
      { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workspaceId: string;
      claims: Array<{ workspaceId: string; sha256: string }>;
    };
    expect(body.workspaceId).toBe('workspace-1');
    expect(body.claims).toEqual([
      expect.objectContaining({ workspaceId: 'workspace-1', sha256: ownHash }),
    ]);
    expect(JSON.stringify(body)).not.toContain(otherHash);
    expect(
      repository.evidenceRetentionEvents.every((event) => event.workspaceId === 'workspace-1'),
    ).toBe(true);
    expect(
      repository.evidenceObjectLifecycle.get(`workspace-2\0${otherHash}\0text/plain`)?.status,
    ).toBe('active');
  });

  it('serves only integrity-checked finalized evidence images in the requested Project', async () => {
    const { app, repository, objectStore } = await fixture();
    await bootstrap(app);
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwO0GQAAAABJRU5ErkJggg==',
      'base64',
    );
    const digest = sha256(bytes);
    await repository.beginUpload({
      id: 'asset-upload',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      repository: 'acme/product',
      commit: 'a'.repeat(40),
      ref: 'refs/heads/main',
      idempotencyKey: 'asset-upload',
      requestHash: 'b'.repeat(64),
      objects: [{ sha256: digest, byteLength: bytes.byteLength, mediaType: 'image/png' }],
      now: NOW.toISOString(),
      expiresAt: '2026-07-20T13:00:00.000Z',
      limits: UPLOAD_LIMITS,
    });
    const staged = await objectStore.putStaged('asset-upload', digest, bytes, 'image/png');
    await repository.markObjectStaged(
      'asset-upload',
      digest,
      'image/png',
      staged.key,
      NOW.toISOString(),
    );
    const promoted = await objectStore.promote(staged, 'workspace-1');
    await repository.finalizeUpload('asset-upload', 'c'.repeat(64), [promoted], NOW.toISOString());
    const path = `/v1/admin/workspaces/workspace-1/projects/project-1/assets/${digest}?mediaType=image%2Fpng`;
    expect((await app.request(path)).status).toBe(401);
    const response = await app.request(path, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(
      (
        await app.request(
          `/v1/admin/workspaces/workspace-1/projects/project-2/assets/${digest}?mediaType=image%2Fpng`,
          { headers: { authorization: `Bearer ${ADMIN}` } },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/v1/admin/workspaces/workspace-1/projects/project-1/assets/${digest}?mediaType=text%2Fhtml`,
          { headers: { authorization: `Bearer ${ADMIN}` } },
        )
      ).status,
    ).toBe(400);
  });

  it('lists tenant-scoped control-plane resources for first-party operator clients', async () => {
    const { app } = await fixture();
    await bootstrap(app);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces',
          admin({ id: 'workspace-2', slug: 'other', name: 'Other' }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-2/projects',
          admin({ id: 'project-2', slug: 'other', name: 'Other' }),
        )
      ).status,
    ).toBe(201);
    const createScene = (workspaceId: string, projectId: string, id: string) =>
      app.request(
        `/v1/admin/workspaces/${workspaceId}/projects/${projectId}/scenes/revisions`,
        admin({
          scene: {
            schemaVersion: 1,
            id,
            title: id,
            slug: id,
            steps: [{ id: `${id}-step`, kind: 'explanation', title: 'A safe step' }],
          },
          privacy: {
            status: 'clear',
            scannedAt: NOW.toISOString(),
            scannerVersion: '1.0.0',
            counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
            findings: [],
          },
        }),
      );
    expect((await createScene('workspace-1', 'project-1', 'scene-visible')).status).toBe(201);
    expect((await createScene('workspace-2', 'project-2', 'scene-hidden')).status).toBe(201);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/channels',
          admin({
            id: 'channel-visible',
            slug: 'public',
            name: 'Public',
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
        )
      ).status,
    ).toBe(201);
    const get = (path: string) =>
      app.request(path, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(await (await get('/v1/admin/workspaces/workspace-1/projects')).json()).toMatchObject({
      projects: [{ id: 'project-1' }],
    });
    const scenes = await (
      await get('/v1/admin/workspaces/workspace-1/projects/project-1/scenes')
    ).json();
    expect(scenes).toMatchObject({ scenes: [{ sceneId: 'scene-visible' }] });
    expect(JSON.stringify(scenes)).not.toContain('scene-hidden');
    expect(
      await (await get('/v1/admin/workspaces/workspace-1/projects/project-1/channels')).json(),
    ).toMatchObject({
      channels: [
        {
          id: 'channel-visible',
          hostedUrl: 'https://publish.scenebook.example.com/s/acme/product/public/',
        },
      ],
    });
    for (const resource of [
      'reviews',
      'evidence/runs',
      'evidence/builds',
      'evidence/baselines',
      'evidence/approvals',
    ]) {
      const response = await get(
        `/v1/admin/workspaces/workspace-1/projects/project-1/${resource}?limit=2`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown[]>;
      expect(Object.values(body)[0]).toEqual([]);
    }
    expect(
      (
        await get(
          '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-visible/releases',
        )
      ).status,
    ).toBe(200);
    expect(
      (await get('/v1/admin/workspaces/workspace-1/projects/project-1/scenes?limit=501')).status,
    ).toBe(400);
  });

  it('rate-limits each client and public Channel operation independently', async () => {
    const { app } = await fixture({
      rateLimit: { requests: 1, aggregateRequests: 100, windowMs: 60_000 },
    });
    const request = (path: string, realIp: string, forwardedFor = '203.0.113.20') =>
      app.request(path, {
        method: 'POST',
        headers: { 'x-real-ip': realIp, 'x-forwarded-for': forwardedFor },
      });
    const analyticsA =
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-a/analytics';
    const analyticsB =
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-b/analytics';
    const ctaA = '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-a/cta';

    expect((await request(analyticsA, '198.51.100.10')).status).toBe(404);
    expect((await request(analyticsA, '198.51.100.10', '203.0.113.99')).status).toBe(429);
    expect((await request(analyticsA, '198.51.100.11')).status).toBe(404);
    expect((await request(analyticsB, '198.51.100.10')).status).toBe(429);
    expect((await request(ctaA, '198.51.100.10')).status).toBe(404);
  });

  it('enforces aggregate client budgets and collapses arbitrary path spam', async () => {
    const aggregate = await fixture({
      rateLimit: { requests: 10, aggregateRequests: 2, windowMs: 60_000 },
    });
    const headers = { 'x-real-ip': '198.51.100.40' };
    expect((await aggregate.app.request('/healthz', { headers })).status).toBe(200);
    expect((await aggregate.app.request('/readyz', { headers })).status).toBe(200);
    const exhausted = await aggregate.app.request('/metrics', { headers });
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get('x-ratelimit-aggregate-remaining')).toBe('0');

    const spam = await fixture({
      rateLimit: { requests: 1, aggregateRequests: 100, windowMs: 60_000 },
    });
    expect(
      (await spam.app.request('/attacker/path/one', { headers: { 'x-real-ip': '198.51.100.41' } }))
        .status,
    ).toBe(404);
    expect(
      (await spam.app.request('/attacker/path/two', { headers: { 'x-real-ip': '198.51.100.41' } }))
        .status,
    ).toBe(429);
    expect(
      (
        await spam.app.request('/attacker/path/three', {
          headers: { 'x-real-ip': '198.51.100.42' },
        })
      ).status,
    ).toBe(404);
  });

  it('exchanges GitHub OIDC once, uploads exact bytes, and finalizes an immutable manifest idempotently', async () => {
    const { app, repository } = await fixture();
    await bootstrap(app);
    const exchangeBody = {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      oidcToken: 'x'.repeat(120),
    };
    const exchange = await app.request('/v1/oidc/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exchangeBody),
    });
    expect(exchange.status).toBe(200);
    const { token } = (await exchange.json()) as { token: string };
    expect(
      (
        await app.request('/v1/oidc/exchange', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(exchangeBody),
        })
      ).status,
    ).toBe(409);

    const bytes = new TextEncoder().encode('compiled scene');
    const digest = sha256(bytes);
    const spec = { sha256: digest, byteLength: bytes.byteLength, mediaType: 'text/plain' };
    const begin = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'upload-run-1',
      },
      body: JSON.stringify({ objects: [spec] }),
    });
    expect(begin.status).toBe(201);
    const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;
    expect(
      (
        await app.request(`/v1/uploads/${uploadId}/objects/${digest}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
          body: bytes,
        })
      ).status,
    ).toBe(200);
    const manifest = { schemaVersion: 1, objects: [spec], metadata: { build: 'ci' } };
    const finalize = await app.request(`/v1/uploads/${uploadId}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    expect(finalize.status).toBe(200);
    const result = (await finalize.json()) as { manifestHash: string };
    expect(result.manifestHash).toBe(sha256(stableStringify(manifest)));
    expect((await repository.getUpload(uploadId))?.status).toBe('finalized');
    expect(
      (
        await app.request(`/v1/uploads/${uploadId}/finalize`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ manifest }),
        })
      ).status,
    ).toBe(200);
    expect(repository.audits.some((event) => event.action === 'upload.finalized')).toBe(true);
  });

  it('rejects object bodies that do not match the declared digest', async () => {
    const { app } = await fixture();
    await bootstrap(app);
    const token = await new UploadTokenService(SECRET).issue(
      {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: oidcClaims.repository,
        commit: oidcClaims.commit,
        ref: oidcClaims.ref,
        workflowRef: oidcClaims.workflowRef,
        permissions: ['artifact:write'],
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 300,
        tokenId: 'direct-token',
      },
      Math.floor(NOW.getTime() / 1_000),
    );
    const bytes = new TextEncoder().encode('expected');
    const spec = { sha256: sha256(bytes), byteLength: bytes.byteLength, mediaType: 'text/plain' };
    const begin = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'bad-object',
      },
      body: JSON.stringify({ objects: [spec] }),
    });
    const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;
    const response = await app.request(`/v1/uploads/${uploadId}/objects/${spec.sha256}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: new TextEncoder().encode('tampered'),
    });
    expect(response.status).toBe(422);
    expect((await response.json()) as object).not.toHaveProperty('error.details.bytes');
  });

  it('rejects active upload types and MIME-spoofed raster bytes', async () => {
    const { app, repository } = await fixture();
    await bootstrap(app);
    const token = await new UploadTokenService(SECRET).issue(
      {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: oidcClaims.repository,
        commit: oidcClaims.commit,
        ref: oidcClaims.ref,
        workflowRef: oidcClaims.workflowRef,
        permissions: ['artifact:write'],
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 300,
        tokenId: 'media-policy-token',
      },
      Math.floor(NOW.getTime() / 1_000),
    );
    const activeBytes = new TextEncoder().encode(
      '<!doctype html><html><script>alert(1)</script></html>',
    );
    const activeSpec = {
      sha256: sha256(activeBytes),
      byteLength: activeBytes.byteLength,
      mediaType: 'text/html',
    };
    const unsupported = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'active-format',
      },
      body: JSON.stringify({ objects: [activeSpec] }),
    });
    expect(unsupported.status).toBe(422);

    const spoofedSpec = { ...activeSpec, mediaType: 'image/png' };
    const begin = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'mime-spoof',
      },
      body: JSON.stringify({ objects: [spoofedSpec] }),
    });
    expect(begin.status).toBe(201);
    const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;
    const upload = await app.request(`/v1/uploads/${uploadId}/objects/${spoofedSpec.sha256}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      body: activeBytes,
    });
    expect(upload.status).toBe(415);
    expect(await upload.json()).toMatchObject({ error: { code: 'unsafe_object_media' } });
    expect((await repository.getUpload(uploadId))?.objects[0]?.status).toBe('pending');
  });

  it('rejects excessive object counts, aggregate bytes, and tenant active-byte reservations', async () => {
    const uploadLimits = {
      ...UPLOAD_LIMITS,
      maxObjectsPerUpload: 2,
      maxBytesPerUpload: 10,
      maxActiveBytesPerTenant: 10,
    };
    const { app, uploadTokens } = await fixture({ uploadLimits });
    const token = await uploadTokens.issue(
      {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: oidcClaims.repository,
        commit: oidcClaims.commit,
        ref: oidcClaims.ref,
        workflowRef: oidcClaims.workflowRef,
        permissions: ['artifact:write'],
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 300,
        tokenId: 'resource-cap-token',
      },
      Math.floor(NOW.getTime() / 1_000),
    );
    const spec = (value: string) => {
      const bytes = new TextEncoder().encode(value);
      return { sha256: sha256(bytes), byteLength: bytes.byteLength, mediaType: 'text/plain' };
    };
    const begin = (objects: ReturnType<typeof spec>[], key: string) =>
      app.request('/v1/uploads', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({ objects }),
      });

    const tooMany = await begin([spec('a'), spec('b'), spec('c')], 'too-many');
    expect(tooMany.status).toBe(413);
    expect(await tooMany.json()).toMatchObject({ error: { code: 'too_many_objects' } });
    const aggregate = await begin([spec('123456'), spec('abcdef')], 'too-large');
    expect(aggregate.status).toBe(413);
    expect(await aggregate.json()).toMatchObject({ error: { code: 'upload_too_large' } });
    expect((await begin([spec('1234567')], 'active-one')).status).toBe(201);
    const activeBytes = await begin([spec('four')], 'active-two');
    expect(activeBytes.status).toBe(429);
    expect(await activeBytes.json()).toMatchObject({
      error: { code: 'upload_capacity_exhausted' },
    });
  });

  it('holds tenant/global stream reservations across concurrent object uploads and releases them', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const { app, uploadTokens } = await fixture({
      uploadLimits: {
        ...UPLOAD_LIMITS,
        maxConcurrentObjectsPerTenant: 1,
        maxConcurrentObjectsGlobal: 1,
      },
      storeFactory: (root) => {
        const base = new FileSystemObjectStore(root);
        return {
          health: () => base.health(),
          putStaged: (...arguments_) => base.putStaged(...arguments_),
          putStagedStream: async (...arguments_) => {
            started();
            await gate;
            return base.putStagedStream(...arguments_);
          },
          verify: (object) => base.verify(object),
          promote: (object, workspaceId) => base.promote(object, workspaceId),
          read: (object) => base.read(object),
          deleteStaged: (object) => base.deleteStaged(object),
        } satisfies ImmutableObjectStore;
      },
    });
    const token = await uploadTokens.issue(
      {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: oidcClaims.repository,
        commit: oidcClaims.commit,
        ref: oidcClaims.ref,
        workflowRef: oidcClaims.workflowRef,
        permissions: ['artifact:write'],
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 300,
        tokenId: 'concurrency-token',
      },
      Math.floor(NOW.getTime() / 1_000),
    );
    const payloads = [new TextEncoder().encode('first'), new TextEncoder().encode('second')];
    const objects = payloads.map((bytes) => ({
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      mediaType: 'text/plain',
    }));
    const begin = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'concurrency-upload',
      },
      body: JSON.stringify({ objects }),
    });
    const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;
    const put = (index: number) =>
      app.request(`/v1/uploads/${uploadId}/objects/${objects[index]!.sha256}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
        body: payloads[index],
      });
    const first = put(0);
    await entered;
    const rejected = await put(1);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      error: { code: 'upload_concurrency_exhausted' },
    });
    resume();
    expect((await first).status).toBe(200);
    const metrics = await (await app.request('/metrics')).text();
    expect(metrics).toContain('scenebook_upload_active_objects 0');
    expect(metrics).toContain('scenebook_upload_staged_bytes_total 5');
  });

  it('hashes analytics identities and encrypts CTA fields at rest', async () => {
    const { app, repository } = await fixture();
    await bootstrap(app);
    const unknownConfiguredWebhook = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels',
      admin({
        id: 'channel-invalid',
        slug: 'invalid',
        name: 'Invalid',
        kind: 'public-catalog',
        webhookIds: ['missing'],
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
    expect(unknownConfiguredWebhook.status).toBe(422);
    expect((await unknownConfiguredWebhook.json()) as object).toMatchObject({
      error: { code: 'unknown_webhook' },
    });
    const channelResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels',
      admin({
        id: 'channel-1',
        slug: 'public',
        name: 'Public',
        kind: 'public-catalog',
        webhookIds: ['crm', 'crm-secondary'],
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
    const { analyticsToken } = (await channelResponse.json()) as { analyticsToken: string };
    const channelRetry = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels',
      admin({
        id: 'channel-1',
        slug: 'public',
        name: 'Public',
        kind: 'public-catalog',
        webhookIds: ['crm', 'crm-secondary'],
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
    expect(channelRetry.status).toBe(201);
    expect(((await channelRetry.json()) as { analyticsToken: string }).analyticsToken).toBe(
      analyticsToken,
    );
    const release = ReleaseSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'release-1',
      kind: 'release',
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      channelId: 'channel-1',
      sequence: 1,
      status: 'published',
      publishedAt: NOW.toISOString(),
      scenes: [
        {
          sceneId: 'scene-1',
          baselineId: 'baseline-1',
          sourceRevision: 'a'.repeat(64),
          outputs: [
            {
              format: 'catalog',
              asset: {
                sha256: 'b'.repeat(64),
                path: `assets/${'b'.repeat(64)}.html`,
                mediaType: 'text/html',
                byteLength: 42,
                role: 'document',
              },
            },
          ],
        },
      ],
      approvals: [
        {
          id: 'approval-1',
          kind: 'release',
          decision: 'approved',
          actorId: 'reviewer-1',
          createdAt: NOW.toISOString(),
          revision: 'a'.repeat(64),
        },
      ],
      manifestHash: 'c'.repeat(64),
    });
    await repository.createSceneRevision({
      id: 'revision-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      revision: 'a'.repeat(64),
      scene: SceneSchema.parse({
        schemaVersion: 1,
        id: 'scene-1',
        title: 'Scene one',
        slug: 'scene-one',
        steps: [
          {
            id: 'step-1',
            kind: 'explanation',
            title: 'Explain it',
            ctas: [
              {
                id: 'request-access',
                kind: 'form',
                label: 'Request access',
                webhookId: 'crm',
                fields: [
                  {
                    id: 'email',
                    label: 'Work email',
                    type: 'email',
                    required: true,
                  },
                  {
                    id: 'consent',
                    label: 'I agree to be contacted',
                    type: 'checkbox',
                    required: true,
                    consent: true,
                  },
                ],
              },
              {
                id: 'join-waitlist',
                variant: 'secondary',
                kind: 'form',
                label: 'Join the waitlist',
                webhookId: 'crm-secondary',
                fields: [
                  {
                    id: 'company',
                    label: 'Company',
                    type: 'text',
                    required: true,
                  },
                ],
              },
              {
                id: 'restart',
                variant: 'secondary',
                kind: 'restart',
                label: 'Start again',
              },
            ],
            // This deprecated fallback is intentionally different: canonical
            // ctas must remain authoritative when both shapes are present.
            cta: {
              kind: 'form',
              label: 'Deprecated form',
              webhookId: 'crm',
              fields: [
                {
                  id: 'legacy-name',
                  label: 'Legacy name',
                  type: 'text',
                  required: true,
                },
              ],
            },
          },
          {
            id: 'step-legacy',
            kind: 'explanation',
            title: 'Legacy form',
            cta: {
              kind: 'form',
              label: 'Legacy request',
              webhookId: 'crm',
              fields: [
                {
                  id: 'name',
                  label: 'Name',
                  type: 'text',
                  required: true,
                },
              ],
            },
          },
          { id: 'step-no-cta', kind: 'explanation', title: 'No form here' },
        ],
      }),
      privacy: {
        status: 'clear',
        scannedAt: NOW.toISOString(),
        scannerVersion: '1.0.0',
        counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
        findings: [],
      },
      createdBy: 'author-1',
      now: NOW.toISOString(),
    });
    await repository.promoteRelease({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      release,
      idempotencyKey: 'seed',
      requestHash: 'd'.repeat(64),
      now: NOW.toISOString(),
    });

    const stale = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/analytics',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          id: 'event-stale',
          releaseId: 'release-old',
          sceneId: 'scene-1',
          type: 'view',
          occurredAt: NOW.toISOString(),
          properties: {},
        }),
      },
    );
    expect(stale.status).toBe(409);
    const unknownScene = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/analytics',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          id: 'event-unknown',
          releaseId: 'release-1',
          sceneId: 'scene-other',
          type: 'view',
          occurredAt: NOW.toISOString(),
          properties: {},
        }),
      },
    );
    expect(unknownScene.status).toBe(422);
    const unknownStep = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/analytics',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          id: 'event-unknown-step',
          releaseId: 'release-1',
          sceneId: 'scene-1',
          stepId: 'step-other',
          type: 'step',
          occurredAt: NOW.toISOString(),
          properties: {},
        }),
      },
    );
    expect(unknownStep.status).toBe(422);

    const analytics = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/analytics',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          id: 'event-1',
          releaseId: 'release-1',
          sceneId: 'scene-1',
          type: 'view',
          occurredAt: NOW.toISOString(),
          anonymousId: 'anonymous-user-123',
          sessionId: 'session-value-123',
          properties: { source: 'catalog' },
        }),
      },
    );
    expect(analytics.status).toBe(202);
    const storedEvent = repository.analytics.get('event-1')!;
    expect(storedEvent.anonymousIdHash).not.toContain('anonymous-user-123');
    expect(storedEvent.sessionIdHash).not.toContain('session-value-123');

    repository.analytics.clear();
    const analyticsFixture = [
      ['funnel-view-1', 'view', 'subject-1'],
      ['funnel-start-1', 'start', 'subject-1'],
      ['funnel-step-1a', 'step', 'subject-1'],
      ['funnel-step-1b', 'step', 'subject-1'],
      ['funnel-complete-1', 'complete', 'subject-1'],
      ['funnel-cta-1', 'cta', 'subject-1'],
      ['funnel-view-2', 'view', 'subject-2'],
      ['funnel-start-2', 'start', 'subject-2'],
      ['funnel-error-2', 'error', 'subject-2'],
    ] as const;
    for (const [id, type, sessionIdHash] of analyticsFixture) {
      await repository.ingestAnalytics({
        schemaVersion: 1,
        id,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        releaseId: 'release-1',
        sceneId: 'scene-1',
        stepId: 'step-1',
        type,
        occurredAt: NOW.toISOString(),
        sessionIdHash,
        properties: { deliberatelyExcludedFromAggregate: true },
      });
    }
    const memoryAggregateRows = await repository.aggregateAnalytics({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      releaseId: 'release-1',
      from: '2026-07-20T11:00:00.000Z',
      to: NOW.toISOString(),
    });
    expect(
      memoryAggregateRows.map(
        (row) => `${row.scope}:${row.sceneId ?? ''}:${row.stepId ?? ''}:${row.type}`,
      ),
    ).toEqual(
      ['total', 'scene', 'step'].flatMap((scope) =>
        ['complete', 'cta', 'error', 'start', 'step', 'view'].map(
          (type) =>
            `${scope}:${scope === 'total' ? '' : 'scene-1'}:${scope === 'step' ? 'step-1' : ''}:${type}`,
        ),
      ),
    );
    const funnelPath =
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-1/analytics/funnel';
    expect((await app.request(funnelPath)).status).toBe(401);
    expect(
      (
        await app.request(funnelPath, {
          headers: { authorization: `Bearer ${analyticsToken}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(`${funnelPath}?from=2026-01-01T00:00:00.000Z`, {
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).status,
    ).toBe(422);
    const funnelResponse = await app.request(funnelPath, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(funnelResponse.status).toBe(200);
    expect(funnelResponse.headers.get('cache-control')).toBe('private, no-store');
    const funnelBody = (await funnelResponse.json()) as Record<string, unknown>;
    expect(funnelBody).toMatchObject({
      funnel: {
        schemaVersion: 1,
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        channelId: 'channel-1',
        releaseId: 'release-1',
        rateBasis: 'accepted-events',
        totals: {
          events: { view: 2, start: 2, step: 2, complete: 1, cta: 1, error: 1 },
          uniqueSubjects: { view: 2, start: 2, step: 1, complete: 1, cta: 1, error: 1 },
          rates: {
            startPerView: 1,
            completionPerView: 0.5,
            completionPerStart: 0.5,
            dropoffPerView: 0.5,
            ctaPerView: 0.5,
            errorPerView: 0.5,
          },
        },
        scenes: [
          {
            sceneId: 'scene-1',
            steps: [
              {
                stepId: 'step-1',
                reaches: 4,
                rates: {
                  reachPerSceneView: 2,
                  completionPerReach: 0.25,
                  dropoffPerReach: 0.75,
                  ctaPerReach: 0.25,
                  errorPerReach: 0.25,
                },
              },
            ],
          },
        ],
        ctas: [
          {
            sceneId: 'scene-1',
            stepId: 'step-1',
            events: 1,
            uniqueSubjects: 1,
            conversionPerReach: 0.25,
          },
        ],
      },
    });
    expect(JSON.stringify(funnelBody)).not.toMatch(
      /subject-1|subject-2|deliberatelyExcludedFromAggregate/u,
    );

    const disallowedWebhook = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/cta',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'cta-disallowed',
          releaseId: 'release-1',
          sceneId: 'scene-1',
          stepId: 'step-1',
          ctaId: 'request-access',
          webhookId: 'another-tenant-hook',
          fields: { consent: true },
        }),
      },
    );
    expect(disallowedWebhook.status).toBe(422);
    expect((await disallowedWebhook.json()) as object).toMatchObject({
      error: { code: 'webhook_not_allowed' },
    });

    const missingStep = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/cta',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'cta-missing-step',
          releaseId: 'release-1',
          sceneId: 'scene-1',
          webhookId: 'crm',
          fields: { email: 'person@example.com', consent: true },
        }),
      },
    );
    expect(missingStep.status).toBe(422);
    expect(await missingStep.json()).toMatchObject({ error: { code: 'validation_failed' } });

    for (const { id, stepId, ctaId, webhookId, fields, code } of [
      {
        id: 'cta-no-form',
        stepId: 'step-no-cta',
        ctaId: 'request-access',
        webhookId: 'crm',
        fields: { email: 'person@example.com', consent: true },
        code: 'cta_not_authored',
      },
      {
        id: 'cta-missing-id',
        stepId: 'step-1',
        ctaId: undefined,
        webhookId: 'crm',
        fields: { email: 'person@example.com', consent: true },
        code: 'cta_id_required',
      },
      {
        id: 'cta-unknown-id',
        stepId: 'step-1',
        ctaId: 'not-authored',
        webhookId: 'crm',
        fields: { email: 'person@example.com', consent: true },
        code: 'cta_not_authored',
      },
      {
        id: 'cta-not-form',
        stepId: 'step-1',
        ctaId: 'restart',
        webhookId: 'crm',
        fields: {},
        code: 'cta_not_form',
      },
      {
        id: 'cta-wrong-hook',
        stepId: 'step-1',
        ctaId: 'request-access',
        webhookId: 'crm-secondary',
        fields: { email: 'person@example.com', consent: true },
        code: 'cta_webhook_mismatch',
      },
      {
        id: 'cta-cross-form-fields',
        stepId: 'step-1',
        ctaId: 'join-waitlist',
        webhookId: 'crm-secondary',
        fields: { email: 'person@example.com', consent: true },
        code: 'cta_field_mismatch',
      },
      {
        id: 'cta-unknown-field',
        stepId: 'step-1',
        ctaId: 'request-access',
        webhookId: 'crm',
        fields: { email: 'person@example.com', consent: true, role: 'owner' },
        code: 'cta_field_mismatch',
      },
      {
        id: 'cta-missing-required',
        stepId: 'step-1',
        ctaId: 'request-access',
        webhookId: 'crm',
        fields: { email: 'person@example.com' },
        code: 'cta_field_required',
      },
      {
        id: 'cta-wrong-type',
        stepId: 'step-1',
        ctaId: 'request-access',
        webhookId: 'crm',
        fields: { email: true, consent: true },
        code: 'cta_field_type_mismatch',
      },
      {
        id: 'cta-no-consent',
        stepId: 'step-1',
        ctaId: 'request-access',
        webhookId: 'crm',
        fields: { email: 'person@example.com', consent: false },
        code: 'cta_consent_required',
      },
    ] as const) {
      const response = await app.request(
        '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/cta',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${analyticsToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            id,
            releaseId: 'release-1',
            sceneId: 'scene-1',
            stepId,
            ...(ctaId ? { ctaId } : {}),
            webhookId,
            fields,
          }),
        },
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code } });
    }

    const secondaryCta = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/cta',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'cta-secondary',
          releaseId: 'release-1',
          sceneId: 'scene-1',
          stepId: 'step-1',
          ctaId: 'join-waitlist',
          webhookId: 'crm-secondary',
          fields: { company: 'Acme' },
        }),
      },
    );
    expect(secondaryCta.status).toBe(202);
    expect(repository.submissions.get('cta-secondary')).toMatchObject({
      ctaId: 'join-waitlist',
      webhookId: 'crm-secondary',
    });

    const legacyCta = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/cta',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'cta-legacy',
          releaseId: 'release-1',
          sceneId: 'scene-1',
          stepId: 'step-legacy',
          webhookId: 'crm',
          fields: { name: 'Ada' },
        }),
      },
    );
    expect(legacyCta.status).toBe(202);
    expect(repository.submissions.get('cta-legacy')).toMatchObject({
      ctaId: 'step-legacy-cta',
      webhookId: 'crm',
    });

    const cta = await app.request(
      '/v1/public/workspaces/workspace-1/projects/project-1/channels/channel-1/cta',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'cta-1',
          releaseId: 'release-1',
          sceneId: 'scene-1',
          stepId: 'step-1',
          ctaId: 'request-access',
          webhookId: 'crm',
          fields: { email: 'person@example.com', consent: true },
        }),
      },
    );
    expect(cta.status).toBe(202);
    const submission = repository.submissions.get('cta-1')!;
    expect(submission.ctaId).toBe('request-access');
    expect(submission.encryptedPayload).not.toContain('person@example.com');
    expect(submission.payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(submission.payloadHash).not.toBe(
      sha256(
        stableStringify({
          schemaVersion: 1,
          id: 'cta-1',
          releaseId: 'release-1',
          sceneId: 'scene-1',
          stepId: 'step-1',
          ctaId: 'request-access',
          fields: { email: 'person@example.com', consent: true },
          createdAt: NOW.toISOString(),
        }),
      ),
    );
  });

  it('caps JSON bodies before parsing', async () => {
    const { app } = await fixture();
    const response = await app.request(
      '/v1/admin/workspaces',
      admin({ slug: 'oversized', name: 'x'.repeat(200_000) }),
    );
    expect(response.status).toBe(413);
  });

  it('keeps a partially promoted upload retryable and finalizes it on retry', async () => {
    let promotions = 0;
    const { app, repository } = await fixture({
      storeFactory: (root) => {
        const base = new FileSystemObjectStore(root);
        return {
          health: () => base.health(),
          putStaged: (...arguments_) => base.putStaged(...arguments_),
          putStagedStream: (...arguments_) => base.putStagedStream(...arguments_),
          verify: (object) => base.verify(object),
          read: (object) => base.read(object),
          deleteStaged: (object) => base.deleteStaged(object),
          promote: async (object, workspaceId) => {
            promotions += 1;
            if (promotions === 2) throw new Error('simulated object-store interruption');
            return base.promote(object, workspaceId);
          },
        } satisfies ImmutableObjectStore;
      },
    });
    await bootstrap(app);
    const token = await new UploadTokenService(SECRET).issue(
      {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: oidcClaims.repository,
        commit: oidcClaims.commit,
        ref: oidcClaims.ref,
        workflowRef: oidcClaims.workflowRef,
        permissions: ['artifact:write'],
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 300,
        tokenId: 'retry-token',
      },
      Math.floor(NOW.getTime() / 1_000),
    );
    const payloads = [new TextEncoder().encode('first'), new TextEncoder().encode('second')];
    const objects = payloads.map((bytes) => ({
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      mediaType: 'text/plain',
    }));
    const begin = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'partial-promotion',
      },
      body: JSON.stringify({ objects }),
    });
    const uploadId = ((await begin.json()) as { upload: { id: string } }).upload.id;
    for (const [index, object] of objects.entries()) {
      expect(
        (
          await app.request(`/v1/uploads/${uploadId}/objects/${object.sha256}`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${token}`, 'content-type': object.mediaType },
            body: payloads[index],
          })
        ).status,
      ).toBe(200);
    }
    const manifest = { schemaVersion: 1, objects, metadata: {} };
    const request = () =>
      app.request(`/v1/uploads/${uploadId}/finalize`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ manifest }),
      });
    expect((await request()).status).toBe(503);
    expect((await repository.getUpload(uploadId))?.status).toBe('staged');
    expect((await request()).status).toBe(200);
    expect((await repository.getUpload(uploadId))?.status).toBe('finalized');
  });

  it('derives publication readiness only from immutable, actor-bound evidence', async () => {
    const { app, repository, uploadTokens } = await fixture();
    await bootstrap(app);
    const policy = {
      requireCriticalPassing: true,
      requireVisualApproval: true,
      requireEditorialApproval: true,
      requireCompleteLocalization: false,
      publication: 'manual' as const,
      nonCriticalFailure: 'block' as const,
    };
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/channels',
          admin({
            id: 'channel-integrity',
            slug: 'integrity',
            name: 'Integrity',
            kind: 'public-catalog',
            webhookIds: [],
            policy,
          }),
        )
      ).status,
    ).toBe(201);

    const sceneResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/scenes/revisions',
      admin({
        scene: {
          schemaVersion: 1,
          id: 'scene-integrity',
          title: 'Release integrity',
          slug: 'release-integrity',
          criticality: 'critical',
          steps: [{ id: 'step-integrity', kind: 'explanation', title: 'Verified output' }],
        },
        privacy: {
          status: 'clear',
          scannedAt: NOW.toISOString(),
          scannerVersion: '1.0.0',
          counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
          findings: [],
        },
      }),
    );
    expect(sceneResponse.status).toBe(201);
    const sourceRevision = ((await sceneResponse.json()) as { revision: { revision: string } })
      .revision.revision;
    const privacy = {
      status: 'clear' as const,
      scannedAt: NOW.toISOString(),
      scannerVersion: '1.0.0',
      counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
      findings: [],
    };
    const screenshotHash = '9'.repeat(64);
    const state = {
      id: 'state-integrity',
      sceneId: 'scene-integrity',
      stepId: 'step-integrity',
      phase: 'after' as const,
      capturedAt: NOW.toISOString(),
      route: '/verified',
      viewport: { width: 1280, height: 720 },
      screenshot: {
        sha256: screenshotHash,
        path: `assets/${screenshotHash}.png`,
        mediaType: 'image/png',
        byteLength: 1,
        role: 'screenshot',
      },
      screenshotHash,
      privacy,
    };
    const beforeState = {
      ...state,
      id: 'state-integrity-before',
      phase: 'before' as const,
    };
    const run = {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'run-integrity',
      kind: 'run' as const,
      projectId: 'project-1',
      sceneId: 'scene-integrity',
      runTargetId: 'primary',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      repository: { repository: 'acme/product', commit: oidcClaims.commit },
      sourceRevision,
      status: 'passed' as const,
      changeState: 'passed' as const,
      expectedStepIds: ['step-integrity'],
      attempts: [
        {
          id: 'attempt-integrity',
          index: 0,
          status: 'passed' as const,
          startedAt: NOW.toISOString(),
          endedAt: NOW.toISOString(),
          durationMs: 10,
          checks: [
            {
              checkId: 'check-integrity',
              stepId: 'step-integrity',
              status: 'passed' as const,
              message: 'Playwright verified the release output.',
              source: { path: 'tests/release.spec.ts', line: 10, column: 3 },
            },
          ],
          states: [beforeState, state],
          privacy,
        },
      ],
      selectedAttemptId: 'attempt-integrity',
      startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
      durationMs: 10,
      privacy,
    };
    const vacuousRunResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
      admin(
        {
          run: {
            ...run,
            id: 'run-integrity-vacuous',
            attempts: [{ ...run.attempts[0], checks: [] }],
          },
        },
        { 'idempotency-key': 'evidence-run-integrity-vacuous' },
      ),
    );
    expect(vacuousRunResponse.status).toBe(422);
    expect(await vacuousRunResponse.json()).toMatchObject({
      error: { code: 'run_execution_evidence_missing' },
    });
    const retryRecoveredRunResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
      admin(
        {
          run: {
            ...run,
            id: 'run-integrity-retry-recovered',
            attempts: [
              {
                ...run.attempts[0],
                id: 'attempt-integrity-initial-failure',
                index: 0,
                retry: 0,
                status: 'failed',
                checks: run.attempts[0]!.checks.map((check) => ({
                  ...check,
                  status: 'failed' as const,
                })),
              },
              {
                ...run.attempts[0],
                id: 'attempt-integrity-retry-pass',
                index: 1,
                retry: 1,
              },
            ],
            selectedAttemptId: 'attempt-integrity-retry-pass',
          },
        },
        { 'idempotency-key': 'evidence-run-integrity-retry-recovered' },
      ),
    );
    expect(retryRecoveredRunResponse.status).toBe(422);
    expect(await retryRecoveredRunResponse.json()).toMatchObject({
      error: { code: 'run_retry_state_mismatch' },
    });
    const runResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
      admin({ run }, { 'idempotency-key': 'evidence-run-integrity' }),
    );
    expect(runResponse.status).toBe(201);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
          admin({ run }, { 'idempotency-key': 'evidence-run-integrity' }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
          admin(
            { run: { ...run, createdAt: '2026-07-20T12:00:01.000Z' } },
            { 'idempotency-key': 'evidence-run-integrity' },
          ),
        )
      ).status,
    ).toBe(409);
    const runRecord = (await runResponse.json()) as {
      run: {
        id: string;
        artifactHash: string;
        run: typeof run & { repository: { provider: string; dirty: boolean } };
      };
    };

    const build = {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'build-integrity',
      kind: 'build' as const,
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      repository: runRecord.run.run.repository,
      trigger: 'release' as const,
      status: 'passed' as const,
      expectedRunPlan: [{ sceneId: 'scene-integrity', runTargetId: 'primary', required: true }],
      runs: [
        {
          sceneId: 'scene-integrity',
          runTargetId: 'primary',
          required: true,
          run: { id: 'run-integrity', kind: 'run' as const, sha256: runRecord.run.artifactHash },
          status: 'passed' as const,
          changeState: 'passed' as const,
        },
      ],
      startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
      summary: { total: 1, passed: 1, changed: 0, broken: 0, blocked: 0, pending: 0 },
    };
    const buildResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/builds',
      admin({ build }, { 'idempotency-key': 'evidence-build-integrity' }),
    );
    expect(buildResponse.status).toBe(201);

    const normalizedStates = runRecord.run.run.attempts[0]!.states.map((normalizedState) => ({
      sceneId: normalizedState.sceneId,
      stepId: normalizedState.stepId,
      phase: normalizedState.phase,
      stateId: normalizedState.id,
      screenshot: normalizedState.screenshot,
      screenshotHash: normalizedState.screenshotHash,
      route: normalizedState.route,
      viewport: normalizedState.viewport,
      privacy: normalizedState.privacy,
    }));
    const baseline = {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'baseline-integrity',
      kind: 'baseline' as const,
      projectId: 'project-1',
      sceneId: 'scene-integrity',
      runTargetId: 'primary',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      sourceRunId: 'run-integrity',
      sourceAttemptId: 'attempt-integrity',
      sourceRevision,
      completeness: 'complete' as const,
      sourceRunStatus: 'passed' as const,
      expectedStepIds: ['step-integrity'],
      states: normalizedStates,
      checks: runRecord.run.run.attempts[0]!.checks,
      checksHash: sha256(stableStringify(runRecord.run.run.attempts[0]!.checks)),
      approvals: [
        {
          id: 'baseline-author-approval',
          kind: 'visual' as const,
          decision: 'approved' as const,
          actorId: 'admin',
          createdAt: NOW.toISOString(),
          revision: sourceRevision,
        },
      ],
    };
    const incompleteBaselineResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/baselines',
      admin(
        {
          baseline: {
            ...baseline,
            id: 'baseline-integrity-incomplete',
            states: [baseline.states[0]!],
          },
        },
        { 'idempotency-key': 'evidence-baseline-integrity-incomplete' },
      ),
    );
    expect(incompleteBaselineResponse.status).toBe(422);
    expect(await incompleteBaselineResponse.json()).toMatchObject({
      error: { code: 'baseline_state_mismatch' },
    });
    const baselineResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/baselines',
      admin({ baseline }, { 'idempotency-key': 'evidence-baseline-integrity' }),
    );
    expect(baselineResponse.status).toBe(201);
    const baselineRecord = (await baselineResponse.json()) as {
      baseline: { id: string; artifactHash: string };
    };

    const releaseBytes = new TextEncoder().encode('verified release bytes');
    const duplicateFromAnotherCommit = await finalizePublication(app, uploadTokens, {
      commit: 'b'.repeat(40),
      tokenId: 'integrity-object-wrong-commit-token',
      uploadKey: 'integrity-object-wrong-commit-upload',
      bytes: releaseBytes,
      sceneId: 'scene-integrity',
      sourceRevision,
    });
    const published = await finalizePublication(app, uploadTokens, {
      commit: oidcClaims.commit,
      tokenId: 'integrity-object-token',
      uploadKey: 'integrity-object-upload',
      bytes: releaseBytes,
      sceneId: 'scene-integrity',
      sourceRevision,
    });
    const tamperedArchive = await finalizePublication(app, uploadTokens, {
      commit: oidcClaims.commit,
      tokenId: 'integrity-tampered-archive-token',
      uploadKey: 'integrity-tampered-archive-upload',
      bytes: releaseBytes,
      archiveOutputBytes: new TextEncoder().encode('caller replaced the archived output'),
      sceneId: 'scene-integrity',
      sourceRevision,
    });
    const missingEvidence = await finalizePublication(app, uploadTokens, {
      commit: oidcClaims.commit,
      tokenId: 'integrity-missing-evidence-token',
      uploadKey: 'integrity-missing-evidence-upload',
      bytes: releaseBytes,
      omitEvidenceFile: true,
      sceneId: 'scene-integrity',
      sourceRevision,
    });
    expect(duplicateFromAnotherCommit.manifestHash).toBe(published.manifestHash);
    const candidate = {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'release-integrity',
      kind: 'release' as const,
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      channelId: 'channel-integrity',
      sourceBuildId: 'build-integrity',
      scenes: [
        {
          sceneId: 'scene-integrity',
          sourceRevision,
          outputs: [published.output],
        },
      ],
      manifestHash: published.manifestHash,
      publication: published.publication,
    };
    const approvalPath = '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/approvals';
    const visualResponse = await app.request(
      approvalPath,
      admin(
        {
          id: 'visual-integrity',
          kind: 'visual',
          decision: 'approved',
          baselineId: baselineRecord.baseline.id,
        },
        { 'idempotency-key': 'approval-visual-integrity', 'x-scenebook-actor': 'attacker' },
      ),
    );
    expect(visualResponse.status).toBe(201);
    expect(
      ((await visualResponse.json()) as { approval: { recordedBy: string } }).approval.recordedBy,
    ).toBe('admin');
    expect(
      (
        await app.request(
          approvalPath,
          admin(
            {
              id: 'actor-spoof',
              kind: 'editorial',
              decision: 'approved',
              baselineId: baselineRecord.baseline.id,
              actorId: 'attacker',
            },
            { 'idempotency-key': 'approval-actor-spoof' },
          ),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(
          approvalPath,
          admin(
            {
              id: 'editorial-integrity',
              kind: 'editorial',
              decision: 'approved',
              baselineId: baselineRecord.baseline.id,
            },
            { 'idempotency-key': 'approval-editorial-integrity' },
          ),
        )
      ).status,
    ).toBe(201);
    const validOutput = candidate.scenes[0]!.outputs[0]!;
    const expectReleaseBindingRejected = async (id: string, release: unknown, code: string) => {
      const response = await app.request(
        approvalPath,
        admin(
          { id: `approval-${id}`, kind: 'release', decision: 'approved', release },
          { 'idempotency-key': `approval-${id}` },
        ),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code } });
    };
    await expectReleaseBindingRejected(
      'wrong-output-digest',
      {
        ...candidate,
        id: 'release-wrong-output-digest',
        scenes: [
          {
            ...candidate.scenes[0],
            outputs: [{ ...validOutput, asset: { ...validOutput.asset, sha256: 'f'.repeat(64) } }],
          },
        ],
      },
      'release_manifest_mismatch',
    );
    await expectReleaseBindingRejected(
      'wrong-output-length',
      {
        ...candidate,
        id: 'release-wrong-output-length',
        scenes: [
          {
            ...candidate.scenes[0],
            outputs: [
              {
                ...validOutput,
                asset: { ...validOutput.asset, byteLength: validOutput.asset.byteLength + 1 },
              },
            ],
          },
        ],
      },
      'release_manifest_mismatch',
    );
    await expectReleaseBindingRejected(
      'wrong-output-media',
      {
        ...candidate,
        id: 'release-wrong-output-media',
        scenes: [
          {
            ...candidate.scenes[0],
            outputs: [{ ...validOutput, asset: { ...validOutput.asset, mediaType: 'text/plain' } }],
          },
        ],
      },
      'release_manifest_mismatch',
    );
    await expectReleaseBindingRejected(
      'wrong-output-path',
      {
        ...candidate,
        id: 'release-wrong-output-path',
        scenes: [
          {
            ...candidate.scenes[0],
            outputs: [
              {
                ...validOutput,
                asset: { ...validOutput.asset, path: 'scenes/scene-integrity/other.html' },
              },
            ],
          },
        ],
      },
      'release_manifest_mismatch',
    );
    await expectReleaseBindingRejected(
      'wrong-entrypoint',
      {
        ...candidate,
        id: 'release-wrong-entrypoint',
        scenes: [
          {
            ...candidate.scenes[0],
            outputs: [{ ...validOutput, entrypoint: 'scenes/scene-integrity/other.html' }],
          },
        ],
      },
      'release_manifest_mismatch',
    );
    await expectReleaseBindingRejected(
      'wrong-output-format',
      {
        ...candidate,
        id: 'release-wrong-output-format',
        scenes: [
          { ...candidate.scenes[0], outputs: [{ ...validOutput, format: 'standalone-html' }] },
        ],
      },
      'release_manifest_mismatch',
    );
    await expectReleaseBindingRejected(
      'wrong-scene-revision',
      {
        ...candidate,
        id: 'release-wrong-scene-revision',
        scenes: [{ ...candidate.scenes[0], sourceRevision: 'e'.repeat(64) }],
      },
      'release_manifest_mismatch',
    );
    await expectReleaseBindingRejected(
      'wrong-scene-set',
      {
        ...candidate,
        id: 'release-wrong-scene-set',
        scenes: [...candidate.scenes, { ...candidate.scenes[0], sceneId: 'invented-scene' }],
      },
      'release_manifest_mismatch',
    );
    await expectReleaseBindingRejected(
      'wrong-tree-hash',
      {
        ...candidate,
        id: 'release-wrong-tree-hash',
        publication: { ...candidate.publication, treeHash: 'f'.repeat(64) },
      },
      'publication_integrity_mismatch',
    );
    await expectReleaseBindingRejected(
      'tampered-archive-member',
      {
        ...candidate,
        id: 'release-tampered-archive-member',
        manifestHash: tamperedArchive.manifestHash,
        publication: tamperedArchive.publication,
        scenes: [{ ...candidate.scenes[0], outputs: [tamperedArchive.output] }],
      },
      'publication_archive_mismatch',
    );
    await expectReleaseBindingRejected(
      'missing-evidence-reference',
      {
        ...candidate,
        id: 'release-missing-evidence-reference',
        manifestHash: missingEvidence.manifestHash,
        publication: missingEvidence.publication,
        scenes: [{ ...candidate.scenes[0], outputs: [missingEvidence.output] }],
      },
      'publication_integrity_mismatch',
    );
    expect(
      (
        await app.request(
          approvalPath,
          admin(
            {
              id: 'release-integrity-approval',
              kind: 'release',
              decision: 'approved',
              release: candidate,
            },
            { 'idempotency-key': 'approval-release-integrity' },
          ),
        )
      ).status,
    ).toBe(201);

    const releasePath =
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-integrity/releases';
    const evidence = {
      releaseApprovalId: 'release-integrity-approval',
      scenes: [
        {
          sceneId: 'scene-integrity',
          runId: 'run-integrity',
          baselineId: 'baseline-integrity',
          visualApprovalId: 'visual-integrity',
          editorialApprovalId: 'editorial-integrity',
        },
      ],
    };
    const callerPass = await app.request(
      releasePath,
      admin(
        {
          release: candidate,
          evidence,
          readiness: [
            {
              sceneId: 'scene-integrity',
              criticality: 'critical',
              status: 'passed',
              visualApproved: true,
              editorialApproved: true,
              localizationComplete: true,
            },
          ],
        },
        { 'idempotency-key': 'caller-pass-claim' },
      ),
    );
    expect(callerPass.status).toBe(422);
    const selfApproved = await app.request(
      releasePath,
      admin(
        {
          release: {
            ...candidate,
            approvals: [
              {
                id: 'self-approved',
                kind: 'release',
                decision: 'approved',
                actorId: 'attacker',
                createdAt: NOW.toISOString(),
                revision: sourceRevision,
              },
            ],
          },
          evidence,
        },
        { 'idempotency-key': 'self-approved-release' },
      ),
    );
    expect(selfApproved.status).toBe(422);
    expect(
      (
        await app.request(
          releasePath,
          admin(
            { release: candidate, evidence: { ...evidence, releaseApprovalId: 'invented' } },
            { 'idempotency-key': 'invented-approval' },
          ),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(
          releasePath,
          admin(
            {
              release: candidate,
              evidence: {
                ...evidence,
                scenes: [{ ...evidence.scenes[0], runId: 'run-invented' }],
              },
            },
            { 'idempotency-key': 'invented-run' },
          ),
        )
      ).status,
    ).toBe(422);

    const mismatchedCandidate = {
      ...candidate,
      id: 'release-mismatched-revision',
      scenes: [{ ...candidate.scenes[0], sourceRevision: '8'.repeat(64) }],
    };
    const mismatched = await app.request(
      approvalPath,
      admin(
        {
          release: mismatchedCandidate,
          id: 'release-mismatched-approval',
          kind: 'release',
          decision: 'approved',
        },
        { 'idempotency-key': 'approval-mismatched-revision' },
      ),
    );
    expect(mismatched.status).toBe(422);
    expect(await mismatched.json()).toMatchObject({ error: { code: 'release_manifest_mismatch' } });

    const stale = await finalizePublication(app, uploadTokens, {
      commit: 'b'.repeat(40),
      tokenId: 'stale-object-token',
      uploadKey: 'stale-object-upload',
      bytes: new TextEncoder().encode('stale release bytes'),
      sceneId: 'scene-integrity',
      sourceRevision,
    });
    const staleCandidate = {
      ...candidate,
      id: 'release-stale',
      manifestHash: stale.manifestHash,
      publication: stale.publication,
      scenes: [
        {
          ...candidate.scenes[0],
          outputs: [stale.output],
        },
      ],
    };
    const staleApproval = await app.request(
      approvalPath,
      admin(
        {
          id: 'release-stale-approval',
          kind: 'release',
          decision: 'approved',
          release: staleCandidate,
        },
        { 'idempotency-key': 'approval-release-stale' },
      ),
    );
    expect(staleApproval.status).toBe(422);
    expect(await staleApproval.json()).toMatchObject({
      error: { code: 'unknown_manifest' },
    });

    const promoted = await app.request(
      releasePath,
      admin({ release: candidate, evidence }, { 'idempotency-key': 'valid-promotion' }),
    );
    expect(promoted.status).toBe(201);
    expect(await promoted.json()).toMatchObject({
      release: {
        id: 'release-integrity',
        status: 'published',
        scenes: [{ baselineId: 'baseline-integrity', carriedForward: false }],
        approvals: [{ id: 'release-integrity-approval', actorId: 'admin' }],
      },
      policy: { allowed: true },
    });
    expect(
      (await repository.getRelease('workspace-1', 'project-1', 'release-integrity'))
        ?.promotionEvidence,
    ).toMatchObject({
      buildId: 'build-integrity',
      releaseApprovalId: 'release-integrity-approval',
      artifactUploadId: expect.any(String),
      scenes: [
        {
          sceneId: 'scene-integrity',
          runId: 'run-integrity',
          baselineId: 'baseline-integrity',
          visualApprovalId: 'visual-integrity',
          editorialApprovalId: 'editorial-integrity',
        },
      ],
    });
    expect(repository.audits.some((event) => event.action === 'release.promoted')).toBe(true);
  });
});
