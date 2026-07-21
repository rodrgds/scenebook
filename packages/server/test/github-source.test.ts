import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { artifactHash } from '@scenebook/core';
import { BuildArtifactSchema, parseSceneYaml } from '@scenebook/schema';

import { createControlPlaneApp } from '../src/app.js';
import { IdentityTokenService } from '../src/auth.js';
import { loadServerConfig } from '../src/config.js';
import { HmacHasher, SecretBox, UploadTokenService } from '../src/crypto.js';
import {
  applyGitHubPatch,
  assertSafeGitHubSourcePath,
  GitHubSourceError,
  RemoteGitHubAppSourceClient,
  type GitHubAppliedChange,
  type GitHubCheckRunResult,
  type GitHubCheckRunState,
  type GitHubSourceBindingInfo,
  type GitHubSourceClient,
  type GitHubSourceFile,
} from '../src/github-app.js';
import { createJsonLogger } from '../src/logger.js';
import { FileSystemObjectStore } from '../src/object-store.js';
import type { GitHubOidcClaims, GitHubOidcVerifier } from '../src/oidc.js';
import { RunnerTokenService } from '../src/runner-token.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import { WebhookDispatcher } from '../src/webhook.js';

const NOW = new Date('2026-07-21T09:00:00.000Z');
const ADMIN = 'admin-'.padEnd(64, 'a');
const SECRET = 'secret-'.padEnd(64, 's');
const IDENTITY_SECRET = 'identity-'.padEnd(64, 'i');
const RUNNER_SECRET = 'runner-'.padEnd(64, 'r');
const roots: string[] = [];

class UnusedOidcVerifier implements GitHubOidcVerifier {
  async verify(): Promise<GitHubOidcClaims> {
    throw new Error('OIDC is not used by this test');
  }
}

class FakeGitHubSource implements GitHubSourceClient {
  inspections = 0;
  reads = 0;
  changes = 0;
  checks: GitHubCheckRunState[] = [];
  failuresRemaining = 0;
  private changeBlock?: {
    readonly started: () => void;
    readonly gate: Promise<void>;
  };
  private checkBlock?: {
    readonly started: () => void;
    readonly gate: Promise<void>;
  };

  blockNextChange(): { readonly started: Promise<void>; readonly release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.changeBlock = { started: markStarted, gate };
    return { started, release };
  }

  blockNextCheck(): { readonly started: Promise<void>; readonly release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.checkBlock = { started: markStarted, gate };
    return { started, release };
  }

  async inspectInstallation(input: {
    installationId: string;
    repository: string;
  }): Promise<GitHubSourceBindingInfo> {
    this.inspections += 1;
    expect(input.installationId).toBe('123456');
    return { repositoryId: '987654', repository: input.repository, defaultBranch: 'main' };
  }

  async readSource(input: { commitSha: string }): Promise<GitHubSourceFile> {
    this.reads += 1;
    return {
      commitSha: input.commitSha,
      blobSha: 'b'.repeat(40),
      byteLength: 32,
      content: 'title: Invite\nlocator: old-button\n',
    };
  }

  async applyChange(input: {
    changeId: string;
    baseCommitSha: string;
    signal?: AbortSignal;
    assertLease?: () => Promise<void>;
  }): Promise<GitHubAppliedChange> {
    this.changes += 1;
    await input.assertLease?.();
    if (this.changeBlock) {
      const block = this.changeBlock;
      this.changeBlock = undefined;
      block.started();
      await block.gate;
    }
    if (input.signal?.aborted)
      throw new GitHubSourceError('github_lease_lost', 'Lease was lost during fake change');
    await input.assertLease?.();
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new GitHubSourceError('github_unavailable', 'GitHub API is unavailable', true);
    }
    return {
      baseCommitSha: input.baseCommitSha,
      baseBlobSha: 'b'.repeat(40),
      headCommitSha: 'c'.repeat(40),
      headBlobSha: 'd'.repeat(40),
      branch: `scenebook/${input.changeId}`,
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/acme/product/pull/42',
      issueNumber: 43,
      issueUrl: 'https://github.com/acme/product/issues/43',
    };
  }

  async ensureCheckRun(input: {
    state: GitHubCheckRunState;
    signal?: AbortSignal;
  }): Promise<GitHubCheckRunResult> {
    this.checks.push(input.state);
    if (this.checkBlock) {
      const block = this.checkBlock;
      this.checkBlock = undefined;
      block.started();
      if (input.signal?.aborted) throw input.signal.reason;
      await Promise.race([
        block.gate,
        new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true,
          });
        }),
      ]);
    }
    return {
      id: 99,
      commitSha: input.state.commitSha,
      status: input.state.status,
      ...(input.state.conclusion ? { conclusion: input.state.conclusion } : {}),
      url: 'https://github.com/acme/product/runs/99',
    };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: {
    readonly githubChangeLeaseSeconds?: number;
    readonly githubCheckReconcileTimeoutMs?: number;
  } = {},
) {
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
  const repositoryBinding = await repository.bindRepository({
    id: 'repository-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    repository: 'acme/product',
    workflowRefPattern: '*',
    createdAt: NOW.toISOString(),
  });
  await repository.createUser({
    id: 'user-1',
    email: 'editor@example.com',
    displayName: 'Editor',
    now: NOW.toISOString(),
  });
  await repository.putWorkspaceMembership({
    workspaceId: 'workspace-1',
    userId: 'user-1',
    role: 'owner',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  const identityTokens = new IdentityTokenService(IDENTITY_SECRET);
  const generated = identityTokens.createApiToken('github-source-token');
  await repository.createIdentityApiToken({
    id: 'github-source-token',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    name: 'GitHub source test',
    tokenHash: generated.tokenHash,
    scopes: ['workspace:admin', 'project:read', 'project:write', 'review:read', 'review:write'],
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  });
  const root = await mkdtemp(join(tmpdir(), 'scenebook-github-source-'));
  roots.push(root);
  const githubSource = new FakeGitHubSource();
  const uploadTokens = new UploadTokenService(SECRET);
  let idSequence = 0;
  const app = createControlPlaneApp({
    repository,
    objectStore: new FileSystemObjectStore(root),
    oidcVerifier: new UnusedOidcVerifier(),
    uploadTokens,
    identityTokens,
    runnerTokens: new RunnerTokenService(RUNNER_SECRET),
    hasher: new HmacHasher(SECRET),
    secretBox: new SecretBox(Buffer.alloc(32, 1).toString('base64url')),
    webhooks: new WebhookDispatcher([]),
    logger: createJsonLogger('error', () => undefined),
    adminToken: ADMIN,
    publicBaseUrl: 'https://control.example.com',
    publicationBaseUrl: 'https://stories.example.com',
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
      sessionTtlSeconds: 3_600,
      apiTokenMaxTtlSeconds: 86_400,
      shareLinkMaxTtlSeconds: 3_600,
    },
    runnerLeaseSeconds: 120,
    rateLimit: { requests: 1_000, aggregateRequests: 2_000, windowMs: 60_000 },
    githubSource,
    ...(options.githubChangeLeaseSeconds === undefined
      ? {}
      : { githubChangeLeaseSeconds: options.githubChangeLeaseSeconds }),
    ...(options.githubCheckReconcileTimeoutMs === undefined
      ? {}
      : { githubCheckReconcileTimeoutMs: options.githubCheckReconcileTimeoutMs }),
    now: () => new Date(NOW),
    id: (prefix) => `${prefix}-${++idSequence}`,
  });
  return {
    app,
    repository,
    repositoryBinding,
    githubSource,
    uploadTokens,
    token: generated.token,
  };
}

function authenticated(token: string, body?: unknown, extra: HeadersInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe('GitHub source patch constraints', () => {
  it('applies only unique locator and narrative anchors to bounded UTF-8 Scene source', () => {
    const canonicalPath = 'scenes/invite-member.scene/scene.yaml';
    const sourceText = readFileSync(
      new URL(
        '../../../examples/acme-product/scenes/invite-member.scene/scene.yaml',
        import.meta.url,
      ),
      'utf8',
    ).replace("getByRole('button', { name: 'Invite member' })", 'old-button');
    const source = new TextEncoder().encode(sourceText);
    const patched = applyGitHubPatch(
      source,
      [
        {
          kind: 'narrative',
          before: 'Invite a teammate',
          after: 'Invite a workspace teammate',
        },
        { kind: 'locator', before: 'old-button', after: 'invite-button' },
      ],
      canonicalPath,
    );
    expect(new TextDecoder().decode(patched)).toContain('title: Invite a workspace teammate');
    expect(new TextDecoder().decode(patched)).toContain('value: "invite-button"');
    expect(() =>
      applyGitHubPatch(
        source,
        [{ kind: 'locator', before: 'Invite member', after: 'Invite teammate' }],
        canonicalPath,
      ),
    ).toThrowError(GitHubSourceError);
    expect(() =>
      applyGitHubPatch(
        source,
        [{ kind: 'narrative', before: 'schemaVersion: 1', after: 'schemaVersion: 2' }],
        canonicalPath,
      ),
    ).toThrow(/authored scalar field|allowed authored field/u);
    expect(() => assertSafeGitHubSourcePath('../secrets.env')).toThrowError(GitHubSourceError);
    expect(() => assertSafeGitHubSourcePath('scenes/login/scene.yaml')).not.toThrow();
  });

  it('supports every authored Scene sidecar but never assets or arbitrary repository files', () => {
    for (const path of [
      'product/scenes/invite.scene/scene.yaml',
      'product/scenes/invite.scene/scene.yml',
      'product/scenes/invite.scene/scene.json',
      'product/scenes/invite.scene/narrative.mdx',
      'product/scenes/invite.scene/theme.yaml',
      'product/scenes/invite.scene/locales/pt-PT.yaml',
      'product/scenes/invite.scene/automation/replay.ts',
    ]) {
      expect(() => assertSafeGitHubSourcePath(path), path).not.toThrow();
    }
    for (const path of [
      'product/scenes/invite.scene/assets/theme.yaml',
      'product/scenes/invite.scene/assets/replay.ts',
      'product/scenes/invite.scene/assets/scenes/nested/scene.yaml',
      'product/scenes/locales/en.yaml',
      'product/scenes/automation/replay.ts',
      'product/scenes/invite.scene/locales/../../secret.yaml',
      'product/scenes/invite.scene/locales/not-a-locale.json',
      'product/scenes/invite.scene/automation/setup.ts',
      'product/scenes/invite.scene/scene.mdx',
      'product/theme.yaml',
    ]) {
      expect(() => assertSafeGitHubSourcePath(path), path).toThrowError(GitHubSourceError);
    }
  });

  it('validates structured sidecars and constrains MDX and replay edits against malformed output', () => {
    const sceneYaml = readFileSync(
      new URL(
        '../../../examples/acme-product/scenes/invite-member.scene/scene.yaml',
        import.meta.url,
      ),
      'utf8',
    );
    const sceneJson = JSON.stringify(parseSceneYaml(sceneYaml), null, 2);
    expect(
      new TextDecoder().decode(
        applyGitHubPatch(
          new TextEncoder().encode(sceneJson),
          [
            {
              kind: 'narrative',
              before: 'Invite a teammate',
              after: 'Invite a workspace teammate',
            },
          ],
          'scenes/invite-member.scene/scene.json',
        ),
      ),
    ).toContain('Invite a workspace teammate');
    for (const adversarialSource of [
      JSON.stringify(parseSceneYaml(sceneYaml)),
      stringifyYaml(parseSceneYaml(sceneYaml), { collectionStyle: 'flow', lineWidth: 0 }),
    ]) {
      expect(() =>
        applyGitHubPatch(
          new TextEncoder().encode(adversarialSource),
          [{ kind: 'locator', before: 'Invite a teammate', after: 'Compromised title' }],
          adversarialSource.startsWith('{"')
            ? 'scenes/invite-member.scene/scene.json'
            : 'scenes/invite-member.scene/scene.yaml',
        ),
      ).toThrow(/allowed authored field/u);
    }
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode(sceneYaml),
        [
          {
            kind: 'narrative',
            before: 'title: Invite a teammate',
            after: 'title: Strict JSON',
          },
        ],
        'scenes/invite-member.scene/scene.json',
      ),
    ).toThrow(/strict JSON syntax/u);
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode(
          sceneJson.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'),
        ),
        [
          {
            kind: 'narrative',
            before: 'Invite a teammate',
            after: 'Invite a workspace teammate',
          },
        ],
        'scenes/invite-member.scene/scene.json',
      ),
    ).toThrow(/valid authored Scene content/u);
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode(sceneYaml),
        [
          {
            kind: 'narrative',
            before: 'Invite a teammate',
            after: '',
          },
        ],
        'scenes/invite-member.scene/scene.yaml',
      ),
    ).toThrow(/not valid authored Scene content/u);

    expect(
      new TextDecoder().decode(
        applyGitHubPatch(
          new TextEncoder().encode('accent: "#c2412d"\nradius: 17\n'),
          [{ kind: 'presentation', before: '#c2412d', after: '#0f766e' }],
          'scenes/invite-member.scene/theme.yaml',
        ),
      ),
    ).toContain('#0f766e');
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode('accent: "#c2412d"\n'),
        [{ kind: 'presentation', before: '"#c2412d"', after: '[' }],
        'scenes/invite-member.scene/theme.yaml',
      ),
    ).toThrow(/not valid authored Scene content/u);

    expect(
      new TextDecoder().decode(
        applyGitHubPatch(
          new TextEncoder().encode('title: Invite\nsteps: {}\n'),
          [{ kind: 'narrative', before: 'Invite', after: 'Convidar' }],
          'scenes/invite-member.scene/locales/pt.yaml',
        ),
      ),
    ).toContain('Convidar');
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode('title: Invite\nsteps: {}\n'),
        [{ kind: 'narrative', before: 'Invite', after: '[' }],
        'scenes/invite-member.scene/locales/en.yaml',
      ),
    ).toThrow(/not valid authored Scene content/u);

    const narrative = '# Invite a teammate\n\nOpen the invitation form.\n';
    expect(
      new TextDecoder().decode(
        applyGitHubPatch(
          new TextEncoder().encode(narrative),
          [{ kind: 'narrative', before: 'invitation form', after: 'member form' }],
          'scenes/invite-member.scene/narrative.mdx',
        ),
      ),
    ).toContain('member form');
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode(narrative),
        [{ kind: 'narrative', before: 'invitation form', after: '{broken' }],
        'scenes/invite-member.scene/narrative.mdx',
      ),
    ).toThrow(/plain editorial text/u);
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode('# Broken\n\n{expression\n'),
        [{ kind: 'narrative', before: 'Broken', after: 'Still broken' }],
        'scenes/invite-member.scene/narrative.mdx',
      ),
    ).toThrow(/valid MDX/u);
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode('# Broken component\n\n<Widget\n'),
        [{ kind: 'narrative', before: 'Broken component', after: 'Still broken' }],
        'scenes/invite-member.scene/narrative.mdx',
      ),
    ).toThrow(/valid MDX/u);

    const replay =
      "import { test } from '@playwright/test';\ntest('invite', async ({ page }) => { await page.getByRole('button', { name: 'Invite' }).click(); });\n";
    expect(
      new TextDecoder().decode(
        applyGitHubPatch(
          new TextEncoder().encode(replay),
          [{ kind: 'locator', before: 'Invite', after: 'Invite member' }],
          'scenes/invite-member.scene/automation/replay.ts',
        ),
      ),
    ).toContain("name: 'Invite member'");
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode(replay),
        [{ kind: 'locator', before: 'Invite', after: "Invite'" }],
        'scenes/invite-member.scene/automation/replay.ts',
      ),
    ).toThrow(/string-literal syntax/u);
    expect(() =>
      applyGitHubPatch(
        new TextEncoder().encode("test('broken', async () => {\n"),
        [{ kind: 'locator', before: 'broken', after: 'fixed' }],
        'scenes/invite-member.scene/automation/replay.ts',
      ),
    ).toThrow(/invalid TypeScript syntax/u);
  });

  it('uses only the configured API origin and exchanges a short-lived App installation token', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const requests: Array<{
      url: string;
      authorization: string | null;
      redirect: RequestRedirect;
    }> = [];
    const sourceBytes = Buffer.from('title: Exact source\n');
    const sourceBlobSha = createHash('sha1')
      .update(Buffer.from(`blob ${sourceBytes.byteLength}\0`))
      .update(sourceBytes)
      .digest('hex');
    const client = new RemoteGitHubAppSourceClient({
      appId: '1234',
      privateKeyPem,
      apiBaseUrl: 'https://github-api.operator.example',
      now: () => new Date(NOW),
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(url),
          authorization: headers.get('authorization'),
          redirect: init?.redirect ?? 'follow',
        });
        if (String(url).endsWith('/app/installations/123456/access_tokens')) {
          return Response.json({
            token: 'ghs_transient_installation_token_123456789',
            expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
          });
        }
        if (String(url).includes('/git/commits/')) return Response.json({ sha: 'a'.repeat(40) });
        if (String(url).includes('/contents/')) {
          return Response.json({
            type: 'file',
            sha: sourceBlobSha,
            size: sourceBytes.byteLength,
            encoding: 'base64',
            content: sourceBytes.toString('base64'),
          });
        }
        return Response.json({ id: 987654, full_name: 'acme/product', default_branch: 'main' });
      },
    });
    await expect(
      client.inspectInstallation({ installationId: '123456', repository: 'acme/product' }),
    ).resolves.toEqual({
      repositoryId: '987654',
      repository: 'acme/product',
      defaultBranch: 'main',
    });
    await expect(
      client.readSource({
        installationId: '123456',
        repository: 'acme/product',
        commitSha: 'a'.repeat(40),
        path: 'scenes/invite/scene.yaml',
      }),
    ).resolves.toEqual({
      commitSha: 'a'.repeat(40),
      blobSha: sourceBlobSha,
      byteLength: sourceBytes.byteLength,
      content: 'title: Exact source\n',
    });
    expect(requests.map((request) => request.url)).toEqual([
      'https://github-api.operator.example/app/installations/123456/access_tokens',
      'https://github-api.operator.example/repos/acme/product',
      `https://github-api.operator.example/repos/acme/product/git/commits/${'a'.repeat(40)}`,
      `https://github-api.operator.example/repos/acme/product/contents/scenes/invite/scene.yaml?ref=${'a'.repeat(40)}`,
    ]);
    expect(requests.every((request) => request.redirect === 'error')).toBe(true);
    expect(requests[0]?.authorization).toMatch(/^Bearer /u);
    expect(
      requests
        .slice(1)
        .every(
          (request) =>
            request.authorization === 'Bearer ghs_transient_installation_token_123456789',
        ),
    ).toBe(true);
    expect(
      () =>
        new RemoteGitHubAppSourceClient({
          appId: '1234',
          privateKeyPem,
          apiBaseUrl: 'https://github-api.operator.example/attacker-controlled',
        }),
    ).toThrow(/origin/u);
  });

  it('creates and updates one exact-SHA App-owned Check Run with the installation token', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const commitSha = 'a'.repeat(40);
    const externalId = `scenebook:${'b'.repeat(64)}`;
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body?: unknown;
    }> = [];
    let listCount = 0;
    let remoteStatus: 'in_progress' | 'completed' = 'in_progress';
    let paginatedExternalId: string | undefined;
    const check = (status: 'in_progress' | 'completed', id = 77, checkExternalId = externalId) => ({
      id,
      name: 'Scenebook',
      head_sha: commitSha,
      external_id: checkExternalId,
      status,
      conclusion: status === 'completed' ? 'success' : null,
      html_url: 'https://github.com/acme/product/runs/77',
    });
    const client = new RemoteGitHubAppSourceClient({
      appId: '1234',
      privateKeyPem,
      apiBaseUrl: 'https://api.github.com',
      now: () => new Date(NOW),
      fetchImpl: async (url, init) => {
        const method = init?.method ?? 'GET';
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        requests.push({
          url: String(url),
          method,
          authorization: new Headers(init?.headers).get('authorization'),
          ...(body === undefined ? {} : { body }),
        });
        if (String(url).endsWith('/app/installations/123456/access_tokens')) {
          return Response.json({
            token: 'ghs_transient_installation_token_123456789',
            expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
          });
        }
        if (String(url).includes('/git/commits/')) return Response.json({ sha: commitSha });
        if (String(url).includes(`/commits/${commitSha}/check-runs?`)) {
          if (paginatedExternalId) {
            const page = new URL(String(url)).searchParams.get('page');
            return Response.json(
              page === '1'
                ? {
                    total_count: 102,
                    check_runs: Array.from({ length: 100 }, (_, index) =>
                      check('completed', 1_000 + index, `unrelated-${index}`),
                    ),
                  }
                : {
                    total_count: 102,
                    check_runs: [
                      check('in_progress', 88, paginatedExternalId),
                      check('in_progress', 77, paginatedExternalId),
                    ],
                  },
            );
          }
          listCount += 1;
          return Response.json(
            listCount === 1
              ? { total_count: 0, check_runs: [] }
              : { total_count: 1, check_runs: [check(remoteStatus)] },
          );
        }
        if (method === 'POST') {
          remoteStatus = 'in_progress';
          return Response.json(check('in_progress'));
        }
        if (method === 'PATCH') {
          remoteStatus = 'completed';
          return Response.json(
            check(
              'completed',
              String(url).endsWith('/77') ? 77 : 88,
              paginatedExternalId ?? externalId,
            ),
          );
        }
        throw new Error(`Unexpected GitHub request: ${method} ${url}`);
      },
    });
    const baseState = {
      externalId,
      commitSha,
      title: 'Scenebook verification is running',
      summary: 'Waiting for exact Build evidence.',
      detailsUrl: 'https://control.example.com/console',
    };
    await expect(
      client.ensureCheckRun({
        installationId: '123456',
        repository: 'acme/product',
        state: { ...baseState, status: 'in_progress' },
      }),
    ).resolves.toMatchObject({ id: 77, commitSha, status: 'in_progress' });
    await expect(
      client.ensureCheckRun({
        installationId: '123456',
        repository: 'acme/product',
        state: { ...baseState, status: 'completed', conclusion: 'success' },
      }),
    ).resolves.toMatchObject({ id: 77, commitSha, status: 'completed', conclusion: 'success' });
    await expect(
      client.ensureCheckRun({
        installationId: '123456',
        repository: 'acme/product',
        state: { ...baseState, status: 'in_progress' },
      }),
    ).rejects.toThrow(/cannot be regressed/u);
    const mutations = requests.filter((request) => request.method !== 'GET');
    expect(mutations.map((request) => request.method)).toEqual(['POST', 'POST', 'PATCH']);
    expect(
      mutations
        .slice(1)
        .every(
          (request) =>
            request.authorization === 'Bearer ghs_transient_installation_token_123456789',
        ),
    ).toBe(true);
    expect(mutations[1]?.body).toMatchObject({
      name: 'Scenebook',
      head_sha: commitSha,
      external_id: externalId,
      status: 'in_progress',
    });
    expect(mutations[2]?.body).toMatchObject({
      external_id: externalId,
      status: 'completed',
      conclusion: 'success',
    });
    expect(mutations[2]?.body).not.toHaveProperty('head_sha');

    paginatedExternalId = `scenebook:${'c'.repeat(64)}`;
    await expect(
      client.ensureCheckRun({
        installationId: '123456',
        repository: 'acme/product',
        state: {
          ...baseState,
          externalId: paginatedExternalId,
          status: 'completed',
          conclusion: 'success',
        },
      }),
    ).resolves.toMatchObject({ id: 77, status: 'completed' });
    expect(requests.some((request) => request.url.includes('page=2'))).toBe(true);
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH' });
    expect(requests.at(-1)?.url).toMatch(/check-runs\/77$/u);
  });

  it('requires operator allowlisting for every enterprise GitHub API origin', () => {
    const fakeKey = `-----BEGIN PRIVATE KEY-----\n${'a'.repeat(160)}\n-----END PRIVATE KEY-----`;
    const identityKeys = generateKeyPairSync('ed25519');
    const identityPrivateKey = identityKeys.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const identityPublicKey = identityKeys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      SCENEBOOK_PUBLIC_URL: 'https://control.example.com',
      SCENEBOOK_PUBLICATION_URL: 'https://stories.example.com',
      DATABASE_URL: 'postgresql://scenebook@example.com/scenebook',
      SCENEBOOK_ADMIN_TOKEN: 'a'.repeat(64),
      SCENEBOOK_UPLOAD_TOKEN_SECRET: 'b'.repeat(64),
      SCENEBOOK_IDENTITY_TOKEN_SECRET: 'c'.repeat(64),
      SCENEBOOK_IDENTITY_SIGNING_PRIVATE_KEY: identityPrivateKey,
      SCENEBOOK_IDENTITY_VERIFICATION_PUBLIC_KEY: identityPublicKey,
      SCENEBOOK_RUNNER_TOKEN_SECRET: 'd'.repeat(64),
      SCENEBOOK_ANALYTICS_HASH_SECRET: 'e'.repeat(64),
      SCENEBOOK_GATEWAY_EXCHANGE_SECRET: 'f'.repeat(64),
      SCENEBOOK_CTA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64url'),
      SCENEBOOK_GITHUB_APP_ID: '1234',
      SCENEBOOK_GITHUB_APP_PRIVATE_KEY: fakeKey,
      SCENEBOOK_GITHUB_APP_API_URL: 'https://github-api.enterprise.example',
    };
    expect(() => loadServerConfig(environment)).toThrow(/allowlist/u);
    const configured = loadServerConfig({
      ...environment,
      SCENEBOOK_GITHUB_APP_ALLOWED_API_ORIGINS: 'https://github-api.enterprise.example',
    });
    expect(configured.githubApp).toMatchObject({
      kind: 'enabled',
      apiBaseUrl: 'https://github-api.enterprise.example',
    });
  });
});

describe('GitHub source API', () => {
  it('serializes Check reconciliation for one deterministic external identity', async () => {
    const repository = new MemoryControlPlaneRepository();
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.withGitHubCheckRunLock('installation\0repository\0sha\0build', async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
        }),
      ),
    );
    expect(maximum).toBe(1);
  });

  it('owns the Check lifecycle while customer Actions retain execution', async () => {
    const { app, repository, repositoryBinding, githubSource, uploadTokens, token } = await fixture(
      { githubCheckReconcileTimeoutMs: 20 },
    );
    const githubBase = '/v1/admin/workspaces/workspace-1/projects/project-1/github';
    const bound = await app.request(
      `${githubBase}/installations`,
      authenticated(token, {
        repositoryBindingId: repositoryBinding.id,
        installationId: '123456',
      }),
    );
    expect(bound.status).toBe(201);

    const uploadToken = await uploadTokens.issue(
      {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: 'acme/product',
        commit: 'a'.repeat(40),
        ref: 'refs/pull/42/merge',
        workflowRef: 'acme/product/.github/workflows/scenebook.yml@refs/heads/main',
        permissions: ['artifact:write'],
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 300,
        tokenId: 'upload-token-check-run',
      },
      Math.floor(NOW.getTime() / 1_000),
    );
    const upload = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${uploadToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'check-run-upload',
      },
      body: JSON.stringify({
        objects: [{ sha256: 'e'.repeat(64), byteLength: 2, mediaType: 'application/json' }],
      }),
    });
    expect(upload.status).toBe(201);
    expect(githubSource.checks).toHaveLength(0);

    const build = BuildArtifactSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'build-check-run',
      kind: 'build',
      projectId: 'project-1',
      createdAt: NOW.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      repository: {
        provider: 'github',
        repository: 'acme/product',
        commit: 'a'.repeat(40),
        dirty: false,
      },
      trigger: 'pull-request',
      completeness: 'complete',
      status: 'changed',
      expectedRunPlan: [{ sceneId: 'scene-check', runTargetId: 'primary', required: true }],
      runs: [
        {
          sceneId: 'scene-check',
          runTargetId: 'primary',
          required: true,
          status: 'passed',
          changeState: 'changed',
        },
      ],
      startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
      summary: { total: 1, passed: 0, changed: 1, broken: 0, blocked: 0, pending: 0 },
    });
    const buildRevision = artifactHash(build);
    await repository.recordVerificationBuild({
      id: build.id,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifactHash: buildRevision,
      build,
      idempotencyKey: 'build-check-run',
      requestHash: 'b'.repeat(64),
      recordedBy: 'github-actions',
      recordedAt: NOW.toISOString(),
    });
    const review = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
      authenticated(token, {
        review: {
          schemaVersion: 1,
          artifactVersion: 1,
          id: 'review-check-run',
          kind: 'review',
          projectId: 'project-1',
          createdAt: NOW.toISOString(),
          producer: { name: 'scenebook', version: '0.1.0' },
          subject: { kind: 'build', id: build.id, revision: buildRevision },
          status: 'open',
          changeState: 'changed',
          openedAt: NOW.toISOString(),
        },
      }),
    );
    expect(review.status).toBe(201);
    expect(githubSource.checks.at(-1)).toMatchObject({
      commitSha: 'a'.repeat(40),
      status: 'in_progress',
      title: 'Scenebook verification is awaiting review',
    });
    const firstBuildExternalId = githubSource.checks.at(-1)!.externalId;

    const approved = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews/review-check-run/decisions',
      authenticated(token, { decision: 'approve' }),
    );
    expect(approved.status).toBe(201);
    expect(githubSource.checks.at(-1)).toMatchObject({
      commitSha: 'a'.repeat(40),
      status: 'completed',
      conclusion: 'success',
      title: 'Scenebook verification passed',
    });
    expect(githubSource.checks.at(-1)?.externalId).toBe(firstBuildExternalId);

    const alternateReview = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
      authenticated(token, {
        review: {
          schemaVersion: 1,
          artifactVersion: 1,
          id: 'review-check-run-alternate',
          kind: 'review',
          projectId: 'project-1',
          createdAt: NOW.toISOString(),
          producer: { name: 'scenebook', version: '0.1.0' },
          subject: { kind: 'build', id: build.id, revision: buildRevision },
          status: 'open',
          changeState: 'changed',
          openedAt: NOW.toISOString(),
        },
      }),
    );
    expect(alternateReview.status).toBe(201);
    const alternateReviewExternalId = githubSource.checks.at(-1)!.externalId;
    expect(alternateReviewExternalId).not.toBe(firstBuildExternalId);

    const secondBuild = BuildArtifactSchema.parse({ ...build, id: 'build-check-run-2' });
    const secondBuildRevision = artifactHash(secondBuild);
    await repository.recordVerificationBuild({
      id: secondBuild.id,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifactHash: secondBuildRevision,
      build: secondBuild,
      idempotencyKey: 'build-check-run-2',
      requestHash: 'c'.repeat(64),
      recordedBy: 'github-actions',
      recordedAt: NOW.toISOString(),
    });
    const secondReviewBody = {
      review: {
        schemaVersion: 1,
        artifactVersion: 1,
        id: 'review-check-run-2',
        kind: 'review',
        projectId: 'project-1',
        createdAt: NOW.toISOString(),
        producer: { name: 'scenebook', version: '0.1.0' },
        subject: { kind: 'build', id: secondBuild.id, revision: secondBuildRevision },
        status: 'open',
        changeState: 'changed',
        openedAt: NOW.toISOString(),
      },
    } as const;
    const blockedCheck = githubSource.blockNextCheck();
    const timedOutReview = app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
      authenticated(token, secondReviewBody),
    );
    await blockedCheck.started;
    const timedOutResponse = await timedOutReview;
    blockedCheck.release();
    expect(timedOutResponse.status).toBe(503);
    expect(await timedOutResponse.json()).toMatchObject({
      error: { code: 'github_unavailable', details: { retryable: true } },
    });
    const secondReview = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
      authenticated(token, secondReviewBody),
    );
    expect(secondReview.status).toBe(200);
    expect(githubSource.checks.at(-1)?.commitSha).toBe('a'.repeat(40));
    expect(githubSource.checks.at(-1)?.externalId).not.toBe(firstBuildExternalId);
    expect(githubSource.checks.at(-1)?.externalId).not.toBe(alternateReviewExternalId);
  });

  it('binds live installations, reads exact SHAs, and creates one idempotent explicit change', async () => {
    const { app, repository, repositoryBinding, githubSource, token } = await fixture();
    const base = '/v1/admin/workspaces/workspace-1/projects/project-1/github';
    const bound = await app.request(
      `${base}/installations`,
      authenticated(token, {
        repositoryBindingId: repositoryBinding.id,
        installationId: '123456',
      }),
    );
    expect(bound.status).toBe(201);
    const installation = (await bound.json()) as { installation: { id: string; version: number } };
    expect(JSON.stringify(installation)).not.toContain('123456');

    const source = await app.request(
      `${base}/source/read`,
      authenticated(token, {
        installationBindingId: installation.installation.id,
        commitSha: 'a'.repeat(40),
        path: 'product/scenes/invite/scene.yaml',
      }),
    );
    expect(source.status).toBe(200);
    expect(source.headers.get('cache-control')).toBe('no-store');
    expect(await source.json()).toMatchObject({
      source: { commitSha: 'a'.repeat(40), blobSha: 'b'.repeat(40) },
    });

    const request = {
      installationBindingId: installation.installation.id,
      baseCommitSha: 'a'.repeat(40),
      expectedBlobSha: 'b'.repeat(40),
      path: 'product/scenes/invite/scene.yaml',
      operations: [{ kind: 'locator', before: 'old-button', after: 'invite-button' }],
      title: 'Repair invite locator',
      createReviewIssue: true,
    };
    const created = await app.request(
      `${base}/changes`,
      authenticated(token, request, { 'idempotency-key': 'repair-invite-1' }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { change: { id: string } };
    expect(githubSource.changes).toBe(1);
    const replay = await app.request(
      `${base}/changes`,
      authenticated(token, request, { 'idempotency-key': 'repair-invite-1' }),
    );
    expect(replay.status).toBe(200);
    expect(githubSource.changes).toBe(1);
    const conflict = await app.request(
      `${base}/changes`,
      authenticated(
        token,
        { ...request, title: 'Different mutation' },
        { 'idempotency-key': 'repair-invite-1' },
      ),
    );
    expect(conflict.status).toBe(409);

    const successAudit = repository.audits.find(
      (event) => event.action === 'github-source.change-succeeded',
    );
    expect(successAudit?.metadata).toMatchObject({
      baseCommitSha: 'a'.repeat(40),
      baseBlobSha: 'b'.repeat(40),
      headCommitSha: 'c'.repeat(40),
      pullRequestNumber: 42,
    });
    expect(JSON.stringify(successAudit)).not.toContain('product/scenes/invite/scene.yaml');

    await repository.revokeWorkspaceMembership('workspace-1', 'user-1', NOW.toISOString());
    const revoked = await app.request(`${base}/changes/${createdBody.change.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(403);
  });

  it('serializes concurrent requests and safely retries a recoverable remote failure', async () => {
    const { app, repositoryBinding, githubSource, token } = await fixture();
    const base = '/v1/admin/workspaces/workspace-1/projects/project-1/github';
    const bound = await app.request(
      `${base}/installations`,
      authenticated(token, {
        repositoryBindingId: repositoryBinding.id,
        installationId: '123456',
      }),
    );
    const installation = (await bound.json()) as { installation: { id: string } };
    const request = {
      installationBindingId: installation.installation.id,
      baseCommitSha: 'a'.repeat(40),
      expectedBlobSha: 'b'.repeat(40),
      path: 'scenes/invite/scene.yaml',
      operations: [{ kind: 'locator', before: 'old-button', after: 'invite-button' }],
      title: 'Repair invite locator',
    };

    const block = githubSource.blockNextChange();
    const pending = app.request(
      `${base}/changes`,
      authenticated(token, request, { 'idempotency-key': 'concurrent-change' }),
    );
    await block.started;
    const concurrent = await app.request(
      `${base}/changes`,
      authenticated(token, request, { 'idempotency-key': 'concurrent-change' }),
    );
    expect(concurrent.status).toBe(409);
    expect((await concurrent.json()) as unknown).toMatchObject({
      error: { code: 'github_change_in_progress' },
    });
    block.release();
    expect((await pending).status).toBe(201);

    githubSource.failuresRemaining = 1;
    const failed = await app.request(
      `${base}/changes`,
      authenticated(token, request, { 'idempotency-key': 'retry-change' }),
    );
    expect(failed.status).toBe(503);
    expect((await failed.json()) as unknown).toMatchObject({
      error: { code: 'github_unavailable', details: { retryable: true } },
    });
    const retried = await app.request(
      `${base}/changes`,
      authenticated(token, request, { 'idempotency-key': 'retry-change' }),
    );
    expect(retried.status).toBe(201);
    expect(githubSource.changes).toBe(3);
  });

  it('aborts remote work and fails closed when the exact renewable lease is lost', async () => {
    const { app, repository, repositoryBinding, githubSource, token } = await fixture({
      githubChangeLeaseSeconds: 0.06,
    });
    const base = '/v1/admin/workspaces/workspace-1/projects/project-1/github';
    const bound = await app.request(
      `${base}/installations`,
      authenticated(token, {
        repositoryBindingId: repositoryBinding.id,
        installationId: '123456',
      }),
    );
    const installation = (await bound.json()) as { installation: { id: string } };
    const block = githubSource.blockNextChange();
    const pending = app.request(
      `${base}/changes`,
      authenticated(
        token,
        {
          installationBindingId: installation.installation.id,
          baseCommitSha: 'a'.repeat(40),
          expectedBlobSha: 'b'.repeat(40),
          path: 'scenes/invite/scene.yaml',
          operations: [{ kind: 'locator', before: 'old-button', after: 'invite-button' }],
          title: 'Lease ownership test',
        },
        { 'idempotency-key': 'lease-loss' },
      ),
    );
    await block.started;
    const active = [...repository.githubSourceChanges.values()][0]!;
    repository.githubSourceChanges.set(active.id, {
      ...active,
      leaseId: 'github-lease-stolen',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    block.release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'github_lease_lost' } });
    expect(repository.githubSourceChanges.get(active.id)).toMatchObject({
      status: 'pending',
      leaseId: 'github-lease-stolen',
    });
  });

  it('rejects unsafe paths, forged evidence bindings, and a revoked installation', async () => {
    const { app, repositoryBinding, token } = await fixture();
    const base = '/v1/admin/workspaces/workspace-1/projects/project-1/github';
    const bound = await app.request(
      `${base}/installations`,
      authenticated(token, {
        repositoryBindingId: repositoryBinding.id,
        installationId: '123456',
      }),
    );
    const installation = (await bound.json()) as { installation: { id: string; version: number } };
    const unsafe = await app.request(
      `${base}/source/read`,
      authenticated(token, {
        installationBindingId: installation.installation.id,
        commitSha: 'a'.repeat(40),
        path: '../private.key',
      }),
    );
    expect(unsafe.status).toBe(422);
    const forged = await app.request(
      `${base}/changes`,
      authenticated(
        token,
        {
          installationBindingId: installation.installation.id,
          baseCommitSha: 'a'.repeat(40),
          expectedBlobSha: 'b'.repeat(40),
          path: 'scenes/invite/scene.yaml',
          operations: [{ kind: 'narrative', before: 'Invite', after: 'Invite someone' }],
          title: 'Update narrative',
          evidence: { runId: 'missing-run', runArtifactHash: 'f'.repeat(64) },
        },
        { 'idempotency-key': 'forged-evidence' },
      ),
    );
    expect(forged.status).toBe(422);
    expect((await forged.json()) as unknown).toMatchObject({
      error: { code: 'evidence_binding_mismatch' },
    });

    const revoked = await app.request(`${base}/installations/${installation.installation.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: installation.installation.version }),
    });
    expect(revoked.status).toBe(200);
    const readAfterRevoke = await app.request(
      `${base}/source/read`,
      authenticated(token, {
        installationBindingId: installation.installation.id,
        commitSha: 'a'.repeat(40),
        path: 'scenes/invite/scene.yaml',
      }),
    );
    expect(readAfterRevoke.status).toBe(403);
  });
});
