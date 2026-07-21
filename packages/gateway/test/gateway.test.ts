import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { canonicalJsonHash, sha256 } from '@scenebook/core';
import {
  FileSystemObjectStore,
  IdentityTokenService,
  IdentityTokenVerifier,
} from '@scenebook/server';
import { MemoryControlPlaneRepository } from '@scenebook/server/testing';
import { PublicationInventorySchema, ReleaseSchema, type PublicationFile } from '@scenebook/schema';
import { Zip, ZipDeflate } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import { createPublicationGatewayApp } from '../src/app.js';
import {
  PublicationBootstrapRejectedError,
  type PublicationBootstrapAuthorization,
  type PublicationBootstrapClient,
} from '../src/bootstrap.js';
import { PortalSessionService } from '../src/session.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const IDENTITY_SECRET = 'identity-secret-'.padEnd(64, 'i');
const SESSION_SECRET = 'gateway-session-'.padEnd(64, 'g');
const identityKeyPair = generateKeyPairSync('ed25519');
const IDENTITY_PRIVATE_KEY = identityKeyPair.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64');
const IDENTITY_PUBLIC_KEY = identityKeyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deterministicArchive(
  files: readonly PublicationFile[],
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let failure: unknown;
  const zip = new Zip((error, bytes) => {
    if (error) failure = error;
    else chunks.push(bytes);
  });
  for (const file of files) {
    const entry = new ZipDeflate(file.path, { level: 9 });
    entry.mtime = new Date(1980, 0, 1, 0, 0, 0, 0);
    entry.os = 3;
    entry.attrs = (0o100644 << 16) >>> 0;
    zip.add(entry);
    entry.push(bytesByPath.get(file.path)!, true);
  }
  zip.end();
  if (failure) throw failure;
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

class FakeBootstrapClient implements PublicationBootstrapClient {
  readonly authorizations = new Map<string, PublicationBootstrapAuthorization>();
  readonly requests: { credential: string; audienceOrigin: string }[] = [];

  async consume(
    credential: string,
    audienceOrigin: string,
  ): Promise<PublicationBootstrapAuthorization> {
    this.requests.push({ credential, audienceOrigin });
    const authorization = this.authorizations.get(credential);
    if (!authorization || authorization.audienceOrigin !== audienceOrigin) {
      throw new PublicationBootstrapRejectedError();
    }
    this.authorizations.delete(credential);
    return authorization;
  }
}

async function fixture(
  kind: 'public-catalog' | 'private-portal' = 'public-catalog',
  options: { oversizedMemberBytes?: number; maxMemberBytes?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-gateway-test-'));
  roots.push(root);
  const objectStore = new FileSystemObjectStore(join(root, 'objects'));
  const repository = new MemoryControlPlaneRepository();
  const policy = {
    requireCriticalPassing: true,
    requireVisualApproval: true,
    requireEditorialApproval: true,
    requireCompleteLocalization: false,
    publication: 'manual' as const,
    nonCriticalFailure: 'block' as const,
  };
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
  await repository.createChannel({
    id: 'channel-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    slug: kind === 'private-portal' ? 'private' : 'public',
    name: kind === 'private-portal' ? 'Private' : 'Public',
    kind,
    policy,
    webhookIds: [],
    analyticsTokenHash: 'a'.repeat(64),
    now: NOW.toISOString(),
  });
  const bytesByPath = new Map<string, Uint8Array>([
    [
      'embeds/demo.iframe.html',
      new TextEncoder().encode(
        '<!doctype html><iframe src="../standalone/demo.html"></iframe><script>window.parent.postMessage("ready","*")</script>',
      ),
    ],
    [
      'index.html',
      new TextEncoder().encode(
        '<!doctype html><style>body{color:#123}</style><h1>Catalog</h1><script>document.body.dataset.ready="yes"</script>',
      ),
    ],
    [
      'manifest.json',
      new TextEncoder().encode(
        JSON.stringify({
          format: 'scenebook-catalog',
          version: 1,
          privacy: { status: 'passed', scanner: 'test' },
          scenes: [],
        }),
      ),
    ],
    ['transcript.txt', new TextEncoder().encode('portable transcript')],
  ]);
  if (options.oversizedMemberBytes) {
    bytesByPath.set('assets/oversized.bin', new Uint8Array(options.oversizedMemberBytes).fill(7));
  }
  const files = [...bytesByPath.entries()]
    .map(([path, bytes]) => ({
      path,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      mediaType: path.endsWith('.html')
        ? 'text/html'
        : path.endsWith('.json')
          ? 'application/json'
          : 'text/plain',
    }))
    .sort((left, right) => left.path.localeCompare(right.path)) as PublicationFile[];
  const archive = deterministicArchive(files, bytesByPath);
  const inventory = PublicationInventorySchema.parse({
    format: 'scenebook-publication-archive',
    version: 1,
    archive: {
      sha256: sha256(archive),
      byteLength: archive.byteLength,
      mediaType: 'application/zip',
    },
    treeHash: canonicalJsonHash({ files }),
    byteLength: files.reduce((sum, file) => sum + file.byteLength, 0),
    compilerManifest: files.find((file) => file.path === 'manifest.json'),
    files,
  });
  const inventoryBytes = new TextEncoder().encode(JSON.stringify(inventory));
  const stagedArchive = await objectStore.putStaged(
    'upload-archive',
    sha256(archive),
    archive,
    'application/zip',
  );
  await objectStore.promote(stagedArchive, 'workspace-1');
  const stagedInventory = await objectStore.putStaged(
    'upload-inventory',
    sha256(inventoryBytes),
    inventoryBytes,
    'application/json',
  );
  await objectStore.promote(stagedInventory, 'workspace-1');
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
        sourceRevision: 'b'.repeat(64),
        outputs: [
          {
            format: 'catalog',
            asset: {
              sha256: files.find((file) => file.path === 'index.html')!.sha256,
              path: 'index.html',
              mediaType: 'text/html',
              byteLength: files.find((file) => file.path === 'index.html')!.byteLength,
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
        actorId: 'owner-1',
        createdAt: NOW.toISOString(),
        revision: 'c'.repeat(64),
      },
    ],
    manifestHash: 'd'.repeat(64),
    publication: {
      archive: inventory.archive,
      inventory: {
        sha256: sha256(inventoryBytes),
        byteLength: inventoryBytes.byteLength,
        mediaType: 'application/json',
      },
      compilerManifest: {
        sha256: inventory.compilerManifest.sha256,
        byteLength: inventory.compilerManifest.byteLength,
        mediaType: 'application/json',
      },
      treeHash: inventory.treeHash,
    },
  });
  repository.releases.set(release.id, {
    release,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    idempotencyKey: 'release-1',
    requestHash: 'e'.repeat(64),
  });
  repository.channels.set('channel-1', {
    ...repository.channels.get('channel-1')!,
    currentReleaseId: release.id,
    sequence: 1,
  });
  const identityTokens = new IdentityTokenService({
    apiTokenHashSecret: IDENTITY_SECRET,
    signingPrivateKey: IDENTITY_PRIVATE_KEY,
    verificationPublicKey: IDENTITY_PUBLIC_KEY,
  });
  const bootstrapClient = new FakeBootstrapClient();
  const app = createPublicationGatewayApp({
    repository,
    objectStore,
    identityVerifier: new IdentityTokenVerifier(IDENTITY_PUBLIC_KEY),
    portalSessions: new PortalSessionService(SESSION_SECRET),
    bootstrapClient,
    config: {
      nodeEnv: 'test',
      publicationBaseUrl: 'http://publish.example',
      controlPlaneBaseUrl: 'http://control.example',
      sessionTtlSeconds: 3_600,
      maxJsonBytes: 16 * 1024,
      maxMemberBytes: options.maxMemberBytes ?? 4 * 1024 * 1024,
      maxCacheBytes: 8 * 1024 * 1024,
      maxConcurrentResponses: 4,
      temporaryRoot: join(root, 'temporary'),
    },
    now: () => new Date(NOW),
  });
  return { app, repository, identityTokens, files, objectStore, bootstrapClient };
}

describe('publication gateway', () => {
  it('renders safe, useful document errors while preserving JSON error contracts', async () => {
    const { app } = await fixture();
    const browserResponse = await app.request(
      'http://publish.example/s/acme/product/public/missing.html',
      {
        headers: { host: 'publish.example', accept: 'text/html' },
      },
    );
    expect(browserResponse.status).toBe(404);
    expect(browserResponse.headers.get('content-type')).toContain('text/html');
    expect(browserResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await browserResponse.text()).toContain('Publication not found');

    const apiResponse = await app.request(
      'http://publish.example/s/acme/product/public/missing.html',
      { headers: { host: 'publish.example', accept: 'application/json' } },
    );
    expect(apiResponse.status).toBe(404);
    expect(apiResponse.headers.get('content-type')).toContain('application/json');
    expect(await apiResponse.json()).toMatchObject({
      error: { code: 'publication_member_not_found' },
    });

    const headResponse = await app.request(
      'http://publish.example/s/acme/product/public/missing.html',
      { method: 'HEAD', headers: { host: 'publish.example', accept: 'text/html' } },
    );
    expect(headResponse.status).toBe(404);
    expect(await headResponse.text()).toBe('');
  });

  it('gives private-access shells live status and a recovery path', async () => {
    const { app } = await fixture('private-portal');
    for (const path of ['/share', '/login']) {
      const response = await app.request(`http://publish.example${path}`, {
        headers: { host: 'publish.example' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('Open the most recent invitation');
      expect(html).toContain('<noscript>');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('rejects declared and chunked JSON bodies at the incremental byte limit', async () => {
    const { app, bootstrapClient } = await fixture('private-portal');
    const declared = await app.request('http://publish.example/_scenebook/auth/bootstrap', {
      method: 'POST',
      headers: {
        host: 'publish.example',
        origin: 'http://publish.example',
        'content-type': 'application/json',
        'content-length': String(16 * 1024 + 1),
      },
      body: '{}',
    });
    expect(declared.status).toBe(413);

    let cancelled = false;
    let chunk = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk++ < 3) {
          controller.enqueue(new Uint8Array(8 * 1024).fill(0x20));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const chunked = await app.request(
      new Request('http://publish.example/_scenebook/auth/bootstrap', {
        method: 'POST',
        headers: {
          host: 'publish.example',
          origin: 'http://publish.example',
          'content-type': 'application/json',
        },
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(chunked.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(bootstrapClient.requests).toHaveLength(0);
  });

  it('serves current public catalogs with strict binding, CSP, MIME, ETag, HEAD, and ranges', async () => {
    const { app, files, objectStore } = await fixture();
    let archiveReads = 0;
    const readStream = objectStore.readStream.bind(objectStore);
    objectStore.readStream = async function* (object) {
      archiveReads += 1;
      yield* readStream(object);
    };
    const response = await app.request('http://publish.example/s/acme/product/public/', {
      headers: { host: 'publish.example' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).toContain('<h1>Catalog</h1>');
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'sha256-");
    expect(response.headers.get('content-security-policy')).not.toContain(
      "script-src 'unsafe-inline'",
    );
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('x-scenebook-release-id')).toBe('release-1');
    expect([...response.headers.values()].join(' ')).not.toContain(
      'workspaces/workspace-1/objects',
    );

    const descriptor = files.find((file) => file.path === 'transcript.txt')!;
    const range = await app.request('http://publish.example/s/acme/product/public/transcript.txt', {
      headers: { host: 'publish.example', range: 'bytes=0-7' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 0-7/${descriptor.byteLength}`);
    expect(await range.text()).toBe('portable');
    expect(archiveReads).toBe(1);

    const embed = await app.request(
      'http://publish.example/s/acme/product/public/embeds/demo.iframe.html',
      { headers: { host: 'publish.example' } },
    );
    expect(embed.status).toBe(200);
    expect(embed.headers.get('content-security-policy')).toContain('frame-ancestors *');
    expect(embed.headers.get('x-frame-options')).toBeNull();
    expect(embed.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    await embed.text();

    const head = await app.request('http://publish.example/s/acme/product/public/transcript.txt', {
      method: 'HEAD',
      headers: { host: 'publish.example' },
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const notModified = await app.request(
      'http://publish.example/s/acme/product/public/transcript.txt',
      { headers: { host: 'publish.example', 'if-none-match': `"${descriptor.sha256}"` } },
    );
    expect(notModified.status).toBe(304);
  });

  it('rejects a cacheable publication before extraction when any member exceeds the exact limit', async () => {
    const { app, objectStore } = await fixture('public-catalog', {
      oversizedMemberBytes: 128 * 1024,
      maxMemberBytes: 64 * 1024,
    });
    let archiveReads = 0;
    const readStream = objectStore.readStream.bind(objectStore);
    objectStore.readStream = async function* (object) {
      archiveReads += 1;
      yield* readStream(object);
    };
    const entrypoint = await app.request('http://publish.example/s/acme/product/public/', {
      headers: { host: 'publish.example' },
    });
    expect(entrypoint.status).toBe(503);
    expect(archiveReads).toBe(0);
    const oversized = await app.request(
      'http://publish.example/s/acme/product/public/assets/oversized.bin',
      { headers: { host: 'publish.example' } },
    );
    expect(oversized.status).toBe(503);
    expect(archiveReads).toBe(0);
  });

  it('maps only fully active custom domains and cannot route another tenant path through them', async () => {
    const { app, repository } = await fixture();
    repository.customDomains.set('domain-1', {
      id: 'domain-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      hostname: 'stories.example.com',
      routingTarget: 'publish.example',
      status: 'active',
      dnsProof: {
        status: 'verified',
        challengeName: '_scenebook-challenge.stories.example.com',
        challengeValue: 'proof',
        verifiedAt: NOW.toISOString(),
      },
      provisioning: {
        operationKey: 'operation-1',
        operationId: 'provider-1',
        desiredState: 'active',
        certificate: 'ready',
        routing: 'ready',
        requestedAt: NOW.toISOString(),
        observedAt: NOW.toISOString(),
      },
      version: 3,
      createdBy: 'owner-1',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const custom = await app.request('http://stories.example.com/', {
      headers: { host: 'stories.example.com' },
    });
    expect(custom.status, await custom.clone().text()).toBe(200);
    expect(await custom.text()).toContain('Catalog');
    const crossRoute = await app.request(
      'http://stories.example.com/s/acme/product/public/transcript.txt',
      { headers: { host: 'stories.example.com' } },
    );
    expect(crossRoute.status).toBe(421);
    expect(
      (
        await app.request('http://publish.example/s/acme/product/public/', {
          headers: { host: 'attacker.example@publish.example' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('http://publish.example/s/acme/product/public/', {
          headers: { host: 'publish.example:4321' },
        })
      ).status,
    ).toBe(421);
    repository.customDomains.set('domain-1', {
      ...repository.customDomains.get('domain-1')!,
      dnsProof: {
        ...repository.customDomains.get('domain-1')!.dnsProof,
        status: 'pending',
        verifiedAt: undefined,
      },
    });
    expect(
      (
        await app.request('http://stories.example.com/', {
          headers: { host: 'stories.example.com' },
        })
      ).status,
    ).toBe(503);
    repository.customDomains.set('domain-1', {
      ...repository.customDomains.get('domain-1')!,
      status: 'disabled',
      provisioning: {
        ...repository.customDomains.get('domain-1')!.provisioning!,
        desiredState: 'disabled',
        routing: 'disabled',
      },
    });
    expect(
      (
        await app.request('http://stories.example.com/', {
          headers: { host: 'stories.example.com' },
        })
      ).status,
    ).toBe(421);
  });

  it('exchanges fragment share credentials for no-store signed sessions and rechecks revocation', async () => {
    const { app, repository, identityTokens } = await fixture('private-portal');
    await repository.createPortalGrant({
      id: 'grant-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      subject: { kind: 'link', label: 'Customer review' },
      permission: 'view',
      createdBy: 'owner-1',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-07-22T12:00:00.000Z',
    });
    const expiresAt = '2026-07-22T12:00:00.000Z';
    const credential = await identityTokens.issuePrivateShare(
      { id: 'share-1', grantId: 'grant-1', expiresAt },
      Math.floor(NOW.getTime() / 1_000),
    );
    await repository.createPrivateShareLink({
      id: 'share-1',
      grantId: 'grant-1',
      tokenHash: identityTokens.hashShareToken(credential),
      createdBy: 'owner-1',
      createdAt: NOW.toISOString(),
      expiresAt,
    });
    const wrongAuthority = await app.request('http://publish.example/_scenebook/auth/share', {
      method: 'POST',
      headers: {
        host: 'publish.example',
        origin: 'http://publish.example:4321',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: credential }),
    });
    expect(wrongAuthority.status).toBe(403);
    const exchange = await app.request('http://publish.example/_scenebook/auth/share', {
      method: 'POST',
      headers: {
        host: 'publish.example',
        origin: 'http://publish.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: credential }),
    });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    expect(await exchange.json()).toMatchObject({ location: '/s/acme/product/private/' });
    expect(exchange.headers.get('cache-control')).toBe('private, no-store');
    const cookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!;
    expect(cookie).not.toContain(credential);

    const opened = await app.request('http://publish.example/s/acme/product/private/', {
      headers: { host: 'publish.example', cookie },
    });
    expect(opened.status).toBe(200);
    expect(opened.headers.get('cache-control')).toBe('private, no-store');
    expect(await opened.text()).toContain('Catalog');

    await repository.revokePrivateShareLink('share-1', NOW.toISOString());
    const revoked = await app.request('http://publish.example/s/acme/product/private/', {
      headers: { host: 'publish.example', cookie },
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain('Catalog');
  });

  it('bootstraps an ordinary User grant once without exposing the control Session', async () => {
    const { app, repository, identityTokens, bootstrapClient } = await fixture('private-portal');
    await repository.createUser({
      id: 'user-1',
      email: 'reviewer@example.com',
      displayName: 'Reviewer',
      now: NOW.toISOString(),
    });
    const token = identityTokens.createApiToken('token-1');
    const scopes = ['workspace:read', 'project:read', 'review:read', 'channel:read'] as const;
    await repository.createIdentityApiToken({
      id: 'token-1',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      name: 'reviewer token',
      tokenHash: token.tokenHash,
      scopes,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-07-22T12:00:00.000Z',
    });
    const userSession = await repository.createUserSession({
      id: 'session-1',
      userId: 'user-1',
      sourceTokenId: 'token-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      scopes,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-07-22T12:00:00.000Z',
    });
    const identityCredential = await identityTokens.issueSession(
      userSession,
      Math.floor(NOW.getTime() / 1_000),
    );
    await repository.createPortalGrant({
      id: 'grant-user',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      subject: { kind: 'user', userId: 'user-1' },
      permission: 'review',
      createdBy: 'owner-1',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-07-22T12:00:00.000Z',
    });
    const handoffCredential = 'one-time-publication-login-credential-1234567890';
    bootstrapClient.authorizations.set(handoffCredential, {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      userId: 'user-1',
      sourceSessionId: 'session-1',
      grantId: 'grant-user',
      audienceOrigin: 'http://publish.example',
      returnPath: '/s/acme/product/private/',
      expiresAt: '2026-07-22T12:00:00.000Z',
    });
    const loginShell = await app.request('http://publish.example/login', {
      headers: { host: 'publish.example' },
    });
    expect(loginShell.status).toBe(200);
    expect(loginShell.headers.get('cache-control')).toBe('private, no-store');
    const loginHtml = await loginShell.text();
    expect(loginHtml).toContain('history.replaceState');
    expect(loginHtml).not.toContain(identityCredential);

    const missingOrigin = await app.request('http://publish.example/_scenebook/auth/bootstrap', {
      method: 'POST',
      headers: { host: 'publish.example', 'content-type': 'application/json' },
      body: JSON.stringify({ credential: handoffCredential }),
    });
    expect(missingOrigin.status).toBe(403);
    expect(bootstrapClient.requests).toHaveLength(0);

    const bootstrap = await app.request('http://publish.example/_scenebook/auth/bootstrap', {
      method: 'POST',
      headers: {
        host: 'publish.example',
        origin: 'http://publish.example',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ credential: handoffCredential }),
    });
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(200);
    expect(await bootstrap.json()).toEqual({ location: '/s/acme/product/private/' });
    expect(bootstrap.headers.get('cache-control')).toBe('private, no-store');
    const bootstrapCookie = bootstrap.headers.get('set-cookie')!.split(';', 1)[0]!;
    expect(bootstrapCookie).not.toContain(handoffCredential);
    expect(bootstrapCookie).not.toContain(identityCredential);
    const bootstrapped = await app.request('http://publish.example/s/acme/product/private/', {
      headers: { host: 'publish.example', cookie: bootstrapCookie },
    });
    expect(bootstrapped.status).toBe(200);
    await bootstrapped.text();
    const replay = await app.request('http://publish.example/_scenebook/auth/bootstrap', {
      method: 'POST',
      headers: {
        host: 'publish.example',
        origin: 'http://publish.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ credential: handoffCredential }),
    });
    expect(replay.status).toBe(401);
    const exchange = await app.request('http://publish.example/_scenebook/auth/session', {
      method: 'POST',
      headers: {
        host: 'publish.example',
        origin: 'http://publish.example',
        authorization: `Bearer ${identityCredential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceSlug: 'acme',
        projectSlug: 'product',
        channelSlug: 'private',
      }),
    });
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    const cookie = exchange.headers.get('set-cookie')!.split(';', 1)[0]!;
    const opened = await app.request(
      'http://publish.example/s/acme/product/private/transcript.txt',
      { headers: { host: 'publish.example', cookie } },
    );
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('portable transcript');

    repository.customDomains.set('domain-private', {
      id: 'domain-private',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      hostname: 'private.example.com',
      routingTarget: 'publish.example',
      status: 'active',
      dnsProof: {
        status: 'verified',
        challengeName: '_scenebook-challenge.private.example.com',
        challengeValue: 'proof',
        verifiedAt: NOW.toISOString(),
      },
      provisioning: {
        operationKey: 'operation-private',
        operationId: 'provider-private',
        desiredState: 'active',
        certificate: 'ready',
        routing: 'ready',
        requestedAt: NOW.toISOString(),
        observedAt: NOW.toISOString(),
      },
      version: 1,
      createdBy: 'owner-1',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const customExchange = await app.request('http://private.example.com/_scenebook/auth/session', {
      method: 'POST',
      headers: {
        host: 'private.example.com',
        origin: 'http://private.example.com',
        authorization: `Bearer ${identityCredential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workspaceSlug: 'acme',
        projectSlug: 'product',
        channelSlug: 'private',
      }),
    });
    expect(customExchange.status, await customExchange.clone().text()).toBe(200);
    expect(await customExchange.json()).toMatchObject({ location: '/' });
    const customCookie = customExchange.headers.get('set-cookie')!.split(';', 1)[0]!;
    const customOpened = await app.request('http://private.example.com/', {
      headers: { host: 'private.example.com', cookie: customCookie },
    });
    expect(customOpened.status).toBe(200);
    await customOpened.text();

    await repository.revokePortalGrant('grant-user', 'workspace-1', NOW.toISOString());
    expect(
      (
        await app.request('http://publish.example/s/acme/product/private/transcript.txt', {
          headers: { host: 'publish.example', cookie: bootstrapCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request('http://publish.example/s/acme/product/private/transcript.txt', {
          headers: { host: 'publish.example', cookie },
        })
      ).status,
    ).toBe(401);
  });

  it('rejects encoded traversal and never falls back outside the exact inventory', async () => {
    const { app } = await fixture();
    const traversal = await app.request(
      'http://publish.example/s/acme/product/public/assets%2F..%2Fmanifest.json',
      { headers: { host: 'publish.example' } },
    );
    expect(traversal.status, await traversal.clone().text()).toBe(400);
    expect(
      (
        await app.request('http://publish.example/s/acme/product/public/missing.html', {
          headers: { host: 'publish.example' },
        })
      ).status,
    ).toBe(404);
  });
});
