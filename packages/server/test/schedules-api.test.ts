import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactHash } from '@scenebook/core';
import { BuildArtifactSchema } from '@scenebook/schema';

import { createControlPlaneApp } from '../src/app.js';
import { IdentityTokenService } from '../src/auth.js';
import { HmacHasher, SecretBox, UploadTokenService } from '../src/crypto.js';
import { createJsonLogger } from '../src/logger.js';
import { MetricsRegistry } from '../src/metrics.js';
import { FileSystemObjectStore } from '../src/object-store.js';
import type { GitHubOidcVerifier } from '../src/oidc.js';
import { RunnerTokenService } from '../src/runner-token.js';
import { VerificationScheduleWorker } from '../src/schedule-worker.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import { WebhookDispatcher } from '../src/webhook.js';
import type { ControlPlaneRepository } from '../src/repository.js';

const ADMIN = 'operator-secret-'.padEnd(64, 'a');
const UPLOAD_SECRET = 'upload-secret-'.padEnd(64, 'u');
const IDENTITY_SECRET = 'identity-secret-'.padEnd(64, 'i');
const RUNNER_SECRET = 'runner-secret-'.padEnd(64, 'r');
const START = new Date('2026-07-21T10:00:00.000Z');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-schedules-'));
  roots.push(root);
  const repository = new MemoryControlPlaneRepository();
  const clock = { value: new Date(START) };
  let sequence = 0;
  const metrics = new MetricsRegistry();
  const logger = createJsonLogger('error', () => undefined);
  const runnerTokens = new RunnerTokenService(RUNNER_SECRET);
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
    runnerTokens,
    hasher: new HmacHasher('hash-secret-'.padEnd(64, 'h')),
    secretBox: new SecretBox(Buffer.alloc(32, 8).toString('base64url')),
    webhooks: new WebhookDispatcher([]),
    logger,
    metrics,
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
    runnerLeaseSeconds: 120,
    rateLimit: { requests: 1_000, aggregateRequests: 10_000, windowMs: 60_000 },
    now: () => new Date(clock.value),
    id: (prefix) => `${prefix}-${++sequence}`,
  });
  const worker = new VerificationScheduleWorker({
    repository,
    logger,
    metrics,
    intervalMs: 5_000,
    batchSize: 100,
    now: () => new Date(clock.value),
  });
  return { app, repository, clock, worker, runnerTokens, metrics };
}

function request(
  token: string,
  body: unknown,
  method = 'POST',
  headers: HeadersInit = {},
): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function get(token = ADMIN): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
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
  const response = await app.request(
    '/v1/admin/workspaces/workspace-1/projects/project-1/repositories',
    request(ADMIN, {
      repository: 'acme/product',
      workflowRefPattern: 'acme/product/.github/workflows/scenebook.yml@refs/heads/main',
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { repository: { id: string } }).repository.id;
}

async function createSchedule(
  app: ReturnType<typeof createControlPlaneApp>,
  repositoryBindingId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const response = await app.request(
    '/v1/admin/workspaces/workspace-1/projects/project-1/schedules',
    request(ADMIN, {
      id: 'schedule-1',
      repositoryBindingId,
      name: 'Nightly critical journeys',
      sourceRef: 'refs/heads/main',
      environmentId: 'staging',
      runTargetIds: ['desktop-en'],
      intervalSeconds: 3_600,
      freshnessTargetSeconds: 7_200,
      maxRuntimeSeconds: 1_800,
      maxAttempts: 2,
      ...overrides,
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { schedule: { id: string } }).schedule;
}

async function createRunner(app: ReturnType<typeof createControlPlaneApp>) {
  const response = await app.request(
    '/v1/admin/workspaces/workspace-1/projects/project-1/runners',
    request(ADMIN, {
      id: 'runner-1',
      name: 'Private staging runner',
      scheduleIds: ['schedule-1'],
      expiresAt: '2026-07-22T10:00:00.000Z',
    }),
  );
  expect(response.status).toBe(201);
  const value = (await response.json()) as {
    runner: Record<string, unknown>;
    credential: string;
  };
  expect(value.runner).not.toHaveProperty('tokenHash');
  expect(value.credential).toMatch(/^sbk_runner\.runner-1\./u);
  return value.credential;
}

describe('scheduled verification coordination', () => {
  it('starts once and stops recurring scheduling work cleanly', async () => {
    vi.useFakeTimers();
    try {
      let passes = 0;
      const repository = {
        requeueExpiredVerificationJobs: async () => {
          passes += 1;
          return [];
        },
        materializeDueVerificationJobs: async () => [],
      } as unknown as ControlPlaneRepository;
      const worker = new VerificationScheduleWorker({
        repository,
        logger: createJsonLogger('error', () => undefined),
        metrics: new MetricsRegistry(),
        intervalMs: 1_000,
        batchSize: 10,
      });
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(passes).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(passes).toBe(2);
      worker.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(passes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('durably schedules, leases, renews, and completes only server-bound Build evidence', async () => {
    const { app, repository, worker } = await fixture();
    const bindingId = await bootstrap(app);
    const bindings = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/repositories',
      get(),
    );
    expect(bindings.status).toBe(200);
    expect(await bindings.json()).toMatchObject({
      repositories: [{ id: bindingId, repository: 'acme/product' }],
    });
    expect(repository.audits.map((event) => event.action)).toContain('repository.bound');
    await createSchedule(app, bindingId);
    const credential = await createRunner(app);

    expect(await worker.runOnce()).toEqual({ enqueued: 1, recovered: 0 });
    const claim = await app.request('/v1/runner/jobs/claim', request(credential, {}));
    expect(claim.status).toBe(200);
    const job = ((await claim.json()) as { job: any }).job;
    expect(job.execution).toEqual({
      protocolVersion: 1,
      repository: 'acme/product',
      sourceRef: 'refs/heads/main',
      environmentId: 'staging',
      runTargetIds: ['desktop-en'],
      expectedBuildId: job.execution.expectedBuildId,
    });
    expect(JSON.stringify(job.execution)).not.toMatch(/https?:|command|secret|credential/iu);

    const heartbeat = await app.request(
      `/v1/runner/jobs/${job.id}/heartbeat`,
      request(credential, { leaseId: job.leaseId }),
    );
    expect(heartbeat.status).toBe(200);

    const wrong = await app.request(
      `/v1/runner/jobs/${job.id}/complete`,
      request(credential, {
        outcome: 'verified',
        leaseId: job.leaseId,
        buildId: 'build-caller-chosen',
      }),
    );
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ error: { code: 'unexpected_verification_build' } });

    const build = BuildArtifactSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: job.execution.expectedBuildId,
      kind: 'build',
      projectId: 'project-1',
      createdAt: START.toISOString(),
      producer: { name: 'scenebook', version: '0.1.0' },
      repository: {
        provider: 'github',
        repository: 'acme/product',
        commit: 'a'.repeat(40),
        branch: 'main',
        ref: 'refs/heads/main',
        dirty: false,
      },
      trigger: 'schedule',
      completeness: 'complete',
      status: 'passed',
      expectedRunPlan: [{ sceneId: 'scene-1', runTargetId: 'desktop-en', required: true }],
      runs: [
        {
          sceneId: 'scene-1',
          runTargetId: 'desktop-en',
          required: true,
          status: 'passed',
          changeState: 'passed',
        },
      ],
      startedAt: START.toISOString(),
      endedAt: START.toISOString(),
      summary: { total: 1, passed: 1, changed: 0, broken: 0, blocked: 0, pending: 0 },
    });
    repository.verificationBuilds.set(build.id, {
      id: build.id,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      artifactHash: artifactHash(build),
      build,
      idempotencyKey: 'build-evidence-1',
      requestHash: 'b'.repeat(64),
      recordedBy: 'private-runner-uploader',
      recordedAt: START.toISOString(),
    });
    const completed = await app.request(
      `/v1/runner/jobs/${job.id}/complete`,
      request(credential, {
        outcome: 'verified',
        leaseId: job.leaseId,
        buildId: build.id,
      }),
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      job: {
        state: 'succeeded',
        result: { outcome: 'verified', buildId: build.id, buildStatus: 'passed' },
      },
    });
    const schedule = await repository.getVerificationSchedule(
      'workspace-1',
      'project-1',
      'schedule-1',
    );
    expect(schedule?.lastSuccessfulAt).toBe(START.toISOString());
  });

  it('recovers expired leases, exhausts attempts, and emits append-only scheduler audit', async () => {
    const { app, repository, worker, clock, metrics } = await fixture();
    const bindingId = await bootstrap(app);
    await createSchedule(app, bindingId, { maxAttempts: 1 });
    const credential = await createRunner(app);
    await worker.runOnce();
    const claim = await app.request('/v1/runner/jobs/claim', request(credential, {}));
    expect(claim.status).toBe(200);
    clock.value = new Date(START.getTime() + 121_000);
    expect(await worker.runOnce()).toEqual({ enqueued: 0, recovered: 1 });
    const jobs = await repository.listVerificationJobs(
      'workspace-1',
      'project-1',
      'schedule-1',
      10,
    );
    expect(jobs[0]).toMatchObject({
      state: 'failed',
      result: { outcome: 'runner-failed', failureCode: 'lease-expired' },
    });
    expect(repository.audits.map((event) => event.action)).toContain(
      'verification.job-lease-exhausted',
    );
    expect(metrics.render()).toContain('scenebook_verification_job_leases_recovered_total 1');
  });

  it('supports pause/resume and idempotent manual triggers without executing paused schedules', async () => {
    const { app, repository, worker } = await fixture();
    const bindingId = await bootstrap(app);
    await createSchedule(app, bindingId);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/schedules/schedule-1/pause',
          request(ADMIN, {}),
        )
      ).status,
    ).toBe(200);
    expect(await worker.runOnce()).toEqual({ enqueued: 0, recovered: 0 });

    const first = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/schedules/schedule-1/trigger',
      request(ADMIN, {}, 'POST', { 'idempotency-key': 'manual-check-1' }),
    );
    const second = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/schedules/schedule-1/trigger',
      request(ADMIN, {}, 'POST', { 'idempotency-key': 'manual-check-1' }),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(((await first.json()) as any).job.id).toBe(((await second.json()) as any).job.id);
    expect(repository.verificationJobs.size).toBe(1);

    const resume = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/schedules/schedule-1/resume',
      request(ADMIN, {}),
    );
    expect(resume.status).toBe(200);
    expect(await worker.runOnce()).toEqual({ enqueued: 1, recovered: 0 });
  });

  it('rejects URL-like refs and isolates runner tokens from human/admin authentication', async () => {
    const { app } = await fixture();
    const bindingId = await bootstrap(app);
    const invalid = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/schedules',
      request(ADMIN, {
        repositoryBindingId: bindingId,
        name: 'Unsafe',
        sourceRef: 'https://internal.example.test/run',
        environmentId: 'staging',
        runTargetIds: ['desktop-en'],
        intervalSeconds: 3_600,
        freshnessTargetSeconds: 7_200,
      }),
    );
    expect(invalid.status).toBe(422);
    await createSchedule(app, bindingId);
    const credential = await createRunner(app);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/schedules',
          get(credential),
        )
      ).status,
    ).toBe(401);
    expect((await app.request('/v1/runner/jobs/claim', request(ADMIN, {}))).status).toBe(401);

    const rotatedResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/runners/runner-1/rotate-token',
      request(ADMIN, {}),
    );
    expect(rotatedResponse.status).toBe(200);
    const rotated = ((await rotatedResponse.json()) as { credential: string }).credential;
    expect((await app.request('/v1/runner/jobs/claim', request(credential, {}))).status).toBe(401);
    expect((await app.request('/v1/runner/jobs/claim', request(rotated, {}))).status).toBe(204);
    expect(
      (
        await app.request('/v1/admin/workspaces/workspace-1/projects/project-1/runners/runner-1', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).status,
    ).toBe(204);
    expect((await app.request('/v1/runner/jobs/claim', request(rotated, {}))).status).toBe(401);
  });

  it('enforces dedicated human schedule scopes and owner-only runner administration', async () => {
    const { app } = await fixture();
    const bindingId = await bootstrap(app);
    await createSchedule(app, bindingId);
    expect(
      (
        await app.request(
          '/v1/operator/users',
          request(ADMIN, {
            id: 'viewer-1',
            email: 'viewer@example.test',
            displayName: 'Schedule viewer',
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          '/v1/operator/workspaces/workspace-1/memberships',
          request(ADMIN, { userId: 'viewer-1', role: 'viewer' }, 'PUT'),
        )
      ).status,
    ).toBe(201);
    const tokenResponse = await app.request(
      '/v1/operator/workspaces/workspace-1/users/viewer-1/api-tokens',
      request(ADMIN, {
        name: 'schedule read only',
        scopes: ['schedule:read'],
        projectId: 'project-1',
        expiresAt: '2026-07-22T10:00:00.000Z',
      }),
    );
    expect(tokenResponse.status).toBe(201);
    const token = ((await tokenResponse.json()) as { credential: string }).credential;
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/schedules',
          get(token),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/schedules/schedule-1/trigger',
          request(token, {}, 'POST', { 'idempotency-key': 'forbidden' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await app.request('/v1/admin/workspaces/workspace-1/projects/project-1/runners', get(token)))
        .status,
    ).toBe(403);
  });
});
