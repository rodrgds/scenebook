import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARTIFACT_VERSION,
  BuildArtifactSchema,
  ProjectSchema,
  RunArtifactSchema,
  SCHEMA_VERSION,
  SceneSchema,
  ScenebookConfigSchema,
  type BuildArtifact,
  type Scene,
} from '@scenebook/schema';
import {
  artifactHash,
  canonicalJsonHash,
  sceneSourceRevision,
  sha256,
  stableStringify,
} from '@scenebook/core';
import { FORMAT_POLICY } from '@scenebook/compiler';
import { unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertHostedGitHead,
  deterministicZipTime,
  prepareHostedUploadSettings,
  uploadHostedCiEvidence,
  type HostedUploadSettings,
} from '../src/hosted-upload.js';
import type { OcrProvider } from '../src/privacy-scan.js';
import type { LoadedConfig } from '../src/types.js';

const roots: string[] = [];
const NOW = '2026-07-20T12:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const REPOSITORY = 'acme/product';
const REF = 'refs/heads/main';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/scenebook.yml@${REF}`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function privacy(status: 'unknown' | 'clear' = 'unknown') {
  return {
    status,
    scannedAt: NOW,
    scannerVersion: 'fixture-scanner',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  } as const;
}

function repository() {
  return {
    provider: 'github' as const,
    repository: REPOSITORY,
    commit: COMMIT,
    branch: 'main',
    ref: REF,
    dirty: false,
  };
}

interface Fixture {
  readonly root: string;
  readonly config: LoadedConfig;
  readonly buildPath: string;
  readonly publicationDirectory: string;
  readonly scene: Scene;
  readonly build: BuildArtifact;
  readonly runPath: string;
  readonly originalRun: string;
  readonly originalBuild: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-hosted-upload-'));
  roots.push(root);
  const project = ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'product-docs',
    name: 'Product docs',
    slug: 'product-docs',
  });
  const parsedConfig = ScenebookConfigSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    project,
    paths: { output: 'scenebook-dist' },
    output: { formats: ['catalog'] },
  });
  const config: LoadedConfig = {
    path: join(root, 'scenebook.config.ts'),
    directory: root,
    config: parsedConfig,
    project,
  };
  const scene = SceneSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'verified-output',
    slug: 'verified-output',
    title: 'Verified output',
    steps: [{ id: 'verify-step', kind: 'explanation', title: 'Verify the output' }],
  });
  const sourceRevision = sceneSourceRevision(scene);
  const screenshotHash = sha256(PNG);
  const screenshot = {
    sha256: screenshotHash,
    path: `assets/${screenshotHash}.png`,
    mediaType: 'image/png',
    byteLength: PNG.byteLength,
    role: 'screenshot' as const,
    width: 1,
    height: 1,
  };
  const run = RunArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: 'run-verified-output',
    projectId: project.id,
    kind: 'run',
    createdAt: NOW,
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    sceneId: scene.id,
    runTargetId: 'preview-desktop',
    buildId: 'build-verified-output',
    repository: repository(),
    sourceRevision,
    status: 'passed',
    changeState: 'passed',
    expectedStepIds: ['verify-step'],
    attempts: [
      {
        id: 'attempt-1',
        index: 0,
        status: 'passed',
        startedAt: NOW,
        endedAt: NOW,
        durationMs: 1,
        checks: [
          {
            checkId: 'visible-output',
            stepId: 'verify-step',
            status: 'passed',
            expected: true,
            actual: true,
            message: 'Output is visible',
          },
        ],
        states: [
          {
            id: 'verify-after',
            sceneId: scene.id,
            stepId: 'verify-step',
            phase: 'after',
            capturedAt: NOW,
            route: '/verified',
            viewport: { width: 1280, height: 720 },
            screenshot,
            screenshotHash,
            privacy: privacy(),
          },
        ],
        privacy: privacy(),
      },
    ],
    selectedAttemptId: 'attempt-1',
    startedAt: NOW,
    endedAt: NOW,
    durationMs: 1,
    privacy: privacy(),
  });
  const build = BuildArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: 'build-verified-output',
    projectId: project.id,
    kind: 'build',
    createdAt: NOW,
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    repository: repository(),
    trigger: 'push',
    status: 'passed',
    expectedRunPlan: [{ sceneId: scene.id, runTargetId: run.runTargetId, required: true }],
    runs: [
      {
        sceneId: scene.id,
        runTargetId: run.runTargetId,
        required: true,
        run: {
          id: run.id,
          kind: 'run',
          sha256: artifactHash(run),
          path: `runs/${run.id}.json`,
        },
        status: 'passed',
        changeState: 'passed',
      },
    ],
    startedAt: NOW,
    endedAt: NOW,
    summary: { total: 1, passed: 1, changed: 0, broken: 0, blocked: 0, pending: 0 },
  });
  const runsRoot = join(root, '.scenebook/runs');
  const runPath = join(runsRoot, 'runs', `${run.id}.json`);
  const buildPath = join(runsRoot, 'build.json');
  const originalRun = `${stableStringify(run)}\n`;
  const originalBuild = `${stableStringify(build)}\n`;
  await mkdir(join(runsRoot, 'runs'), { recursive: true });
  await mkdir(join(runsRoot, 'scenes', scene.id), { recursive: true });
  await mkdir(join(runsRoot, 'assets'), { recursive: true });
  await writeFile(runPath, originalRun);
  await writeFile(buildPath, originalBuild);
  await writeFile(
    join(runsRoot, 'scenes', scene.id, `${sourceRevision}.json`),
    stableStringify(scene),
  );
  await writeFile(join(runsRoot, screenshot.path), PNG);
  const publicationDirectory = join(root, 'scenebook-dist');
  await mkdir(join(publicationDirectory, 'components'), { recursive: true });
  await mkdir(join(publicationDirectory, 'scenes/verified-output'), { recursive: true });
  await mkdir(join(publicationDirectory, 'assets'), { recursive: true });
  const publicationAssetPath = `assets/${screenshotHash}.png`;
  await writeFile(join(publicationDirectory, publicationAssetPath), PNG);
  await writeFile(join(publicationDirectory, 'index.html'), '<!doctype html><main>Safe</main>\n');
  await writeFile(join(publicationDirectory, 'components.js'), 'export const catalog = true;\n');
  await writeFile(
    join(publicationDirectory, 'components/verified-output.js'),
    'export const story = true;\n',
  );
  await writeFile(
    join(publicationDirectory, 'scenes/verified-output/index.html'),
    '<!doctype html><main>Verified output</main>\n',
  );
  await writeFile(
    join(publicationDirectory, 'scenes/verified-output/evidence.json'),
    `${stableStringify({ format: 'scenebook-evidence', version: 1, privacy: 'passed' })}\n`,
  );
  await writeFile(
    join(publicationDirectory, 'manifest.json'),
    `${stableStringify({
      format: 'scenebook-catalog',
      version: 1,
      generatedAt: NOW,
      title: 'Product docs',
      privacy: { status: 'passed', scanner: 'fixture' },
      publication: {},
      scenes: [
        {
          id: 'verified-output',
          slug: 'verified-output',
          title: 'Verified output',
          capability: 'verified',
          locale: 'en',
          sourceHash: sourceRevision,
          steps: 1,
          assets: [screenshotHash],
          evidence: 'scenes/verified-output/evidence.json',
          outputs: {
            catalog: ['scenes/verified-output/index.html'],
            'web-component': ['components.js', 'components/verified-output.js'],
          },
        },
      ],
      assets: [
        {
          hash: screenshotHash,
          path: publicationAssetPath,
          mediaType: 'image/png',
          bytes: PNG.byteLength,
        },
      ],
    })}\n`,
  );
  await writeFile(
    join(publicationDirectory, 'formats.json'),
    `${stableStringify({ selected: ['catalog', 'web-component'], policy: FORMAT_POLICY })}\n`,
  );
  return {
    root,
    config,
    buildPath,
    publicationDirectory,
    scene,
    build,
    runPath,
    originalRun,
    originalBuild,
  };
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_SHA: COMMIT,
    GITHUB_REF: REF,
    GITHUB_REF_NAME: 'main',
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    ACTIONS_ID_TOKEN_REQUEST_URL:
      'https://pipelines.actions.githubusercontent.com/acme/token?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-request-token',
    ...overrides,
  };
}

function settings(config: LoadedConfig): HostedUploadSettings {
  return prepareHostedUploadSettings(
    config,
    {
      serverUrl: 'https://scenebook.example.test/control/',
      workspaceId: 'workspace-acme',
      projectId: config.project.id,
      oidcAudience: 'scenebook',
    },
    environment(),
  );
}

function clearProvider(text = ''): OcrProvider {
  return {
    id: 'fixture-ocr',
    version: '1.0.0',
    async scan(input) {
      return [{ assetHash: input.assetHash, text }];
    },
  };
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body === null || body === undefined) return new Uint8Array();
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (Symbol.asyncIterator in Object(body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`Unsupported test body: ${Object.prototype.toString.call(body)}`);
}

function jwt(ttlSeconds = 300): string {
  const current = Math.floor(Date.now() / 1_000);
  const payload = {
    iss: 'scenebook',
    aud: 'scenebook-artifact-upload',
    sub: `${REPOSITORY}@${COMMIT}`,
    jti: 'upload-token-fixture',
    iat: current,
    exp: current + ttlSeconds,
    workspace_id: 'workspace-acme',
    project_id: 'product-docs',
    repository: REPOSITORY,
    commit: COMMIT,
    ref: REF,
    workflow_ref: WORKFLOW_REF,
    permissions: ['artifact:write'],
  };
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('hosted GitHub OIDC evidence upload', () => {
  it('uses timezone-independent DOS timestamps for deterministic ZIP bytes', () => {
    const original = process.env.TZ;
    try {
      const archive = (timezone: string) => {
        process.env.TZ = timezone;
        return zipSync({
          'file.txt': [
            Buffer.from('deterministic'),
            {
              level: 9,
              mtime: deterministicZipTime(),
              os: 3,
              attrs: (0o100644 << 16) >>> 0,
            },
          ],
        });
      };
      expect(archive('America/Los_Angeles')).toEqual(archive('UTC'));
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('finalizes one inert deterministic publication archive with an exact inventory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const value = await fixture();
    const uploaded = new Map<string, { mediaType: string; bytes: Uint8Array }>();
    const adminRequests: Array<{ url: string; headers: Headers; body: unknown }> = [];
    let beginObjects: Array<{ sha256: string; byteLength: number; mediaType: string }> = [];
    let finalizedManifest: Record<string, unknown> | undefined;
    let issuedToken = '';
    let oidcRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      if (url.startsWith('https://pipelines.actions.githubusercontent.com/')) {
        oidcRequests += 1;
        issuedToken = jwt(60);
        expect(headers.get('authorization')).toBe('Bearer github-request-token');
        expect(new URL(url).searchParams.get('audience')).toBe('scenebook');
        return json({ value: 'g'.repeat(120) });
      }
      if (url.endsWith('/v1/oidc/exchange')) return json({ token: issuedToken });
      if (url.endsWith('/v1/uploads') && method === 'POST') {
        const request = JSON.parse(Buffer.from(await bodyBytes(init?.body)).toString('utf8')) as {
          objects: typeof beginObjects;
        };
        beginObjects = request.objects;
        expect(headers.get('idempotency-key')).toMatch(/^ci:build-verified-output:/u);
        vi.setSystemTime(new Date(Date.now() + 40_000));
        return json({
          upload: {
            id: 'upload-fixture',
            status: 'pending',
            objects: beginObjects.map((object) => ({ ...object, status: 'pending' })),
          },
        });
      }
      if (url.includes('/v1/uploads/upload-fixture/objects/') && method === 'PUT') {
        const bytes = await bodyBytes(init?.body);
        const digest = url.slice(url.lastIndexOf('/') + 1);
        expect(sha256(bytes)).toBe(digest);
        expect(headers.get('content-length')).toBe(String(bytes.byteLength));
        uploaded.set(`${digest}\u0000${headers.get('content-type')}`, {
          mediaType: headers.get('content-type')!,
          bytes,
        });
        return json({ upload: { id: 'upload-fixture' } });
      }
      if (url.endsWith('/v1/uploads/upload-fixture/finalize')) {
        const request = JSON.parse(Buffer.from(await bodyBytes(init?.body)).toString('utf8')) as {
          manifest: Record<string, unknown>;
        };
        finalizedManifest = request.manifest;
        return json({ manifestHash: canonicalJsonHash(request.manifest) });
      }
      if (url.includes('/v1/admin/')) {
        adminRequests.push({
          url,
          headers,
          body: JSON.parse(Buffer.from(await bodyBytes(init?.body)).toString('utf8')),
        });
        return json({ recorded: true }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    const result = await uploadHostedCiEvidence({
      config: value.config,
      settings: settings(value.config),
      buildPath: value.buildPath,
      build: value.build,
      publicationDirectory: value.publicationDirectory,
      provider: clearProvider(),
      fetch: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({
      uploadId: 'upload-fixture',
      sceneCount: 1,
      runCount: 1,
      reviewCount: 1,
    });
    expect(oidcRequests).toBe(2);
    expect(beginObjects.map((object) => object.mediaType)).not.toEqual(
      expect.arrayContaining(['text/html', 'text/javascript', 'text/css', 'image/svg+xml']),
    );
    const zipSpec = beginObjects.find((object) => object.mediaType === 'application/zip');
    expect(zipSpec).toBeDefined();
    const zip = uploaded.get(`${zipSpec!.sha256}\u0000application/zip`);
    expect(Object.keys(unzipSync(zip!.bytes)).sort()).toEqual([
      `assets/${sha256(PNG)}.png`,
      'components.js',
      'components/verified-output.js',
      'formats.json',
      'index.html',
      'manifest.json',
      'scenes/verified-output/evidence.json',
      'scenes/verified-output/index.html',
    ]);
    const inventory = [...uploaded.values()]
      .filter((object) => object.mediaType === 'application/json')
      .map(
        (object) =>
          JSON.parse(Buffer.from(object.bytes).toString('utf8')) as Record<string, unknown>,
      )
      .find((object) => object.format === 'scenebook-publication-archive') as {
      files: Array<{ path: string; mediaType: string; sha256: string; byteLength: number }>;
      archive: typeof zipSpec;
      compilerManifest: {
        path: string;
        sha256: string;
        byteLength: number;
        mediaType: string;
      };
      treeHash: string;
    };
    expect(inventory.archive).toEqual(zipSpec);
    expect(inventory.files.map((file) => [file.path, file.mediaType])).toEqual([
      [`assets/${sha256(PNG)}.png`, 'image/png'],
      ['components.js', 'text/javascript'],
      ['components/verified-output.js', 'text/javascript'],
      ['formats.json', 'application/json'],
      ['index.html', 'text/html'],
      ['manifest.json', 'application/json'],
      ['scenes/verified-output/evidence.json', 'application/json'],
      ['scenes/verified-output/index.html', 'text/html'],
    ]);
    expect(inventory.treeHash).toBe(canonicalJsonHash({ files: inventory.files }));
    const compilerManifestObject = uploaded.get(
      `${inventory.compilerManifest.sha256}\u0000application/json`,
    );
    expect(compilerManifestObject?.bytes.byteLength).toBe(inventory.compilerManifest.byteLength);
    expect(JSON.parse(Buffer.from(compilerManifestObject!.bytes).toString('utf8'))).toMatchObject({
      format: 'scenebook-catalog',
      version: 1,
      privacy: { status: 'passed' },
      scenes: [{ id: 'verified-output', sourceHash: sceneSourceRevision(value.scene) }],
    });
    expect(result.publication).toEqual({
      archive: zipSpec,
      inventory: expect.objectContaining({ mediaType: 'application/json' }),
      compilerManifest: {
        sha256: inventory.compilerManifest.sha256,
        byteLength: inventory.compilerManifest.byteLength,
        mediaType: 'application/json',
      },
      treeHash: inventory.treeHash,
    });
    expect(finalizedManifest?.metadata).toMatchObject({
      repository: REPOSITORY,
      commit: COMMIT,
      ref: REF,
      publication: {
        archive: zipSpec,
        inventory: expect.objectContaining({ mediaType: 'application/json' }),
        compilerManifest: {
          sha256: inventory.compilerManifest.sha256,
          byteLength: inventory.compilerManifest.byteLength,
          mediaType: 'application/json',
        },
        treeHash: inventory.treeHash,
        fileCount: 8,
      },
    });
    expect(adminRequests).toHaveLength(4);
    for (const request of adminRequests) {
      expect(request.headers.get('x-scenebook-upload-id')).toBe('upload-fixture');
      expect(request.headers.get('idempotency-key')).toMatch(/^ci-(?:scene|run|review|build):/u);
      expect(request.headers.get('authorization')).toBe(`Bearer ${issuedToken}`);
    }
    const runRequest = adminRequests.find((request) => request.url.endsWith('/evidence/runs'))!
      .body as { run: { privacy: { scannerVersion: string } } };
    expect(runRequest.run.privacy.scannerVersion).toBe(
      `hosted:1.0.0:fixture-ocr:${sha256('fixture-ocr\u00001.0.0').slice(0, 16)}`,
    );
    expect(runRequest.run).toMatchObject({ status: 'passed', changeState: 'changed' });
    const reviewRequest = adminRequests.find((request) => request.url.endsWith('/reviews'))!
      .body as {
      review: { changeState: string; subject: { revision: string } };
    };
    expect(reviewRequest.review.changeState).toBe('changed');
    const buildRequest = adminRequests.find((request) => request.url.endsWith('/evidence/builds'))!
      .body as { build: { status: string; summary: { changed: number } } };
    expect(buildRequest.build).toMatchObject({ status: 'changed', summary: { changed: 1 } });
    expect(await readFile(value.runPath, 'utf8')).toBe(value.originalRun);
    expect(await readFile(value.buildPath, 'utf8')).toBe(value.originalBuild);
    await expect(
      readFile(join(value.root, '.scenebook/staging/hosted-upload-missing')),
    ).rejects.toBeDefined();
  });

  it('fails privacy and provenance before any OIDC or upload network request', async () => {
    const value = await fixture();
    const privacyFetch = vi.fn();
    await expect(
      uploadHostedCiEvidence({
        config: value.config,
        settings: settings(value.config),
        buildPath: value.buildPath,
        build: value.build,
        publicationDirectory: value.publicationDirectory,
        provider: clearProvider('person@example.com'),
        fetch: privacyFetch as typeof fetch,
      }),
    ).rejects.toThrow(/privacy is/u);
    expect(privacyFetch).not.toHaveBeenCalled();

    const provenanceFetch = vi.fn();
    const wrongBuild = BuildArtifactSchema.parse({
      ...value.build,
      repository: { ...value.build.repository, commit: 'b'.repeat(40) },
    });
    await expect(
      uploadHostedCiEvidence({
        config: value.config,
        settings: settings(value.config),
        buildPath: value.buildPath,
        build: wrongBuild,
        publicationDirectory: value.publicationDirectory,
        provider: clearProvider(),
        fetch: provenanceFetch as typeof fetch,
      }),
    ).rejects.toThrow(/GitHub Actions provenance/u);
    expect(provenanceFetch).not.toHaveBeenCalled();
  });

  it('rejects undeclared publication files before requesting OIDC', async () => {
    const value = await fixture();
    await writeFile(join(value.publicationDirectory, 'injected.txt'), 'not compiler-owned\n');
    const fetchMock = vi.fn();
    await expect(
      uploadHostedCiEvidence({
        config: value.config,
        settings: settings(value.config),
        buildPath: value.buildPath,
        build: value.build,
        publicationDirectory: value.publicationDirectory,
        provider: clearProvider(),
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow(/not owned by its manifest/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects conflicting canonical media types for digest-only manifest asset references', async () => {
    const value = await fixture();
    const digest = sha256(PNG);
    const pngPath = `assets/${digest}.png`;
    const jpegPath = `assets/${digest}.jpg`;
    await mkdir(join(value.publicationDirectory, 'assets'), { recursive: true });
    await writeFile(join(value.publicationDirectory, pngPath), PNG);
    await writeFile(join(value.publicationDirectory, jpegPath), PNG);
    const manifestPath = join(value.publicationDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      assets: Array<Record<string, unknown>>;
      scenes: Array<{ assets: string[] }>;
    };
    manifest.assets = [
      { hash: digest, path: pngPath, mediaType: 'image/png', bytes: PNG.byteLength },
      { hash: digest, path: jpegPath, mediaType: 'image/jpeg', bytes: PNG.byteLength },
    ];
    manifest.scenes[0]!.assets = [digest];
    await writeFile(manifestPath, `${stableStringify(manifest)}\n`);
    const fetchMock = vi.fn();
    await expect(
      uploadHostedCiEvidence({
        config: value.config,
        settings: settings(value.config),
        buildPath: value.buildPath,
        build: value.build,
        publicationDirectory: value.publicationDirectory,
        provider: clearProvider(),
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow(/conflicting canonical media types/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects overridden GitHub OIDC endpoints and mismatched refs locally', async () => {
    const value = await fixture();
    expect(() =>
      prepareHostedUploadSettings(
        value.config,
        {
          serverUrl: 'https://scenebook.example.test',
          workspaceId: 'workspace-acme',
          projectId: value.config.project.id,
        },
        environment({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.example/token' }),
      ),
    ).toThrow(/standard GitHub Actions HTTPS token host/u);
    expect(() =>
      prepareHostedUploadSettings(
        value.config,
        {
          serverUrl: 'https://scenebook.example.test',
          workspaceId: 'workspace-acme',
          projectId: value.config.project.id,
        },
        environment({ GITHUB_REF_NAME: 'release' }),
      ),
    ).toThrow(/same exact ref/u);
  });

  it('attests detached pull-request merge HEAD against the signed GitHub commit', async () => {
    const value = await fixture();
    const pullEnvironment = environment({
      GITHUB_REF: 'refs/pull/42/merge',
      GITHUB_REF_NAME: '42/merge',
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/scenebook.yml@refs/pull/42/merge`,
    });
    const pullSettings = prepareHostedUploadSettings(
      value.config,
      {
        serverUrl: 'https://scenebook.example.test',
        workspaceId: 'workspace-acme',
        projectId: value.config.project.id,
      },
      pullEnvironment,
    );
    const runner = vi.fn(async () => ({ code: 0, stdout: `${COMMIT}\n`, stderr: '' }));
    await expect(
      assertHostedGitHead(value.config, pullSettings, pullEnvironment, runner),
    ).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledWith(value.root, pullEnvironment);

    await expect(
      assertHostedGitHead(value.config, pullSettings, pullEnvironment, async () => ({
        code: 0,
        stdout: `${'b'.repeat(40)}\n`,
        stderr: '',
      })),
    ).rejects.toThrow(/does not match signed GitHub commit/u);
  });
});
