import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalArtifactHash,
  generateReviewArtifact,
  inspectScreenshot,
} from './github-review-artifact.mjs';
import { postGithubChecks, validateCheckPayload } from './github-post-checks.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const SHA = createHash('sha256').update(PNG).digest('hex');
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const directories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-github-review-'));
  directories.push(root);
  await mkdir(join(root, '.scenebook/runs/runs'), { recursive: true });
  await mkdir(join(root, '.scenebook/runs/assets'), { recursive: true });
  return root;
}

function privacy(status) {
  return {
    status,
    scannedAt: '2026-07-21T00:00:00.000Z',
    scannerVersion:
      status === 'clear' ? 'tesseract/5.5;@scenebook/privacy/1.0.0' : 'pixels-unscanned',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  };
}

function runFixture(options = {}) {
  const runPrivacy = options.runPrivacy ?? 'clear';
  const attemptPrivacy = options.attemptPrivacy ?? 'clear';
  const statePrivacy = options.statePrivacy ?? 'clear';
  const screenshotHash = options.screenshotHash ?? SHA;
  const mediaType = options.mediaType ?? 'image/png';
  const extension = mediaType === 'image/jpeg' ? 'jpg' : 'png';
  const byteLength = options.byteLength ?? PNG.byteLength;
  const sceneId = options.sceneId ?? 'invite-member';
  const id = options.id ?? `run-${sceneId}`;
  return {
    schemaVersion: 1,
    artifactVersion: 1,
    kind: 'run',
    id,
    projectId: 'project-test',
    createdAt: '2026-07-21T00:00:01.000Z',
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    sceneId,
    runTargetId: 'preview-desktop',
    status: 'passed',
    changeState: options.changeState ?? 'changed',
    repository: { commit: HEAD_SHA },
    privacy: privacy(runPrivacy),
    selectedAttemptId: `attempt-${sceneId}`,
    attempts: [
      {
        id: `attempt-${sceneId}`,
        privacy: privacy(attemptPrivacy),
        states: [
          {
            id: `state-${sceneId}`,
            sceneId,
            stepId: 'send-invitation',
            phase: 'after',
            privacy: privacy(statePrivacy),
            screenshotHash,
            screenshot: {
              sha256: screenshotHash,
              path: `assets/${screenshotHash}.${extension}`,
              mediaType,
              byteLength,
              role: 'screenshot',
              width: 1,
              height: 1,
            },
          },
        ],
      },
    ],
  };
}

function reference(run) {
  return {
    sceneId: run.sceneId,
    runTargetId: run.runTargetId,
    required: true,
    status: run.status,
    changeState: run.changeState,
    run: {
      kind: 'run',
      id: run.id,
      sha256: canonicalArtifactHash(run),
      path: `runs/${run.id}.json`,
    },
  };
}

async function writeEvidence(root, runs) {
  for (const run of runs) {
    await writeFile(join(root, `.scenebook/runs/runs/${run.id}.json`), JSON.stringify(run));
  }
  const build = {
    schemaVersion: 1,
    artifactVersion: 1,
    kind: 'build',
    id: 'build-review',
    projectId: 'project-test',
    createdAt: '2026-07-21T00:00:02.000Z',
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    status: runs.some((run) => run.changeState === 'changed') ? 'changed' : 'passed',
    repository: { commit: HEAD_SHA },
    trigger: 'local',
    completeness: 'complete',
    expectedRunPlan: runs.map((run) => ({
      sceneId: run.sceneId,
      runTargetId: run.runTargetId,
      required: true,
    })),
    startedAt: '2026-07-21T00:00:00.000Z',
    endedAt: '2026-07-21T00:00:02.000Z',
    runs: runs.map(reference),
    summary: {
      total: runs.length,
      passed: runs.filter((run) => run.changeState === 'passed').length,
      changed: runs.filter((run) => run.changeState === 'changed').length,
      broken: runs.filter((run) => run.changeState === 'broken').length,
      blocked: runs.filter((run) => run.changeState === 'blocked').length,
      pending: 0,
    },
  };
  await writeFile(join(root, '.scenebook/runs/build.json'), JSON.stringify(build));
  return build;
}

async function artifactFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('privacy-safe GitHub visual review artifact', () => {
  it('copies only exact privacy-clear screenshot bytes into a script-free report', async () => {
    const root = await workspace();
    const clear = runFixture();
    const unknown = runFixture({
      id: 'run-secret',
      sceneId: 'secret-scene',
      runPrivacy: 'unknown',
      attemptPrivacy: 'unknown',
      statePrivacy: 'unknown',
      screenshotHash: 'f'.repeat(64),
      byteLength: 31,
    });
    await writeEvidence(root, [clear, unknown]);
    await writeFile(join(root, `.scenebook/runs/assets/${SHA}.png`), PNG);
    const canary = Buffer.from('TOP_SECRET_UNKNOWN_SCREENSHOT');
    await writeFile(join(root, `.scenebook/runs/assets/${'f'.repeat(64)}.png`), canary);

    const output = join(root, 'review-output');
    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: output,
      verificationExitCode: 2,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.summary).toMatchObject({ included: 1, excluded: 1, uniqueAssets: 1 });
    expect(await readFile(join(output, `assets/${SHA}.png`))).toEqual(PNG);
    const files = await artifactFiles(output);
    const allBytes = Buffer.concat(await Promise.all(files.map((file) => readFile(file))));
    expect(allBytes.includes(canary)).toBe(false);
    const html = await readFile(join(output, 'index.html'), 'utf8');
    expect(html).not.toContain('<script');
    expect(html).toContain("default-src 'none'");
  });

  it('retains a metadata-only report when verification failed before evidence existed', async () => {
    const root = await workspace();
    await rm(join(root, '.scenebook'), { recursive: true });
    const output = join(root, 'review-output');
    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: output,
      verificationExitCode: 2,
    });
    expect(result.exitCode).toBe(0);
    expect(result.degraded).toBe(true);
    expect(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))).toMatchObject({
      verificationExitCode: 2,
      summary: { included: 0 },
    });
  });

  it('withholds a symlinked clear screenshot without following it', async () => {
    const root = await workspace();
    const run = runFixture();
    await writeEvidence(root, [run]);
    const outside = join(root, 'outside.png');
    await writeFile(outside, PNG);
    await symlink(outside, join(root, `.scenebook/runs/assets/${SHA}.png`));

    const output = join(root, 'review-output');
    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: output,
      verificationExitCode: 0,
    });
    expect(result).toMatchObject({ exitCode: 3, degraded: true });
    expect(result.report.summary).toMatchObject({ included: 0, excluded: 1 });
    expect(await readdir(join(output, 'assets'))).toEqual([]);
    expect(result.report.integrityIssues).toEqual([
      expect.stringContaining('privacy-clear State 1: withheld (symlink)'),
    ]);
  });

  it('rejects an evidence root reached through an intermediate directory symlink', async () => {
    const root = await workspace();
    const run = runFixture();
    await writeEvidence(root, [run]);
    await writeFile(join(root, `.scenebook/runs/assets/${SHA}.png`), PNG);
    await rename(join(root, '.scenebook'), join(root, 'outside-evidence'));
    await symlink('outside-evidence', join(root, '.scenebook'), 'dir');

    const output = join(root, 'review-output');
    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: output,
      verificationExitCode: 2,
    });
    expect(result.report.summary.included).toBe(0);
    expect(await readdir(join(output, 'assets'))).toEqual([]);
    expect(result.report.integrityIssues).toEqual([expect.stringContaining('(symlink)')]);
  });

  it('rejects a traversal Run binding before any outside JSON is read', async () => {
    const root = await workspace();
    const run = runFixture();
    const build = await writeEvidence(root, [run]);
    build.runs[0].run.path = '../outside.json';
    await writeFile(join(root, '.scenebook/runs/build.json'), JSON.stringify(build));
    await writeFile(join(root, '.scenebook/outside.json'), 'TOP_SECRET_OUTSIDE_JSON');
    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: join(root, 'review-output'),
      verificationExitCode: 2,
    });
    expect(result.report.runs).toEqual([]);
    expect(result.report.integrityIssues).toEqual([expect.stringContaining('withheld (path)')]);
    const files = await artifactFiles(join(root, 'review-output'));
    const allBytes = Buffer.concat(await Promise.all(files.map((file) => readFile(file))));
    expect(allBytes.includes(Buffer.from('TOP_SECRET_OUTSIDE_JSON'))).toBe(false);
  });

  it('never accepts stale or commit-mismatched Build evidence from an earlier run', async () => {
    const root = await workspace();
    const run = runFixture();
    await writeEvidence(root, [run]);
    await writeFile(join(root, `.scenebook/runs/assets/${SHA}.png`), PNG);
    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: join(root, 'review-output'),
      verificationExitCode: 2,
      verificationStartedAt: '2026-07-21T00:00:01.000Z',
      expectedCommit: 'f'.repeat(40),
    });
    expect(result.report.summary.included).toBe(0);
    expect(await readdir(join(root, 'review-output/assets'))).toEqual([]);
    expect(result.report.integrityIssues).toEqual([expect.stringContaining('(stale)')]);

    const mismatched = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: join(root, 'review-output-mismatch'),
      verificationExitCode: 2,
      verificationStartedAt: '2026-07-20T23:59:59.000Z',
      expectedCommit: 'f'.repeat(40),
    });
    expect(mismatched.report.summary.included).toBe(0);
    expect(mismatched.report.integrityIssues).toEqual([expect.stringContaining('(provenance)')]);
  });

  it('rejects a Build file whose timestamp predates this invocation even if its JSON claims freshness', async () => {
    const root = await workspace();
    const run = runFixture();
    const build = await writeEvidence(root, [run]);
    build.startedAt = '2026-07-21T00:00:02.000Z';
    const buildPath = join(root, '.scenebook/runs/build.json');
    await writeFile(buildPath, JSON.stringify(build));
    const staleTime = new Date('2026-07-21T00:00:00.000Z');
    await utimes(buildPath, staleTime, staleTime);

    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: join(root, 'review-output'),
      verificationExitCode: 2,
      verificationStartedAt: '2026-07-21T00:00:01.000Z',
      expectedCommit: HEAD_SHA,
    });
    expect(result.report.summary.included).toBe(0);
    expect(result.report.integrityIssues).toEqual([expect.stringContaining('(stale)')]);
  });

  it('rejects a Build whose claimed summary does not match its exact Run references', async () => {
    const root = await workspace();
    const run = runFixture();
    const build = await writeEvidence(root, [run]);
    build.runs = [];
    await writeFile(join(root, '.scenebook/runs/build.json'), JSON.stringify(build));
    await writeFile(join(root, `.scenebook/runs/assets/${SHA}.png`), PNG);

    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: join(root, 'review-output'),
      verificationExitCode: 2,
    });
    expect(result.report.summary.included).toBe(0);
    expect(result.report.integrityIssues).toEqual([expect.stringContaining('(schema)')]);
  });

  it('treats incomplete or unscanned clear labels as unknown and withholds their pixels', async () => {
    const root = await workspace();
    const run = runFixture();
    run.privacy = { status: 'clear' };
    await writeEvidence(root, [run]);
    await writeFile(join(root, `.scenebook/runs/assets/${SHA}.png`), PNG);
    const result = await generateReviewArtifact({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      outputDirectory: join(root, 'review-output'),
      verificationExitCode: 2,
    });
    expect(result.report.summary).toMatchObject({ included: 0, excluded: 1 });
    expect(await readdir(join(root, 'review-output/assets'))).toEqual([]);
  });

  it.each([
    {
      name: 'hash mismatch',
      fixture: { screenshotHash: '0'.repeat(64) },
      maximumAssetBytes: undefined,
      issue: 'binding',
    },
    {
      name: 'size limit',
      fixture: {},
      maximumAssetBytes: PNG.byteLength - 1,
      issue: 'size',
    },
    {
      name: 'media mismatch',
      fixture: { mediaType: 'image/jpeg' },
      maximumAssetBytes: undefined,
      issue: 'media',
    },
  ])(
    'withholds clear screenshot evidence on $name',
    async ({ fixture, maximumAssetBytes, issue }) => {
      const root = await workspace();
      const run = runFixture(fixture);
      await writeEvidence(root, [run]);
      await writeFile(
        join(root, '.scenebook/runs', run.attempts[0].states[0].screenshot.path),
        PNG,
      );
      const result = await generateReviewArtifact({
        workspace: root,
        evidenceDirectory: '.scenebook/runs',
        outputDirectory: join(root, 'review-output'),
        verificationExitCode: 0,
        ...(maximumAssetBytes === undefined ? {} : { maximumAssetBytes }),
      });
      expect(result.exitCode).toBe(3);
      expect(result.report.summary.included).toBe(0);
      expect(result.report.integrityIssues[0]).toContain(`withheld (${issue})`);
    },
  );

  it('rejects PNG polyglot trailing bytes and oversized decoded dimensions', () => {
    expect(() =>
      inspectScreenshot(Buffer.concat([PNG, Buffer.from('<script>')]), 'image/png'),
    ).toThrow(/terminal IEND/u);
    expect(() => inspectScreenshot(PNG, 'image/png', 0)).toThrow(/dimensions/u);
  });
});

function checkPayload(overrides = {}) {
  return {
    name: 'Scenebook',
    head_sha: HEAD_SHA,
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: 'Scenebook review',
      summary: '## Review\n\nOne deterministic change.',
      text: 'Review the retained artifact.',
      annotations: [
        {
          path: 'scenes/invite/scene.yaml',
          start_line: 2,
          end_line: 2,
          annotation_level: 'warning',
          title: 'visual: invite',
          message: 'Screenshot changed.',
          raw_details: 'deliberately stripped before network submission',
        },
      ],
    },
    ...overrides,
  };
}

async function checksWorkspace(payloads = [checkPayload()]) {
  const root = await workspace();
  await writeFile(join(root, '.scenebook/runs/github-checks.json'), JSON.stringify(payloads));
  await mkdir(join(root, 'review'));
  await writeFile(
    join(root, 'review/manifest.json'),
    JSON.stringify({
      format: 'scenebook-github-review',
      version: 1,
      build: {
        id: 'build-review',
        revision: 'a'.repeat(64),
        status: 'changed',
        commit: HEAD_SHA,
      },
      integrityIssues: [],
    }),
  );
  return root;
}

function githubEnvironment(overrides = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'acme/product',
    GITHUB_SHA: HEAD_SHA,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com',
    ...overrides,
  };
}

describe('explicit GitHub Check posting', () => {
  it('posts bounded exact-SHA Check payloads and links the retained artifact', async () => {
    const root = await checksWorkspace();
    const fetch = vi.fn(async () => new Response('{}', { status: 201 }));
    const result = await postGithubChecks({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      reportDirectory: join(root, 'review'),
      artifactUrl: 'https://github.com/acme/product/actions/runs/1/artifacts/2',
      token: 'explicit-actions-token',
      environment: githubEnvironment(),
      fetch,
    });
    expect(result).toEqual({ status: 'posted', posted: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/product/check-runs');
    expect(request.headers.authorization).toBe('Bearer explicit-actions-token');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      head_sha: HEAD_SHA,
      details_url: 'https://github.com/acme/product/actions/runs/1/artifacts/2',
    });
    expect(body.output.annotations[0]).not.toHaveProperty('raw_details');
    expect(request.body).not.toContain('explicit-actions-token');
  });

  it.each(['pull_request_target', 'pull_request'])(
    'never posts with unavailable or untrusted %s provenance',
    async (eventName) => {
      const root = await checksWorkspace();
      const eventPath = join(root, 'event.json');
      await writeFile(
        eventPath,
        JSON.stringify({ pull_request: { head: { repo: { full_name: 'fork/product' } } } }),
      );
      const fetch = vi.fn();
      const result = await postGithubChecks({
        workspace: root,
        evidenceDirectory: '.scenebook/runs',
        reportDirectory: join(root, 'review'),
        token: undefined,
        environment: githubEnvironment({
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: eventPath,
        }),
        fetch,
      });
      expect(result.status).toBe('skipped');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects payloads bound to any commit other than tested GITHUB_SHA', async () => {
    const root = await checksWorkspace([checkPayload({ head_sha: 'f'.repeat(40) })]);
    const fetch = vi.fn();
    await expect(
      postGithubChecks({
        workspace: root,
        evidenceDirectory: '.scenebook/runs',
        reportDirectory: join(root, 'review'),
        token: 'explicit-actions-token',
        environment: githubEnvironment(),
        fetch,
      }),
    ).rejects.toThrow(/GITHUB_SHA/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails explicitly requested Check posting when an exact current Build has no payload', async () => {
    const root = await checksWorkspace();
    await rm(join(root, '.scenebook/runs/github-checks.json'));
    const fetch = vi.fn();
    await expect(
      postGithubChecks({
        workspace: root,
        evidenceDirectory: '.scenebook/runs',
        reportDirectory: join(root, 'review'),
        token: 'explicit-actions-token',
        environment: githubEnvironment(),
        fetch,
      }),
    ).rejects.toThrow(/produced no GitHub Check payload/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cannot post a green or neutral Check for a failed exact Build', async () => {
    const root = await checksWorkspace();
    await writeFile(
      join(root, 'review/manifest.json'),
      JSON.stringify({
        format: 'scenebook-github-review',
        version: 1,
        build: {
          id: 'build-review',
          revision: 'a'.repeat(64),
          status: 'failed',
          commit: HEAD_SHA,
        },
        integrityIssues: [],
      }),
    );
    const fetch = vi.fn(async () => new Response('{}', { status: 201 }));
    await postGithubChecks({
      workspace: root,
      evidenceDirectory: '.scenebook/runs',
      reportDirectory: join(root, 'review'),
      token: 'explicit-actions-token',
      environment: githubEnvironment(),
      fetch,
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.conclusion).toBe('failure');
    expect(body.output.annotations).toEqual([]);
    expect(body.output.summary).toContain('Build status: **failed**');
  });

  it('rejects cross-origin artifact links and path traversal annotations', () => {
    expect(() =>
      validateCheckPayload(checkPayload(), {
        headSha: HEAD_SHA,
        artifactUrl: 'https://example.test/artifact',
        serverUrl: 'https://github.com',
      }),
    ).toThrow(/GitHub server origin/u);
    const payload = checkPayload();
    payload.output.annotations[0].path = '../secret';
    expect(() =>
      validateCheckPayload(payload, { headSha: HEAD_SHA, serverUrl: 'https://github.com' }),
    ).toThrow(/normalized POSIX/u);
  });

  it('never sends a token to a non-GitHub API origin', async () => {
    const root = await checksWorkspace();
    const fetch = vi.fn();
    await expect(
      postGithubChecks({
        workspace: root,
        evidenceDirectory: '.scenebook/runs',
        reportDirectory: join(root, 'review'),
        token: 'explicit-actions-token',
        environment: githubEnvironment({ GITHUB_API_URL: 'https://example.test' }),
        fetch,
      }),
    ).rejects.toThrow(/active GitHub server/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not echo a token reflected by an API error response', async () => {
    const root = await checksWorkspace();
    const fetch = vi.fn(async () => new Response('explicit-actions-token', { status: 422 }));
    let message = '';
    try {
      await postGithubChecks({
        workspace: root,
        evidenceDirectory: '.scenebook/runs',
        reportDirectory: join(root, 'review'),
        token: 'explicit-actions-token',
        environment: githubEnvironment(),
        fetch,
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('response bytes');
    expect(message).not.toContain('explicit-actions-token');
  });
});
