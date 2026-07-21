import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { artifactHash } from '@scenebook/core';
import { ReleaseSchema, ReviewSchema } from '@scenebook/schema';

import { createControlPlaneApp } from '../src/app.js';
import { IdentityTokenService } from '../src/auth.js';
import { HmacHasher, SecretBox, UploadTokenService } from '../src/crypto.js';
import type { AuditEventRecord } from '../src/domain.js';
import { createJsonLogger } from '../src/logger.js';
import { FileSystemObjectStore } from '../src/object-store.js';
import type { GitHubOidcVerifier } from '../src/oidc.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import { WebhookDispatcher } from '../src/webhook.js';
import { RunnerTokenService } from '../src/runner-token.js';

const NOW = new Date('2026-07-21T10:00:00.000Z');
const ADMIN = 'operator-secret-'.padEnd(64, 'a');
const UPLOAD_SECRET = 'upload-secret-'.padEnd(64, 'u');
const IDENTITY_SECRET = 'identity-secret-'.padEnd(64, 'i');
const RUNNER_SECRET = 'runner-secret-'.padEnd(64, 'r');
const GATEWAY_EXCHANGE_SECRET = 'gateway-exchange-'.padEnd(64, 'x');
const roots: string[] = [];

class FailOnceHandoffAuditRepository extends MemoryControlPlaneRepository {
  private failConsumptionAudit = true;

  override async appendAudit(event: AuditEventRecord): Promise<void> {
    if (event.action === 'portal.login-handoff-consumed' && this.failConsumptionAudit) {
      this.failConsumptionAudit = false;
      throw new Error('injected audit failure');
    }
    await super.appendAudit(event);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  repository: MemoryControlPlaneRepository = new MemoryControlPlaneRepository(),
) {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-auth-portal-'));
  roots.push(root);
  const app = createControlPlaneApp({
    repository,
    objectStore: new FileSystemObjectStore(root),
    oidcVerifier: {
      verify: async () => {
        throw new Error('not used');
      },
    } as GitHubOidcVerifier,
    uploadTokens: new UploadTokenService(UPLOAD_SECRET),
    identityTokens: new IdentityTokenService(IDENTITY_SECRET),
    runnerTokens: new RunnerTokenService(RUNNER_SECRET),
    hasher: new HmacHasher('hash-secret-'.padEnd(64, 'h')),
    secretBox: new SecretBox(Buffer.alloc(32, 8).toString('base64url')),
    webhooks: new WebhookDispatcher([]),
    logger: createJsonLogger('error', () => undefined),
    adminToken: ADMIN,
    publicBaseUrl: 'https://scenebook.example.com',
    publicationBaseUrl: 'https://publish.scenebook.example.com',
    maxJsonBytes: 128 * 1024,
    maxObjectBytes: 1024 * 1024,
    uploadLimits: {
      maxObjectsPerUpload: 10,
      maxBytesPerUpload: 1024 * 1024,
      maxActiveUploadsPerTenant: 10,
      maxActiveUploadsGlobal: 20,
      maxActiveBytesPerTenant: 2 * 1024 * 1024,
      maxActiveBytesGlobal: 4 * 1024 * 1024,
      maxConcurrentObjectsPerTenant: 2,
      maxConcurrentObjectsGlobal: 4,
      maxConcurrentBytesPerTenant: 1024 * 1024,
      maxConcurrentBytesGlobal: 2 * 1024 * 1024,
      gcIntervalMs: 60_000,
      gcBatchSize: 10,
      gcClaimTtlSeconds: 300,
    },
    uploadTokenTtlSeconds: 300,
    identity: {
      sessionTtlSeconds: 28_800,
      apiTokenMaxTtlSeconds: 7_776_000,
      shareLinkMaxTtlSeconds: 604_800,
    },
    publicationLogin: {
      exchangeSecret: GATEWAY_EXCHANGE_SECRET,
      handoffTtlSeconds: 60,
    },
    runnerLeaseSeconds: 120,
    rateLimit: { requests: 1_000, aggregateRequests: 10_000, windowMs: 60_000 },
    now: () => new Date(NOW),
  });
  return { app, repository };
}

function request(token: string, body?: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function bootstrap(app: ReturnType<typeof createControlPlaneApp>) {
  expect(
    (
      await app.request(
        '/v1/admin/workspaces',
        request(ADMIN, { id: 'workspace-1', slug: 'acme', name: 'Acme' }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request(
        '/v1/admin/workspaces/workspace-1/projects',
        request(ADMIN, { id: 'project-1', slug: 'product', name: 'Product' }),
      )
    ).status,
  ).toBe(201);
}

async function createUser(app: ReturnType<typeof createControlPlaneApp>, id: string) {
  expect(
    (
      await app.request(
        '/v1/operator/users',
        request(ADMIN, { id, email: `${id}@example.com`, displayName: id }),
      )
    ).status,
  ).toBe(201);
}

async function createApiToken(
  app: ReturnType<typeof createControlPlaneApp>,
  userId: string,
  input: {
    scopes: string[];
    projectId?: string;
    channelId?: string;
  },
) {
  const response = await app.request(
    `/v1/operator/workspaces/workspace-1/users/${userId}/api-tokens`,
    request(ADMIN, {
      name: 'test token',
      scopes: input.scopes,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      expiresAt: '2026-07-22T10:00:00.000Z',
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { credential: string; token: { id: string } };
}

describe('human identity and private portal authorization', () => {
  it('keeps the control-plane legacy portal as a fragment-preserving gateway redirect only', async () => {
    const { app } = await fixture();
    const response = await app.request('/portal/private');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const body = await response.text();
    expect(body).toContain('https://publish.scenebook.example.com/share');
    expect(body).toContain('destination+location.hash');
    expect(body).not.toContain('/v1/portal/share/resolve');
    expect(body).not.toContain('fetch(');
  });

  it('enforces live role, token scope, session revocation, and API-token revocation', async () => {
    const { app } = await fixture();
    await bootstrap(app);
    await createUser(app, 'user-reviewer');
    expect(
      (
        await app.request(
          '/v1/operator/workspaces/workspace-1/memberships',
          request(ADMIN, { userId: 'user-reviewer', role: 'reviewer' }, 'PUT'),
        )
      ).status,
    ).toBe(201);
    const apiToken = await createApiToken(app, 'user-reviewer', {
      scopes: ['workspace:read', 'project:read', 'review:read', 'review:write', 'channel:read'],
      projectId: 'project-1',
    });
    const listedTokens = await app.request(
      '/v1/operator/workspaces/workspace-1/users/user-reviewer/api-tokens',
      request(ADMIN, undefined, 'GET'),
    );
    expect(listedTokens.status).toBe(200);
    const listedTokenBody = await listedTokens.json();
    expect(listedTokenBody).toMatchObject({ tokens: [{ id: apiToken.token.id }] });
    expect(JSON.stringify(listedTokenBody)).not.toContain('tokenHash');
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1',
          request(apiToken.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-read/releases',
          request(apiToken.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/channels',
          request(apiToken.credential, {
            slug: 'forbidden',
            name: 'Forbidden',
            kind: 'private-portal',
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
    ).toBe(403);

    const sessionResponse = await app.request(
      '/v1/auth/sessions',
      request(apiToken.credential, {}),
    );
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as {
      credential: string;
      session: { id: string };
    };
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1',
          request(session.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/v1/auth/sessions/current',
          request(session.credential, undefined, 'DELETE'),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1',
          request(session.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(401);

    const liveSessionResponse = await app.request(
      '/v1/auth/sessions',
      request(apiToken.credential, {}),
    );
    const liveSession = (await liveSessionResponse.json()) as { credential: string };
    expect(
      (
        await app.request(
          '/v1/operator/workspaces/workspace-1/memberships/user-reviewer',
          request(ADMIN, undefined, 'DELETE'),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1',
          request(liveSession.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          '/v1/operator/workspaces/workspace-1/memberships',
          request(ADMIN, { userId: 'user-reviewer', role: 'reviewer' }, 'PUT'),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1',
          request(liveSession.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request(
          `/v1/operator/workspaces/workspace-1/users/user-reviewer/api-tokens/${apiToken.token.id}`,
          request(ADMIN, undefined, 'DELETE'),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1',
          request(liveSession.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1',
          request(apiToken.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(401);
  });

  it('lists eligible reviewers and applies conflict-safe assignment and comment resolution', async () => {
    const { app, repository } = await fixture();
    await bootstrap(app);
    for (const [userId, role] of [
      ['user-editor', 'editor'],
      ['user-reviewer', 'reviewer'],
      ['user-viewer', 'viewer'],
    ] as const) {
      await createUser(app, userId);
      expect(
        (
          await app.request(
            '/v1/operator/workspaces/workspace-1/memberships',
            request(ADMIN, { userId, role }, 'PUT'),
          )
        ).status,
      ).toBe(201);
    }
    const editor = await createApiToken(app, 'user-editor', {
      scopes: ['project:read', 'review:read', 'review:write'],
      projectId: 'project-1',
    });
    const review = ReviewSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'review-collaboration',
      kind: 'review',
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      subject: { kind: 'run', id: 'run-collaboration', revision: 'a'.repeat(64) },
      status: 'open',
      changeState: 'changed',
      openedAt: NOW.toISOString(),
    });
    repository.reviews.set(review.id, {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      review,
    });

    const reviewers = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviewers',
      request(editor.credential, undefined, 'GET'),
    );
    expect(reviewers.status).toBe(200);
    expect(await reviewers.json()).toMatchObject({
      reviewers: [
        { id: 'user-editor', role: 'editor' },
        { id: 'user-reviewer', role: 'reviewer' },
      ],
    });

    const assignmentPath =
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews/review-collaboration/assignees';
    const assigned = await app.request(
      assignmentPath,
      request(editor.credential, { expectedAssignedTo: [], assignedTo: ['user-reviewer'] }, 'PUT'),
    );
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({ review: { assignedTo: ['user-reviewer'] } });
    expect(
      (
        await app.request(
          assignmentPath,
          request(
            editor.credential,
            { expectedAssignedTo: [], assignedTo: ['user-editor'] },
            'PUT',
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(
          assignmentPath,
          request(
            editor.credential,
            { expectedAssignedTo: ['user-reviewer'], assignedTo: ['user-viewer'] },
            'PUT',
          ),
        )
      ).status,
    ).toBe(422);

    const commentResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews/review-collaboration/comments',
      request(editor.credential, { body: 'Verify the selected region.' }),
    );
    expect(commentResponse.status).toBe(201);
    const commentBody = (await commentResponse.json()) as {
      review: { comments: Array<{ id: string; resolvedAt?: string; resolvedBy?: string }> };
    };
    const commentId = commentBody.review.comments[0]!.id;
    const resolutionPath = `${assignmentPath.replace('/assignees', '')}/comments/${commentId}/resolution`;
    const resolved = await app.request(
      resolutionPath,
      request(editor.credential, { status: 'resolved' }, 'PUT'),
    );
    expect(resolved.status).toBe(200);
    const resolvedBody = (await resolved.json()) as typeof commentBody;
    expect(resolvedBody.review.comments[0]).toMatchObject({
      id: commentId,
      resolvedBy: 'user-editor',
      resolvedAt: NOW.toISOString(),
    });
    expect(
      (await app.request(resolutionPath, request(editor.credential, { status: 'resolved' }, 'PUT')))
        .status,
    ).toBe(409);
    const reopened = await app.request(
      resolutionPath,
      request(editor.credential, { status: 'open', expectedResolvedAt: NOW.toISOString() }, 'PUT'),
    );
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({
      review: { comments: [{ id: commentId }] },
    });
    expect(repository.reviews.get(review.id)?.review.comments[0]).not.toHaveProperty('resolvedAt');
  });

  it('rechecks signed share links and attributes portal reviews to the authenticated User', async () => {
    const { app, repository } = await fixture(new FailOnceHandoffAuditRepository());
    await bootstrap(app);
    const channelResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels',
      request(ADMIN, {
        id: 'channel-private',
        slug: 'private',
        name: 'Private product portal',
        kind: 'private-portal',
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
    expect(channelResponse.status).toBe(201);

    const linkGrantResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-private/portal/grants',
      request(ADMIN, {
        id: 'grant-link',
        subject: { kind: 'link', label: 'Customer preview' },
        permission: 'view',
        expiresAt: '2026-07-22T10:00:00.000Z',
      }),
    );
    expect(linkGrantResponse.status).toBe(201);
    const shareResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-private/portal/share-links',
      request(ADMIN, {
        grantId: 'grant-link',
        expiresAt: '2026-07-21T11:00:00.000Z',
      }),
    );
    expect(shareResponse.status).toBe(201);
    const share = (await shareResponse.json()) as {
      credential: string;
      share: { id: string };
      url: string;
    };
    expect(share.url).toContain('https://publish.scenebook.example.com/share#token=');
    const listedGrants = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-private/portal/grants',
      request(ADMIN, undefined, 'GET'),
    );
    expect(listedGrants.status).toBe(200);
    expect(await listedGrants.json()).toMatchObject({ grants: [{ id: 'grant-link' }] });
    const listedShares = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-private/portal/grants/grant-link/share-links',
      request(ADMIN, undefined, 'GET'),
    );
    expect(listedShares.status).toBe(200);
    const listedShareBody = await listedShares.json();
    expect(listedShareBody).toMatchObject({ links: [{ id: share.share.id }] });
    expect(JSON.stringify(listedShareBody)).not.toContain('tokenHash');
    const resolved = await app.request(
      '/v1/portal/share/resolve',
      request('unused', { token: share.credential }),
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      portal: { channel: { id: 'channel-private' }, release: null },
      permission: 'view',
    });
    expect(
      (
        await app.request(
          `/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-private/portal/share-links/${share.share.id}`,
          request(ADMIN, undefined, 'DELETE'),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(
          '/v1/portal/share/resolve',
          request('unused', { token: share.credential }),
        )
      ).status,
    ).toBe(401);

    await createUser(app, 'user-customer');
    const userGrant = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-private/portal/grants',
      request(ADMIN, {
        id: 'grant-user',
        subject: { kind: 'user', userId: 'user-customer' },
        permission: 'review',
        expiresAt: '2026-07-22T10:00:00.000Z',
      }),
    );
    expect(userGrant.status).toBe(201);
    const portalApiToken = await createApiToken(app, 'user-customer', {
      scopes: ['channel:read', 'review:read', 'review:write'],
      projectId: 'project-1',
      channelId: 'channel-private',
    });
    const portalSessionResponse = await app.request(
      '/v1/auth/sessions',
      request(portalApiToken.credential, {}),
    );
    const portalSession = (await portalSessionResponse.json()) as { credential: string };
    expect(
      (
        await app.request(
          '/v1/portal/workspaces/workspace-1/projects/project-1/channels/channel-private',
          request(portalSession.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(200);

    const handoffPath =
      '/v1/portal/workspaces/workspace-1/projects/project-1/channels/channel-private/login-handoffs';
    expect((await app.request(handoffPath, request(portalApiToken.credential, {}))).status).toBe(
      403,
    );
    const handoffResponse = await app.request(handoffPath, request(portalSession.credential, {}));
    expect(handoffResponse.status, await handoffResponse.clone().text()).toBe(201);
    expect(handoffResponse.headers.get('cache-control')).toBe('private, no-store');
    const handoffBody = (await handoffResponse.json()) as { url: string; expiresAt: string };
    const handoffUrl = new URL(handoffBody.url);
    expect(handoffUrl.origin).toBe('https://publish.scenebook.example.com');
    expect(handoffUrl.pathname).toBe('/login');
    expect(handoffBody.url).not.toContain(portalSession.credential);
    const handoffCredential = new URLSearchParams(handoffUrl.hash.slice(1)).get('credential');
    expect(handoffCredential).toBeTruthy();

    const wrongAudience = await app.request(
      '/v1/internal/publication-login/consume',
      request(GATEWAY_EXCHANGE_SECRET, {
        credential: handoffCredential,
        audienceOrigin: 'https://wrong.example.com',
      }),
    );
    expect(wrongAudience.status).toBe(401);
    const failedAudit = await app.request(
      '/v1/internal/publication-login/consume',
      request(GATEWAY_EXCHANGE_SECRET, {
        credential: handoffCredential,
        audienceOrigin: 'https://publish.scenebook.example.com',
      }),
    );
    expect(failedAudit.status).toBe(500);
    expect([...repository.publicationLoginHandoffs.values()][0]?.consumedAt).toBeUndefined();
    const consumed = await app.request(
      '/v1/internal/publication-login/consume',
      request(GATEWAY_EXCHANGE_SECRET, {
        credential: handoffCredential,
        audienceOrigin: 'https://publish.scenebook.example.com',
      }),
    );
    expect(consumed.status, await consumed.clone().text()).toBe(200);
    expect(await consumed.json()).toMatchObject({
      authorization: {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        channelId: 'channel-private',
        userId: 'user-customer',
        grantId: 'grant-user',
        audienceOrigin: 'https://publish.scenebook.example.com',
        returnPath: '/s/acme/product/private/',
      },
    });
    expect(
      repository.audits.filter((event) => event.action === 'portal.login-handoff-consumed'),
    ).toHaveLength(1);
    expect(
      (
        await app.request(
          '/v1/internal/publication-login/consume',
          request(GATEWAY_EXCHANGE_SECRET, {
            credential: handoffCredential,
            audienceOrigin: 'https://publish.scenebook.example.com',
          }),
        )
      ).status,
    ).toBe(401);

    const release = ReleaseSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'release-private',
      kind: 'release',
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      channelId: 'channel-private',
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
                path: 'assets/catalog.html',
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
          actorId: 'admin',
          createdAt: NOW.toISOString(),
          revision: 'a'.repeat(64),
        },
      ],
      manifestHash: 'c'.repeat(64),
    });
    repository.releases.set(release.id, {
      release,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      idempotencyKey: 'private-release',
      requestHash: 'd'.repeat(64),
    });
    repository.channels.set('channel-private', {
      ...repository.channels.get('channel-private')!,
      currentReleaseId: release.id,
      sequence: 1,
    });
    const review = ReviewSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'review-private',
      kind: 'review',
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      subject: { kind: 'release', id: release.id, revision: artifactHash(release) },
      status: 'open',
      changeState: 'passed',
      openedAt: NOW.toISOString(),
    });
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
          request(ADMIN, { review }),
        )
      ).status,
    ).toBe(201);
    const comment = await app.request(
      '/v1/portal/workspaces/workspace-1/projects/project-1/channels/channel-private/reviews/review-private/comments',
      request(portalSession.credential, { body: 'Please clarify the final step.' }),
    );
    expect(comment.status).toBe(201);
    expect(await comment.json()).toMatchObject({
      review: { comments: [{ actorId: 'user-customer' }] },
    });
    const decision = await app.request(
      '/v1/portal/workspaces/workspace-1/projects/project-1/channels/channel-private/reviews/review-private/decisions',
      request(portalSession.credential, { decision: 'approve', reason: 'Reviewed in context.' }),
    );
    expect(decision.status).toBe(201);
    expect(await decision.json()).toMatchObject({
      review: { decisions: [{ actorId: 'user-customer', decision: 'approve' }] },
    });
    expect(
      (await app.request('/v1/operator/users/user-customer', request(ADMIN, undefined, 'DELETE')))
        .status,
    ).toBe(204);
    expect(
      (
        await app.request(
          '/v1/portal/workspaces/workspace-1/projects/project-1/channels/channel-private',
          request(portalSession.credential, undefined, 'GET'),
        )
      ).status,
    ).toBe(401);
  });

  it('rejects sensitive Review summaries, comment bodies, and decision reasons before persistence', async () => {
    const { app, repository } = await fixture();
    await bootstrap(app);
    const release = ReleaseSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'release-review-privacy',
      kind: 'release',
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      channelId: 'channel-unused',
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
                path: 'assets/catalog.html',
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
          actorId: 'admin',
          createdAt: NOW.toISOString(),
          revision: 'a'.repeat(64),
        },
      ],
      manifestHash: 'c'.repeat(64),
    });
    repository.releases.set(release.id, {
      release,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      idempotencyKey: 'privacy-release',
      requestHash: 'd'.repeat(64),
    });
    const base = {
      schemaVersion: 1 as const,
      artifactVersion: 1 as const,
      kind: 'review' as const,
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      subject: { kind: 'release' as const, id: release.id, revision: artifactHash(release) },
      status: 'open' as const,
      changeState: 'passed' as const,
      openedAt: NOW.toISOString(),
    };
    const sensitive = ReviewSchema.parse({
      ...base,
      id: 'review-sensitive',
      changes: [
        {
          id: 'change-sensitive',
          dimension: 'narrative',
          severity: 'warning',
          kind: 'modified',
          sceneId: 'scene-1',
          summary: 'password=hunter2',
        },
      ],
    });
    const rejected = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
      request(ADMIN, { review: sensitive }),
    );
    expect(rejected.status).toBe(422);
    expect(repository.reviews.has('review-sensitive')).toBe(false);

    const clean = ReviewSchema.parse({ ...base, id: 'review-clean' });
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
          request(ADMIN, { review: clean }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/reviews/review-clean/comments',
          request(ADMIN, { body: 'password=hunter2' }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/reviews/review-clean/decisions',
          request(ADMIN, { decision: 'approve', reason: 'password=hunter2' }),
        )
      ).status,
    ).toBe(422);
    expect(repository.reviews.get('review-clean')?.review.comments).toHaveLength(0);
    expect(repository.reviews.get('review-clean')?.review.decisions).toHaveLength(0);
  });
});
