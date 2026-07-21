import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FORMAT_POLICY, type CompileResult } from '@scenebook/compiler';
import { artifactHash, sceneSourceRevision, sha256, stableStringify } from '@scenebook/core';
import {
  ARTIFACT_VERSION,
  BaselineSchema,
  BuildArtifactSchema,
  ProjectSchema,
  ReviewSchema,
  RunArtifactSchema,
  SCHEMA_VERSION,
  SceneSchema,
  ScenebookConfigSchema,
  type Baseline,
  type RunArtifact,
  type Scene,
} from '@scenebook/schema';
import { afterEach, describe, expect, it } from 'vitest';

import {
  approvePublication,
  persistImmutableBaseline,
  promotePublication,
  rollbackPublication,
  sealPublicationCandidate,
} from '../src/local-publication.js';
import { projectPublicationPlan } from '../src/publication.js';
import type { LoadedConfig } from '../src/types.js';

const roots: string[] = [];
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function privacy(now: string) {
  return {
    status: 'clear' as const,
    scannedAt: now,
    scannerVersion: 'test-scanner/1',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  };
}

async function fixture(): Promise<{ readonly root: string; readonly config: LoadedConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-local-publication-'));
  roots.push(root);
  const project = ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'trust-project',
    name: 'Trust project',
    slug: 'trust-project',
    environments: [
      {
        id: 'local',
        name: 'Local',
        kind: 'local',
        baseUrl: 'http://127.0.0.1:4173',
      },
    ],
    productVariants: [{ id: 'default', name: 'Default' }],
    captureProfiles: [{ id: 'desktop', name: 'Desktop', viewport: { width: 1280, height: 720 } }],
    runTargets: [
      {
        id: 'primary',
        name: 'Primary',
        environmentId: 'local',
        productVariantId: 'default',
        captureProfileId: 'desktop',
      },
    ],
    collections: [
      {
        id: 'product',
        title: 'Product',
        slug: 'product',
        entries: [{ id: 'demo-entry', sceneId: 'demo' }],
      },
    ],
    channels: [
      {
        id: 'public',
        name: 'Public',
        slug: 'public',
        kind: 'static',
        collectionIds: ['product'],
      },
    ],
  });
  const parsed = ScenebookConfigSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    project,
    paths: {
      scenes: ['scenes/**/*.scene/scene.yaml'],
      output: 'dist',
      baselines: '.scenebook/baselines',
      cache: '.scenebook/cache',
      publication: '.scenebook/publication',
    },
    output: { formats: ['standalone-html'] },
  });
  const path = join(root, 'scenebook.config.ts');
  await writeFile(path, 'export default {};');
  return { root, config: { path, directory: root, config: parsed, project } };
}

function source(title: string): Scene {
  return SceneSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'demo',
    slug: 'demo',
    title,
    criticality: 'normal',
    steps: [{ id: 'explain', kind: 'explanation', title: 'Explain the product' }],
  });
}

async function writeEvidence(
  value: { readonly root: string; readonly config: LoadedConfig },
  scene: Scene,
  now: string,
  suffix: string,
): Promise<{ readonly run: RunArtifact; readonly buildPath: string }> {
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
    id: `run-${suffix}`,
    projectId: value.config.project.id,
    createdAt: now,
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    kind: 'run',
    sceneId: scene.id,
    runTargetId: 'primary',
    buildId: `build-${suffix}`,
    repository: {
      provider: 'generic',
      repository: 'trust-project',
      commit: suffix.padEnd(12, '0'),
      dirty: false,
    },
    sourceRevision: sceneSourceRevision(scene),
    status: 'passed',
    changeState: 'passed',
    expectedStepIds: ['explain'],
    attempts: [
      {
        id: `attempt-${suffix}`,
        index: 0,
        status: 'passed',
        startedAt: now,
        endedAt: now,
        durationMs: 1,
        checks: [],
        states: [
          {
            id: `state-${suffix}`,
            sceneId: scene.id,
            stepId: 'explain',
            phase: 'after',
            capturedAt: now,
            route: '/demo',
            viewport: { width: 1280, height: 720 },
            screenshot,
            screenshotHash,
            privacy: privacy(now),
          },
        ],
        privacy: privacy(now),
      },
    ],
    selectedAttemptId: `attempt-${suffix}`,
    startedAt: now,
    endedAt: now,
    durationMs: 1,
    privacy: privacy(now),
  });
  const build = BuildArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: `build-${suffix}`,
    projectId: value.config.project.id,
    createdAt: now,
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    kind: 'build',
    repository: run.repository,
    trigger: 'local',
    status: 'passed',
    expectedRunPlan: [{ sceneId: scene.id, runTargetId: 'primary', required: true }],
    runs: [
      {
        sceneId: scene.id,
        runTargetId: 'primary',
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
    startedAt: now,
    endedAt: now,
    summary: { total: 1, passed: 1, changed: 0, broken: 0, blocked: 0, pending: 0 },
  });
  const evidence = join(value.root, '.scenebook/runs');
  await mkdir(join(evidence, 'runs'), { recursive: true });
  await mkdir(join(evidence, 'reviews'), { recursive: true });
  await writeFile(join(evidence, 'runs', `${run.id}.json`), `${stableStringify(run)}\n`);
  const review = ReviewSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: `review-${suffix}`,
    projectId: value.config.project.id,
    createdAt: now,
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    kind: 'review',
    subject: { kind: 'run', id: run.id, revision: artifactHash(run) },
    status: 'open',
    changeState: 'passed',
    changes: [],
    comments: [],
    decisions: [],
    baselineCandidate: { id: run.id, kind: 'run', sha256: artifactHash(run) },
    assignedTo: [],
    openedAt: now,
  });
  await writeFile(join(evidence, 'reviews', `${review.id}.json`), `${stableStringify(review)}\n`);
  const buildPath = join(evidence, 'build.json');
  await writeFile(buildPath, `${stableStringify(build)}\n`);
  return { run, buildPath };
}

async function writeCompiled(
  value: { readonly root: string; readonly config: LoadedConfig },
  scene: Scene,
  now: string,
  body: string,
): Promise<CompileResult> {
  const directory = join(value.root, 'dist');
  await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, 'scenes/demo'), { recursive: true });
  await mkdir(join(directory, 'standalone'), { recursive: true });
  const publication = projectPublicationPlan(value.config.project, { channel: 'public' });
  const manifest: CompileResult['manifest'] = {
    format: 'scenebook-catalog',
    version: 1,
    generatedAt: now,
    title: 'Public',
    publication,
    privacy: { status: 'passed', scanner: 'test-scanner/1' },
    scenes: [
      {
        id: scene.id,
        slug: scene.slug,
        title: scene.title,
        capability: scene.capability,
        locale: 'en',
        sourceHash: sceneSourceRevision(scene),
        steps: 1,
        assets: [],
        evidence: 'scenes/demo/evidence.json',
        outputs: { 'standalone-html': ['standalone/demo.html'] },
        share: { standalone: 'standalone/demo.html' },
      },
    ],
    assets: [],
  };
  await writeFile(join(directory, 'manifest.json'), `${stableStringify(manifest)}\n`);
  await writeFile(
    join(directory, 'formats.json'),
    `${stableStringify({ selected: ['standalone-html'], policy: FORMAT_POLICY })}\n`,
  );
  await writeFile(join(directory, 'scenes/demo/evidence.json'), '{}\n');
  await writeFile(join(directory, 'standalone/demo.html'), body);
  return {
    outputDirectory: directory,
    manifest,
    files: ['formats.json', 'manifest.json', 'scenes/demo/evidence.json', 'standalone/demo.html'],
    diagnostics: [],
  };
}

function baseline(run: RunArtifact, now: string): Baseline {
  const attempt = run.attempts[0]!;
  const state = attempt.states[0]!;
  return BaselineSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: `baseline-${run.id}`,
    projectId: run.projectId,
    createdAt: now,
    producer: { name: '@scenebook/cli', version: '0.1.0' },
    kind: 'baseline',
    sceneId: run.sceneId,
    runTargetId: run.runTargetId,
    sourceRunId: run.id,
    sourceRunRevision: artifactHash(run),
    sourceAttemptId: attempt.id,
    sourceRevision: run.sourceRevision,
    completeness: 'complete',
    sourceRunStatus: 'passed',
    expectedStepIds: run.expectedStepIds,
    states: [
      {
        sceneId: run.sceneId,
        stepId: state.stepId,
        phase: state.phase,
        stateId: state.id,
        screenshot: state.screenshot,
        screenshotHash: state.screenshotHash,
        route: state.route,
        viewport: state.viewport,
        privacy: state.privacy,
      },
    ],
    checks: [],
    checksHash: sha256(stableStringify([])),
    approvals: [
      {
        id: `legacy-visual-${run.id}`,
        kind: 'visual',
        decision: 'approved',
        actorId: 'visual-reviewer',
        createdAt: now,
        revision: artifactHash(run),
      },
    ],
  });
}

async function prepareCandidate(
  value: { readonly root: string; readonly config: LoadedConfig },
  options: {
    readonly title: string;
    readonly now: string;
    readonly suffix: string;
    readonly body: string;
  },
) {
  const scene = source(options.title);
  const sceneDirectory = join(value.root, 'scenes/demo.scene');
  await mkdir(sceneDirectory, { recursive: true });
  await writeFile(join(sceneDirectory, 'scene.yaml'), `${stableStringify(scene)}\n`);
  const evidence = await writeEvidence(value, scene, options.now, options.suffix);
  const compiled = await writeCompiled(value, scene, options.now, options.body);
  const candidate = await sealPublicationCandidate({
    config: value.config,
    result: compiled,
    channel: 'public',
    buildPath: evidence.buildPath,
  });
  await persistImmutableBaseline({
    config: value.config,
    baseline: baseline(evidence.run, options.now),
    actorId: 'visual-reviewer',
  });
  await approvePublication({
    config: value.config,
    scope: 'editorial',
    actorId: 'editor',
    decision: 'approved',
    channel: 'public',
    candidate: candidate.revision,
    sceneId: 'demo',
  });
  await approvePublication({
    config: value.config,
    scope: 'release',
    actorId: 'release-manager',
    decision: 'approved',
    channel: 'public',
    candidate: candidate.revision,
  });
  return { candidate, evidence };
}

describe('local immutable publication', () => {
  it('promotes sealed bytes after source mutation and rolls back byte-exactly', async () => {
    const value = await fixture();
    const first = await prepareCandidate(value, {
      title: 'First',
      now: '2026-07-21T10:00:00.000Z',
      suffix: 'first',
      body: '<!doctype html><h1>first</h1>',
    });
    // The candidate is self-contained. Neither later source changes nor a
    // replaced mutable Build descriptor can affect promotion.
    await writeFile(join(value.root, 'scenes/demo.scene/scene.yaml'), 'invalid: source\n');
    await writeFile(first.evidence.buildPath, '{"invalid":true}\n');
    const destination = join(value.root, 'published');
    const firstRelease = await promotePublication({
      config: value.config,
      channel: 'public',
      candidate: first.candidate.revision,
      destination,
      actorId: 'publisher',
    });
    expect(await readFile(join(destination, 'standalone/demo.html'), 'utf8')).toContain('first');

    const second = await prepareCandidate(value, {
      title: 'Second',
      now: '2026-07-21T11:00:00.000Z',
      suffix: 'second',
      body: '<!doctype html><h1>second</h1>',
    });
    const secondRelease = await promotePublication({
      config: value.config,
      channel: 'public',
      candidate: second.candidate.revision,
      destination,
      actorId: 'publisher',
    });
    expect(secondRelease.release.sequence).toBe(firstRelease.release.sequence + 1);
    expect(await readFile(join(destination, 'standalone/demo.html'), 'utf8')).toContain('second');

    const rolledBack = await rollbackPublication({
      config: value.config,
      channel: 'public',
      actorId: 'publisher',
    });
    expect(rolledBack.releaseRevision).toBe(firstRelease.releaseRevision);
    expect(await readFile(join(destination, 'standalone/demo.html'), 'utf8')).toContain('first');
    const events = await readdir(join(value.root, '.scenebook/publication/events/objects'));
    expect(events).toHaveLength(3);
  });

  it('fails closed when the immutable candidate tree is tampered', async () => {
    const value = await fixture();
    const prepared = await prepareCandidate(value, {
      title: 'Tamper proof',
      now: '2026-07-21T12:00:00.000Z',
      suffix: 'tamper',
      body: '<!doctype html><h1>trusted</h1>',
    });
    await writeFile(
      join(prepared.candidate.directory, 'tree/standalone/demo.html'),
      '<!doctype html><h1>tampered</h1>',
    );
    await expect(
      promotePublication({
        config: value.config,
        channel: 'public',
        candidate: prepared.candidate.revision,
        destination: join(value.root, 'published'),
        actorId: 'publisher',
      }),
    ).rejects.toThrow('failed exact verification');
  });
});
