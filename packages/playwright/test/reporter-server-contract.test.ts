import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import { artifactHash, canonicalJsonHash, sha256 } from '@scenebook/core';
import {
  BaselineSchema,
  BuildArtifactSchema,
  ReviewSchema,
  RunArtifactSchema,
  SceneSchema,
  type RunArtifact,
} from '@scenebook/schema';
import {
  FileSystemObjectStore,
  HmacHasher,
  IdentityTokenService,
  RunnerTokenService,
  SecretBox,
  UploadTokenService,
  WebhookDispatcher,
  createControlPlaneApp,
  createJsonLogger,
  type GitHubOidcClaims,
  type GitHubOidcVerifier,
} from '@scenebook/server';
import { MemoryControlPlaneRepository } from '@scenebook/server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import ScenebookReporter from '../src/reporter.js';
import type { CapturedBeatMetadata } from '../src/types.js';
import { finalizePublicationFixture } from './support/publication.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const ADMIN_TOKEN = 'reporter-contract-admin-'.padEnd(64, 'a');
const SERVER_SECRET = 'reporter-contract-secret-'.padEnd(64, 's');
const IDENTITY_SECRET = 'reporter-identity-secret-'.padEnd(64, 'i');
const RUNNER_SECRET = 'reporter-runner-secret-'.padEnd(64, 'r');
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
const COMMIT = 'a'.repeat(40);
const REPOSITORY = 'acme/product';
const WORKFLOW_REF = 'acme/product/.github/workflows/publish.yml@refs/heads/main';
const roots: string[] = [];

const oidcClaims: GitHubOidcClaims = {
  repository: REPOSITORY,
  commit: COMMIT,
  ref: 'refs/heads/main',
  workflowRef: WORKFLOW_REF,
  actor: 'octocat',
  runId: 'reporter-contract-run',
  tokenId: 'reporter-contract-oidc',
};

class FakeOidcVerifier implements GitHubOidcVerifier {
  async verify(): Promise<GitHubOidcClaims> {
    return oidcClaims;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
    scannerVersion: 'reporter-contract-test',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  };
}

function baselineForRun(run: RunArtifact) {
  const selected = run.attempts.find((attempt) => attempt.id === run.selectedAttemptId)!;
  return BaselineSchema.parse({
    schemaVersion: 1,
    artifactVersion: 1,
    id: 'baseline-reporter',
    projectId: 'project-1',
    kind: 'baseline',
    createdAt: NOW.toISOString(),
    producer: { name: 'reporter-contract-test', version: '1.0.0' },
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
        id: 'baseline-author-approval',
        kind: 'visual',
        decision: 'approved',
        actorId: 'admin',
        createdAt: NOW.toISOString(),
        revision: run.sourceRevision,
      },
    ],
  });
}

async function serverFixture() {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-reporter-server-'));
  roots.push(root);
  const repository = new MemoryControlPlaneRepository();
  const uploadTokens = new UploadTokenService(SERVER_SECRET);
  let id = 0;
  const app = createControlPlaneApp({
    repository,
    objectStore: new FileSystemObjectStore(root),
    oidcVerifier: new FakeOidcVerifier(),
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
    runnerLeaseSeconds: 120,
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
    rateLimit: { requests: 1_000, aggregateRequests: 10_000, windowMs: 60_000 },
    now: () => new Date(NOW),
    id: (prefix) => `${prefix}-${++id}`,
  });
  return { app, repository, uploadTokens };
}

async function bootstrap(app: ReturnType<typeof createControlPlaneApp>): Promise<void> {
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
        admin({ repository: REPOSITORY, workflowRefPattern: '*' }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await app.request(
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
      )
    ).status,
  ).toBe(201);
}

async function reporterArtifacts() {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-first-party-reporter-'));
  roots.push(root);
  const sourcePath = join(root, 'invite.spec.ts');
  await writeFile(sourcePath, 'test("Invite a teammate", async () => {});');
  const screenshot = await sharp({
    create: {
      width: 24,
      height: 16,
      channels: 4,
      background: { r: 34, g: 197, b: 94, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const screenshotHash = sha256(screenshot);
  const screenshotName = `scenebook-state-invite-after-${screenshotHash.slice(0, 12)}.png`;
  const beat: CapturedBeatMetadata = {
    version: 1,
    sceneId: 'invite-member',
    stepId: 'submit-invite',
    title: 'Submit invite',
    instruction: 'Submit the invitation form.',
    states: [
      {
        version: 1,
        sceneId: 'invite-member',
        stepId: 'submit-invite',
        phase: 'after',
        capturedAt: NOW.toISOString(),
        route: '/settings/members',
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false },
        screenshotHash,
        screenshotAttachment: screenshotName,
        masksApplied: ['automatic-sensitive-fields'],
        privacy: clearPrivacy(),
      },
    ],
  };
  const test = {
    id: 'invite-test',
    title: 'Invite a teammate',
    annotations: [
      {
        type: 'scenebook:scene',
        description: JSON.stringify({
          id: 'invite-member',
          title: 'Invite a teammate',
          criticality: 'critical',
          audience: ['developers'],
        }),
      },
    ],
    location: { file: sourcePath, line: 1, column: 1 },
    parent: { project: () => ({ name: 'chromium' }) },
  } as unknown as TestCase;
  const testStep = {
    category: 'test.step',
    title: 'Submit invite',
    startTime: NOW,
    duration: 200,
    location: test.location,
    steps: [
      {
        category: 'pw:api',
        title: 'locator.click',
        startTime: NOW,
        duration: 75,
        location: test.location,
        steps: [],
      },
      {
        category: 'expect',
        title: 'expect(success message).toBeVisible',
        startTime: new Date(NOW.getTime() + 100),
        duration: 50,
        location: test.location,
        steps: [],
      },
    ],
  } as unknown as TestStep;
  const result = {
    status: 'passed',
    retry: 0,
    startTime: NOW,
    duration: 250,
    errors: [],
    steps: [testStep],
    attachments: [
      { name: screenshotName, contentType: 'image/png', body: screenshot },
      {
        name: 'scenebook-beat-0001-submit-invite.json',
        contentType: 'application/vnd.scenebook.beat+json',
        body: Buffer.from(JSON.stringify(beat)),
      },
    ],
  } as unknown as TestResult;
  const reporter = new ScenebookReporter({
    outputDirectory: '.scenebook/runs',
    projectId: 'project-1',
    runTargetId: 'primary',
    repository: REPOSITORY,
    commit: COMMIT,
    branch: 'main',
    quiet: true,
  });
  reporter.onBegin({ rootDir: root } as FullConfig, { allTests: () => [test] } as unknown as Suite);
  reporter.onTestEnd(test, result);
  await reporter.onEnd({ status: 'passed' } as FullResult);

  const output = join(root, '.scenebook/runs');
  const candidateBuild = BuildArtifactSchema.parse(
    JSON.parse(await readFile(join(output, 'build.json'), 'utf8')),
  );
  const candidateRun = RunArtifactSchema.parse(
    JSON.parse(await readFile(join(output, candidateBuild.runs[0]!.run!.path!), 'utf8')),
  );
  expect(candidateRun.changeState).toBe('changed');
  const baseline = baselineForRun(candidateRun);
  const baselineDirectory = join(root, '.scenebook/baselines', candidateRun.sceneId);
  await mkdir(baselineDirectory, { recursive: true });
  await writeFile(
    join(baselineDirectory, `${candidateRun.runTargetId}.json`),
    JSON.stringify(baseline),
  );

  const baselineReporter = new ScenebookReporter({
    outputDirectory: '.scenebook/runs',
    baselineDirectory: '.scenebook/baselines',
    projectId: 'project-1',
    runTargetId: 'primary',
    repository: REPOSITORY,
    commit: COMMIT,
    branch: 'main',
    quiet: true,
  });
  baselineReporter.onBegin(
    { rootDir: root } as FullConfig,
    { allTests: () => [test] } as unknown as Suite,
  );
  baselineReporter.onTestEnd(test, result);
  await baselineReporter.onEnd({ status: 'passed' } as FullResult);

  const build = BuildArtifactSchema.parse(
    JSON.parse(await readFile(join(output, 'build.json'), 'utf8')),
  );
  const run = RunArtifactSchema.parse(
    JSON.parse(await readFile(join(output, build.runs[0]!.run!.path!), 'utf8')),
  );
  const scene = SceneSchema.parse(
    JSON.parse(
      await readFile(join(output, 'scenes', run.sceneId, `${run.sourceRevision}.json`), 'utf8'),
    ),
  );
  const reviews = await Promise.all(
    (await readdir(join(output, 'reviews'))).map(async (file) =>
      ReviewSchema.parse(JSON.parse(await readFile(join(output, 'reviews', file), 'utf8'))),
    ),
  );
  const review = reviews.find((candidate) => candidate.baseline?.id === baseline.id)!;
  expect(run.changeState).toBe('passed');
  expect(review.changeState).toBe('passed');
  return { baseline, build, review, run, scene, screenshot };
}

describe('first-party reporter/server evidence contract', () => {
  it('registers and promotes actual reporter Scene, Run, and Build records and rejects hash mismatches', async () => {
    const { app, repository, uploadTokens } = await serverFixture();
    await bootstrap(app);
    const { scene, run, build, baseline, review, screenshot } = await reporterArtifacts();

    const screenshotObject = {
      sha256: sha256(screenshot),
      byteLength: screenshot.byteLength,
      mediaType: 'image/png',
    } as const;
    const evidenceToken = await uploadTokens.issue(
      {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: REPOSITORY,
        commit: COMMIT,
        ref: 'refs/heads/main',
        workflowRef: WORKFLOW_REF,
        permissions: ['artifact:write'],
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 300,
        tokenId: 'reporter-contract-evidence-token',
      },
      Math.floor(NOW.getTime() / 1_000),
    );
    const beginEvidenceUpload = await app.request('/v1/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${evidenceToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'reporter-contract-evidence-upload',
      },
      body: JSON.stringify({ objects: [screenshotObject] }),
    });
    expect(beginEvidenceUpload.status).toBe(201);
    const evidenceUploadId = ((await beginEvidenceUpload.json()) as { upload: { id: string } })
      .upload.id;
    expect(
      (
        await app.request(`/v1/uploads/${evidenceUploadId}/objects/${screenshotObject.sha256}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${evidenceToken}`,
            'content-type': screenshotObject.mediaType,
          },
          body: screenshot.slice().buffer,
        })
      ).status,
    ).toBe(200);
    const evidenceManifest = {
      schemaVersion: 1,
      objects: [screenshotObject],
      metadata: { kind: 'reporter-contract-evidence' },
    };
    expect(
      (
        await app.request(`/v1/uploads/${evidenceUploadId}/finalize`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${evidenceToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ manifest: evidenceManifest }),
        })
      ).status,
    ).toBe(200);

    const sceneResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/scenes/revisions',
      admin({ scene, privacy: clearPrivacy() }),
    );
    expect(sceneResponse.status).toBe(201);
    expect(await sceneResponse.json()).toMatchObject({
      revision: { sceneId: run.sceneId, revision: run.sourceRevision },
    });

    const mismatchedRun = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
      admin(
        { run: { ...run, id: 'run-wrong-revision', sourceRevision: 'f'.repeat(64) } },
        'reporter-run-wrong-revision',
      ),
    );
    expect(mismatchedRun.status).toBe(422);
    expect(await mismatchedRun.json()).toMatchObject({
      error: { code: 'unknown_scene_revision' },
    });

    const runResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/runs',
      admin({ run }, 'reporter-run'),
    );
    expect(runResponse.status).toBe(201);
    expect(await runResponse.json()).toMatchObject({
      run: { id: run.id, artifactHash: artifactHash(run) },
    });
    expect(build.runs[0]!.run!.sha256).toBe(artifactHash(run));

    const mismatchedBuild = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/builds',
      admin(
        {
          build: {
            ...build,
            id: 'build-wrong-run-hash',
            runs: [
              {
                ...build.runs[0],
                run: { ...build.runs[0]!.run, sha256: 'e'.repeat(64) },
              },
            ],
          },
        },
        'reporter-build-wrong-run-hash',
      ),
    );
    expect(mismatchedBuild.status).toBe(422);
    expect(await mismatchedBuild.json()).toMatchObject({
      error: { code: 'run_reference_mismatch' },
    });

    const buildResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/builds',
      admin({ build }, 'reporter-build'),
    );
    expect(buildResponse.status).toBe(201);
    expect(await buildResponse.json()).toMatchObject({
      build: { id: build.id, artifactHash: artifactHash(build) },
    });

    expect(
      (
        await app.request(
          '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/baselines',
          admin({ baseline }, 'reporter-baseline'),
        )
      ).status,
    ).toBe(201);

    const tamperedReview = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
      admin({ review: { ...review, changeState: 'changed' } }, 'reporter-review-tampered'),
    );
    expect(tamperedReview.status).toBe(422);
    expect(await tamperedReview.json()).toMatchObject({
      error: { code: 'review_diff_mismatch' },
    });
    const reviewResponse = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/reviews',
      admin({ review }, 'reporter-review'),
    );
    expect(reviewResponse.status).toBe(201);

    const published = await finalizePublicationFixture({
      app,
      uploadTokens,
      now: NOW,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      repository: REPOSITORY,
      commit: COMMIT,
      ref: 'refs/heads/main',
      workflowRef: WORKFLOW_REF,
      tokenId: 'reporter-contract-upload-token',
      uploadKey: 'reporter-contract-upload',
      sceneId: scene.id,
      sourceRevision: run.sourceRevision,
      bytes: new TextEncoder().encode('reporter-backed release output'),
    });
    const candidate = {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'release-reporter',
      projectId: 'project-1',
      kind: 'release' as const,
      createdAt: NOW.toISOString(),
      producer: { name: 'reporter-contract-test', version: '1.0.0' },
      channelId: 'channel-1',
      sourceBuildId: build.id,
      scenes: [
        {
          sceneId: scene.id,
          sourceRevision: run.sourceRevision,
          outputs: [published.output],
        },
      ],
      manifestHash: published.manifestHash,
      publication: published.publication,
    };
    const approvalPath = '/v1/admin/workspaces/workspace-1/projects/project-1/evidence/approvals';
    for (const [id, kind] of [
      ['visual-reporter', 'visual'],
      ['editorial-reporter', 'editorial'],
    ] as const) {
      expect(
        (
          await app.request(
            approvalPath,
            admin({ id, kind, decision: 'approved', baselineId: baseline.id }, `approval-${id}`),
          )
        ).status,
      ).toBe(201);
    }
    expect(
      (
        await app.request(
          approvalPath,
          admin(
            {
              id: 'release-reporter-approval',
              kind: 'release',
              decision: 'approved',
              release: candidate,
            },
            'approval-release-reporter',
          ),
        )
      ).status,
    ).toBe(201);

    const promoted = await app.request(
      '/v1/admin/workspaces/workspace-1/projects/project-1/channels/channel-1/releases',
      admin(
        {
          release: candidate,
          evidence: {
            releaseApprovalId: 'release-reporter-approval',
            scenes: [
              {
                sceneId: scene.id,
                runId: run.id,
                baselineId: baseline.id,
                visualApprovalId: 'visual-reporter',
                editorialApprovalId: 'editorial-reporter',
              },
            ],
          },
        },
        'promote-reporter-release',
      ),
    );
    expect(promoted.status).toBe(201);
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
      scenes: [{ sceneId: scene.id, runId: run.id, baselineId: baseline.id }],
    });
  });
});
