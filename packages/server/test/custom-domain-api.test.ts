import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createControlPlaneApp } from '../src/app.js';
import { IdentityTokenService } from '../src/auth.js';
import type {
  CustomDomainDnsResolver,
  CustomDomainProvisioner,
  CustomDomainProvisioningRequest,
} from '../src/custom-domains.js';
import { HmacHasher, SecretBox, UploadTokenService } from '../src/crypto.js';
import type { CustomDomainProvisioningObservation } from '../src/domain.js';
import { createJsonLogger } from '../src/logger.js';
import { FileSystemObjectStore } from '../src/object-store.js';
import type { GitHubOidcVerifier } from '../src/oidc.js';
import { RunnerTokenService } from '../src/runner-token.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import { WebhookDispatcher } from '../src/webhook.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const ADMIN = 'admin-secret-'.padEnd(64, 'a');
const SECRET = 'server-secret-'.padEnd(64, 's');
const IDENTITY_SECRET = 'identity-secret-'.padEnd(64, 'i');
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64url');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeDnsResolver implements CustomDomainDnsResolver {
  records: readonly (readonly string[])[] = [];

  async resolveTxt(): Promise<readonly (readonly string[])[]> {
    return this.records;
  }
}

class FakeProvisioner implements CustomDomainProvisioner {
  certificate: CustomDomainProvisioningObservation['certificate'] = 'pending';
  routing: CustomDomainProvisioningObservation['routing'] = 'pending';
  hostnameOverride?: string;
  readonly calls: CustomDomainProvisioningRequest[] = [];

  async reconcile(
    input: CustomDomainProvisioningRequest,
  ): Promise<CustomDomainProvisioningObservation> {
    this.calls.push(structuredClone(input));
    return {
      operationKey: input.operationKey,
      operationId: `provider-${input.operationKey}`,
      hostname: this.hostnameOverride ?? input.domain.hostname,
      desiredState: input.desiredState,
      certificate: this.certificate,
      routing: this.routing,
    };
  }
}

const policy = {
  requireCriticalPassing: true,
  requireVisualApproval: true,
  requireEditorialApproval: true,
  requireCompleteLocalization: false,
  publication: 'manual' as const,
  nonCriticalFailure: 'block' as const,
};

async function fixture(enabled = true) {
  const repository = new MemoryControlPlaneRepository();
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
  for (const [id, slug] of [
    ['channel-1', 'docs'],
    ['channel-2', 'help'],
  ] as const) {
    await repository.createChannel({
      id,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      slug,
      name: slug,
      kind: 'public-catalog',
      policy,
      webhookIds: [],
      analyticsTokenHash: 'a'.repeat(64),
      now: NOW.toISOString(),
    });
  }
  const root = await mkdtemp(join(tmpdir(), 'scenebook-domain-api-'));
  roots.push(root);
  const dnsResolver = new FakeDnsResolver();
  const provisioner = new FakeProvisioner();
  const identityTokens = new IdentityTokenService(IDENTITY_SECRET);
  const app = createControlPlaneApp({
    repository,
    objectStore: new FileSystemObjectStore(root),
    oidcVerifier: {
      async verify() {
        throw new Error('unused');
      },
    } as GitHubOidcVerifier,
    uploadTokens: new UploadTokenService(SECRET),
    identityTokens,
    runnerTokens: new RunnerTokenService(`${SECRET}-runner`),
    hasher: new HmacHasher(SECRET),
    secretBox: new SecretBox(ENCRYPTION_KEY),
    webhooks: new WebhookDispatcher([]),
    logger: createJsonLogger('error', () => undefined),
    adminToken: ADMIN,
    publicBaseUrl: 'https://control.scenebook.com',
    publicationBaseUrl: 'https://publish.scenebook.com',
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
    runnerLeaseSeconds: 300,
    rateLimit: { requests: 1_000, aggregateRequests: 10_000, windowMs: 60_000 },
    customDomains: {
      enabled,
      routingTarget: enabled ? 'customers.scenebook.cloud' : undefined,
      dnsResolver,
      provisioner,
    },
    now: () => new Date(NOW),
  });
  return { app, repository, dnsResolver, provisioner, identityTokens };
}

function request(method: string, body?: unknown, bearer = ADMIN): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

const domains = (channelId = 'channel-1') =>
  `/v1/admin/workspaces/workspace-1/projects/project-1/channels/${channelId}/custom-domains`;

describe('custom-domain API lifecycle', () => {
  it('keeps DNS, certificate, and routing proof separate through activation and removal', async () => {
    const { app, repository, dnsResolver, provisioner } = await fixture();
    const createdResponse = await app.request(
      domains(),
      request('POST', { id: 'domain-1', hostname: 'Stories.Acme.COM.' }),
    );
    expect(createdResponse.status).toBe(201);
    let domain = (await createdResponse.json()).domain;
    expect(domain).toMatchObject({
      hostname: 'stories.acme.com',
      routingTarget: 'customers.scenebook.cloud',
      status: 'pending-dns',
      version: 1,
    });
    const retriedCreate = await app.request(
      domains(),
      request('POST', { id: 'domain-1', hostname: 'stories.acme.com' }),
    );
    expect(retriedCreate.status).toBe(200);
    expect((await retriedCreate.json()).domain.dnsProof.challengeValue).toBe(
      domain.dnsProof.challengeValue,
    );
    expect(
      repository.audits.filter((event) => event.action === 'custom-domain.created'),
    ).toHaveLength(1);

    dnsResolver.records = [
      [domain.dnsProof.challengeValue.slice(0, 24), domain.dnsProof.challengeValue.slice(24)],
    ];
    const verified = await app.request(
      `${domains()}/domain-1/verify-dns`,
      request('POST', { expectedVersion: domain.version }),
    );
    expect(verified.status).toBe(200);
    domain = (await verified.json()).domain;
    expect(domain).toMatchObject({ status: 'ready-to-provision', version: 2 });

    const noRelease = await app.request(
      `${domains()}/domain-1/activate`,
      request('POST', { expectedVersion: domain.version }),
    );
    expect(noRelease.status).toBe(409);
    repository.channels.set('channel-1', {
      ...repository.channels.get('channel-1')!,
      currentReleaseId: 'release-1',
    });

    provisioner.certificate = 'ready';
    provisioner.routing = 'pending';
    const activating = await app.request(
      `${domains()}/domain-1/activate`,
      request('POST', { expectedVersion: domain.version }),
    );
    expect(activating.status).toBe(200);
    domain = (await activating.json()).domain;
    expect(domain).toMatchObject({
      status: 'provisioning',
      version: 4,
      provisioning: { certificate: 'ready', routing: 'pending' },
    });
    expect(await repository.getActiveCustomDomainByHostname(domain.hostname)).toBeUndefined();

    provisioner.routing = 'ready';
    const active = await app.request(
      `${domains()}/domain-1/refresh`,
      request('POST', { expectedVersion: domain.version }),
    );
    domain = (await active.json()).domain;
    expect(domain).toMatchObject({ status: 'active', version: 5 });
    expect(await repository.getActiveCustomDomainByHostname('STORIES.ACME.COM.')).toMatchObject({
      channelId: 'channel-1',
    });

    const unsafeRotation = await app.request(
      `${domains()}/domain-1/challenge`,
      request('POST', { expectedVersion: domain.version }),
    );
    expect(unsafeRotation.status).toBe(409);

    provisioner.routing = 'disabled';
    const disabled = await app.request(
      `${domains()}/domain-1/disable`,
      request('POST', { expectedVersion: domain.version }),
    );
    domain = (await disabled.json()).domain;
    expect(domain).toMatchObject({ status: 'disabled', version: 7 });

    const rotated = await app.request(
      `${domains()}/domain-1/challenge`,
      request('POST', { expectedVersion: domain.version }),
    );
    domain = (await rotated.json()).domain;
    expect(domain).toMatchObject({
      status: 'disabled',
      version: 8,
      dnsProof: { status: 'pending' },
    });
    expect(
      (
        await app.request(
          `${domains()}/domain-1/activate`,
          request('POST', { expectedVersion: domain.version }),
        )
      ).status,
    ).toBe(409);
    dnsResolver.records = [[domain.dnsProof.challengeValue]];
    const reverified = await app.request(
      `${domains()}/domain-1/verify-dns`,
      request('POST', { expectedVersion: domain.version }),
    );
    domain = (await reverified.json()).domain;
    expect(domain).toMatchObject({
      status: 'disabled',
      version: 9,
      dnsProof: { status: 'verified' },
    });

    provisioner.certificate = 'removed';
    provisioner.routing = 'removed';
    const removed = await app.request(
      `${domains()}/domain-1/remove`,
      request('POST', { expectedVersion: domain.version }),
    );
    domain = (await removed.json()).domain;
    expect(domain).toMatchObject({ status: 'removed', version: 11 });
    expect(domain.removedAt).toBe(NOW.toISOString());
    expect(await repository.getActiveCustomDomainByHostname(domain.hostname)).toBeUndefined();
    expect(repository.audits.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'custom-domain.created',
        'custom-domain.dns-verified',
        'custom-domain.active-requested',
        'custom-domain.activated',
        'custom-domain.disabled-requested',
        'custom-domain.disabled',
        'custom-domain.removed-requested',
        'custom-domain.removed',
      ]),
    );
  });

  it('enforces one live hostname globally and one live custom domain per Channel', async () => {
    const { app, dnsResolver } = await fixture();
    const firstResponse = await app.request(
      domains(),
      request('POST', { id: 'domain-1', hostname: 'stories.acme.com' }),
    );
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()).domain;
    expect(
      (
        await app.request(
          domains(),
          request('POST', { id: 'domain-2', hostname: 'other.acme.com' }),
        )
      ).status,
    ).toBe(409);
    const competingResponse = await app.request(
      domains('channel-2'),
      request('POST', { id: 'domain-3', hostname: 'stories.acme.com' }),
    );
    expect(competingResponse.status).toBe(201);
    const competing = (await competingResponse.json()).domain;

    dnsResolver.records = [[first.dnsProof.challengeValue]];
    expect(
      (
        await app.request(
          `${domains()}/domain-1/verify-dns`,
          request('POST', { expectedVersion: first.version }),
        )
      ).status,
    ).toBe(200);
    dnsResolver.records = [[competing.dnsProof.challengeValue]];
    expect(
      (
        await app.request(
          `${domains('channel-2')}/domain-3/verify-dns`,
          request('POST', { expectedVersion: competing.version }),
        )
      ).status,
    ).toBe(409);
  });

  it('fails closed on missing configuration and mismatched provider observations', async () => {
    const disabled = await fixture(false);
    expect(
      (
        await disabled.app.request(
          domains(),
          request('POST', { id: 'domain-disabled', hostname: 'stories.acme.com' }),
        )
      ).status,
    ).toBe(503);

    const { app, repository, dnsResolver, provisioner } = await fixture();
    let response = await app.request(
      domains(),
      request('POST', { id: 'domain-1', hostname: 'stories.acme.com' }),
    );
    let domain = (await response.json()).domain;
    dnsResolver.records = [[domain.dnsProof.challengeValue]];
    response = await app.request(
      `${domains()}/domain-1/verify-dns`,
      request('POST', { expectedVersion: domain.version }),
    );
    domain = (await response.json()).domain;
    repository.channels.set('channel-1', {
      ...repository.channels.get('channel-1')!,
      currentReleaseId: 'release-1',
    });
    provisioner.hostnameOverride = 'victim.acme.com';
    provisioner.certificate = 'ready';
    provisioner.routing = 'ready';
    response = await app.request(
      `${domains()}/domain-1/activate`,
      request('POST', { expectedVersion: domain.version }),
    );
    expect(response.status).toBe(502);
    domain = await repository.getCustomDomain('workspace-1', 'project-1', 'channel-1', 'domain-1');
    expect(domain).toMatchObject({
      status: 'failed',
      provisioning: { failureCode: 'provisioner_response_invalid' },
    });
    const firstOperationKey = provisioner.calls.at(-1)!.operationKey;
    provisioner.hostnameOverride = undefined;
    response = await app.request(
      `${domains()}/domain-1/activate`,
      request('POST', { expectedVersion: domain!.version }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).domain.status).toBe('active');
    expect(provisioner.calls.at(-1)!.operationKey).toBe(firstOperationKey);
  });

  it('lets reviewers read domain state but live RBAC prevents mutation', async () => {
    const { app, repository, identityTokens } = await fixture();
    const created = await app.request(
      domains(),
      request('POST', { id: 'domain-1', hostname: 'stories.acme.com' }),
    );
    const domain = (await created.json()).domain;
    await repository.createUser({
      id: 'user-reviewer',
      email: 'reviewer@acme.com',
      displayName: 'Reviewer',
      now: NOW.toISOString(),
    });
    await repository.putWorkspaceMembership({
      workspaceId: 'workspace-1',
      userId: 'user-reviewer',
      role: 'reviewer',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const credential = identityTokens.createApiToken('token-reviewer');
    await repository.createIdentityApiToken({
      id: 'token-reviewer',
      userId: 'user-reviewer',
      workspaceId: 'workspace-1',
      name: 'Reviewer token',
      tokenHash: credential.tokenHash,
      scopes: ['channel:read', 'channel:write'],
      projectId: 'project-1',
      channelId: 'channel-1',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-07-22T12:00:00.000Z',
    });
    expect((await app.request(domains(), request('GET', undefined, credential.token))).status).toBe(
      200,
    );
    expect(
      (await app.request(domains('channel-2'), request('GET', undefined, credential.token))).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `${domains()}/domain-1/challenge`,
          request('POST', { expectedVersion: domain.version }, credential.token),
        )
      ).status,
    ).toBe(403);
  });
});
