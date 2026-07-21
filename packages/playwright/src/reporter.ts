import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import {
  artifactHash,
  createDeterministicId,
  isValidId,
  sceneSourceRevision,
  sha256,
  slugify,
  stableStringify,
} from '@scenebook/core';
import {
  ARTIFACT_VERSION,
  BaselineSchema,
  BuildArtifactSchema,
  PrivacySummarySchema,
  RunArtifactSchema,
  SCHEMA_VERSION,
  SceneSchema,
  type AssetRef,
  type Baseline,
  type BuildArtifact,
  type PrivacySummary,
  type Review,
  type RunArtifact,
  type Scene,
  type StateEvidence,
} from '@scenebook/schema';
import { githubCheckPayloadsForReviews, reviewRunEvidence } from './evidence.js';
import type { CapturedBeatMetadata, CapturedStateMetadata } from './types.js';
import { fingerprintScreenshot } from './image.js';
import {
  readBoundedRegularFile,
  readBoundedRegularFileAtPath,
  SafeFileReadError,
} from './safe-file.js';

export interface ScenebookReporterOptions {
  readonly outputDirectory?: string;
  readonly projectId?: string;
  readonly runTargetId?: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly baselineDirectory?: string;
  readonly githubDetailsUrl?: string;
  readonly quiet?: boolean;
}

interface WrittenRun {
  readonly artifact: RunArtifact;
  readonly path: string;
  readonly hash: string;
  readonly review?: Review;
  readonly definitionIdentity?: string;
}

interface ParsedSceneAnnotation {
  readonly id: string;
  readonly title: string;
  readonly audience: readonly string[];
  readonly tags: readonly string[];
  readonly criticality?: Scene['criticality'];
  readonly description?: string;
  readonly definition?: ReporterLocation;
}

const EMPTY_COUNTS = { info: 0, low: 0, medium: 0, high: 0, blocking: 0 } as const;
const MAX_METADATA_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_ATTACHMENT_BYTES = 250 * 1024 * 1024;
const MAX_DEBUG_ATTACHMENT_BYTES = 250 * 1024 * 1024;

function privacy(scannedAt: string) {
  return {
    status: 'unknown' as const,
    scannedAt,
    scannerVersion: 'unscanned-playwright-evidence',
    counts: EMPTY_COUNTS,
    findings: [],
  };
}

function aggregatePrivacy(summaries: readonly PrivacySummary[], scannedAt: string): PrivacySummary {
  if (summaries.length === 0) return privacy(scannedAt);
  const rank = { clear: 0, warning: 1, unknown: 2, blocked: 3, quarantined: 4 } as const;
  const findings = [
    ...new Map(
      summaries
        .flatMap((summary) => summary.findings)
        .map((finding) => [
          `${finding.ruleId}\u0000${finding.path}\u0000${finding.fingerprint}`,
          finding,
        ]),
    ).values(),
  ];
  const mostSevere = summaries.reduce((current, candidate) =>
    rank[candidate.status] > rank[current.status] ? candidate : current,
  );
  const scannerVersion = [...new Set(summaries.map((summary) => summary.scannerVersion))]
    .sort()
    .join('+')
    .slice(0, 100);
  return PrivacySummarySchema.parse({
    status: mostSevere.status,
    scannedAt,
    scannerVersion,
    counts: {
      info: findings.filter((finding) => finding.severity === 'info').length,
      low: findings.filter((finding) => finding.severity === 'low').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      high: findings.filter((finding) => finding.severity === 'high').length,
      blocking: findings.filter((finding) => finding.severity === 'blocking').length,
    },
    findings,
  });
}

async function atomicWrite(path: string, contents: Uint8Array | string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

async function attachmentBytes(
  attachment: TestResult['attachments'][number],
  maximumBytes: number,
): Promise<Buffer> {
  if (attachment.body) {
    const bytes = Buffer.from(attachment.body);
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`Attachment ${attachment.name} exceeds its evidence size limit.`);
    }
    return bytes;
  }
  if (attachment.path) {
    const value = await readBoundedRegularFileAtPath(attachment.path, {
      maximumBytes,
      minimumBytes: 1,
    });
    return Buffer.from(value.bytes);
  }
  throw new Error(`Attachment ${attachment.name} has neither a body nor a path.`);
}

function idList(value: unknown): string[] {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return [
    ...new Set(
      values
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => slugify(entry)),
    ),
  ];
}

function reporterLocation(value: unknown): ReporterLocation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.file !== 'string' ||
    !Number.isInteger(candidate.line) ||
    Number(candidate.line) < 1 ||
    !Number.isInteger(candidate.column) ||
    Number(candidate.column) < 1
  ) {
    return undefined;
  }
  return {
    file: candidate.file,
    line: Number(candidate.line),
    column: Number(candidate.column),
  };
}

function parseSceneAnnotation(test: TestCase): ParsedSceneAnnotation {
  const annotation = (test.annotations ?? []).find(
    (candidate) => candidate.type === 'scenebook:scene',
  );
  if (annotation?.description) {
    try {
      const value = JSON.parse(annotation.description) as Record<string, unknown>;
      const title = typeof value.title === 'string' ? value.title : test.title;
      const criticality = ['low', 'normal', 'important', 'critical'].includes(
        String(value.criticality),
      )
        ? (value.criticality as Scene['criticality'])
        : undefined;
      const definition = reporterLocation(value.definition);
      return {
        id:
          typeof value.id === 'string' && isValidId(value.id)
            ? value.id
            : createDeterministicId('scene', title),
        title,
        audience: idList(value.audience),
        tags: idList(value.tags),
        ...(criticality ? { criticality } : {}),
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(definition ? { definition } : {}),
      };
    } catch {
      // Invalid user annotations are ignored; the test still gets import-mode evidence.
    }
  }
  return {
    id: createDeterministicId('scene', test.title),
    title: test.title,
    audience: [],
    tags: [],
  };
}

async function parseBeatAttachments(result: TestResult): Promise<CapturedBeatMetadata[]> {
  const beats: CapturedBeatMetadata[] = [];
  for (const attachment of result.attachments) {
    if (attachment.contentType !== 'application/vnd.scenebook.beat+json') continue;
    const value = JSON.parse(
      (await attachmentBytes(attachment, MAX_METADATA_ATTACHMENT_BYTES)).toString('utf8'),
    ) as CapturedBeatMetadata;
    if (value.version !== 1 || !value.sceneId || !value.stepId || !Array.isArray(value.states)) {
      throw new Error(`Malformed Scenebook beat attachment: ${attachment.name}`);
    }
    beats.push(value);
  }
  return beats;
}

function provisionalStepTitles(steps: readonly TestStep[]): string[] {
  const result: string[] = [];
  const visit = (step: TestStep): void => {
    if (step.category === 'test.step' && !step.title.startsWith('Scenebook:'))
      result.push(step.title);
    for (const child of step.steps) visit(child);
  };
  for (const step of steps) visit(step);
  return result;
}

function extensionFor(contentType: string): string {
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'application/zip') return '.zip';
  if (contentType === 'video/webm') return '.webm';
  return '.bin';
}

function debugAttachmentRole(
  attachment: TestResult['attachments'][number],
): 'screenshot' | 'trace' | 'video' | undefined {
  if (attachment.contentType === 'image/png' || attachment.contentType === 'image/jpeg') {
    return 'screenshot';
  }
  if (attachment.contentType === 'application/zip' && attachment.name === 'trace') return 'trace';
  if (attachment.contentType === 'video/webm') return 'video';
  return undefined;
}

function mappedStatus(status: TestResult['status']): RunArtifact['status'] {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  if (status === 'interrupted') return 'cancelled';
  return 'failed';
}

interface ReporterLocation {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
}

export default class ScenebookReporter implements Reporter {
  private config?: FullConfig;
  private suite?: Suite;
  private startedAt = new Date();
  private readonly pending = new Set<Promise<void>>();
  private readonly runs: WrittenRun[] = [];

  public constructor(private readonly options: ScenebookReporterOptions = {}) {
    this.projectId();
    this.boundRunTargetId();
  }

  public onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
    this.startedAt = new Date();
  }

  public onTestEnd(test: TestCase, result: TestResult): void {
    const operation = this.writeRun(test, result).then((run) => {
      this.runs.push(run);
    });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }

  public async onEnd(result: FullResult): Promise<void> {
    await Promise.all(this.pending);
    const finalized = await this.finalizeRuns();
    this.runs.splice(0, this.runs.length, ...finalized);
    await this.writeBuild(result);
    if (!this.options.quiet) {
      const output = this.outputDirectory();
      process.stdout.write(`Scenebook evidence: ${this.runs.length} run(s) written to ${output}\n`);
    }
  }

  private outputDirectory(): string {
    return resolve(this.projectRoot(), this.options.outputDirectory ?? '.scenebook/runs');
  }

  private baselineDirectory(): string {
    return resolve(this.projectRoot(), this.options.baselineDirectory ?? '.scenebook/baselines');
  }

  private async baseline(sceneId: string, runTargetId: string): Promise<Baseline | undefined> {
    const value = await readBoundedRegularFile(
      this.baselineDirectory(),
      join(sceneId, `${runTargetId}.json`),
      { maximumBytes: 16 * 1024 * 1024, minimumBytes: 1 },
    ).catch((error: unknown) => {
      if (error instanceof SafeFileReadError && error.reason === 'missing') return undefined;
      throw error;
    });
    if (!value) return undefined;
    const baseline = BaselineSchema.parse(JSON.parse(Buffer.from(value.bytes).toString('utf8')));
    if (baseline.sceneId !== sceneId || baseline.runTargetId !== runTargetId) {
      throw new Error(`Baseline ${baseline.id} does not match ${sceneId}/${runTargetId}.`);
    }
    return baseline;
  }

  private projectRoot(): string {
    return resolve(
      this.config?.configFile
        ? dirname(this.config.configFile)
        : (this.config?.rootDir ?? process.cwd()),
    );
  }

  private projectRelativePath(file: string): string | undefined {
    const path = relative(this.projectRoot(), resolve(file));
    if (path === '' || path.startsWith('..') || isAbsolute(path)) {
      return undefined;
    }
    return path.replaceAll('\\', '/');
  }

  private sourceLocation(
    location: ReporterLocation | undefined,
    fallback?: { readonly path: string; readonly line: number; readonly column?: number },
  ) {
    const path = location ? this.projectRelativePath(location.file) : undefined;
    if (!path) return fallback;
    return {
      path,
      line: Math.max(1, location?.line ?? 1),
      column: Math.max(1, location?.column ?? 1),
    };
  }

  private testSourceLocation(test: TestCase, definition?: ReporterLocation) {
    const definitionSource = this.sourceLocation(definition);
    if (definitionSource) return definitionSource;
    const testSource = this.sourceLocation(test.location);
    if (testSource) return testSource;
    let suite: Suite | undefined = test.parent;
    while (suite) {
      const suiteSource = this.sourceLocation(suite.location);
      if (suiteSource) return suiteSource;
      suite = suite.parent;
    }
    return undefined;
  }

  private projectId(): string {
    const environment = process.env.SCENEBOOK_PROJECT_ID;
    const configured = this.options.projectId;
    if (environment !== undefined && !isValidId(environment)) {
      throw new Error(`SCENEBOOK_PROJECT_ID is not a valid Scenebook id: ${environment}`);
    }
    if (configured !== undefined && !isValidId(configured)) {
      throw new Error(`Reporter projectId is not a valid Scenebook id: ${configured}`);
    }
    if (environment !== undefined && configured !== undefined && environment !== configured) {
      throw new Error(
        `Reporter projectId ${configured} conflicts with authoritative SCENEBOOK_PROJECT_ID ${environment}.`,
      );
    }
    return environment ?? configured ?? 'project';
  }

  private boundRunTargetId(): string | undefined {
    const environment = process.env.SCENEBOOK_RUN_TARGET_ID;
    const configured = this.options.runTargetId ? slugify(this.options.runTargetId) : undefined;
    if (environment !== undefined && !isValidId(environment)) {
      throw new Error(`SCENEBOOK_RUN_TARGET_ID is not a valid Scenebook id: ${environment}`);
    }
    if (environment !== undefined && configured !== undefined && environment !== configured) {
      throw new Error(
        `Reporter runTargetId ${configured} conflicts with authoritative SCENEBOOK_RUN_TARGET_ID ${environment}.`,
      );
    }
    return environment ?? configured;
  }

  private runTargetId(test: TestCase): string {
    return this.boundRunTargetId() ?? slugify(test.parent.project()?.name ?? 'primary');
  }

  private executionEvidence(
    test: TestCase,
    result: TestResult,
    scene: Scene,
    beats: readonly CapturedBeatMetadata[],
    fallbackSource?: { readonly path: string; readonly line: number; readonly column?: number },
  ): Pick<RunArtifact['attempts'][number], 'actions' | 'checks'> {
    const actions: RunArtifact['attempts'][number]['actions'] = [];
    const checks: RunArtifact['attempts'][number]['checks'] = [];
    const assignedBeatIds = new Set<string>();
    let importedStepIndex = 0;
    let executionIndex = 0;
    const fallbackStepId = scene.steps[0]!.id;

    const bindStep = (step: TestStep, inheritedStepId?: string): string => {
      if (step.category !== 'test.step') return inheritedStepId ?? fallbackStepId;
      if (beats.length === 0) {
        const stepId = scene.steps[importedStepIndex]?.id ?? inheritedStepId ?? fallbackStepId;
        importedStepIndex += 1;
        return stepId;
      }
      const beat = beats.find(
        (candidate) => candidate.title === step.title && !assignedBeatIds.has(candidate.stepId),
      );
      if (!beat) return inheritedStepId ?? fallbackStepId;
      assignedBeatIds.add(beat.stepId);
      return beat.stepId;
    };

    const visit = (step: TestStep, inheritedStepId?: string): void => {
      const stepId = bindStep(step, inheritedStepId);
      executionIndex += 1;
      const started =
        step.startTime instanceof Date && Number.isFinite(step.startTime.getTime())
          ? step.startTime
          : result.startTime;
      const durationMs = Math.max(0, Math.round(step.duration));
      const status = step.error ? ('failed' as const) : ('passed' as const);
      const source = this.sourceLocation(step.location, fallbackSource);
      if (step.category === 'test.step' || step.category === 'pw:api') {
        actions.push({
          actionId: createDeterministicId(
            'action',
            `${test.id}:${result.retry}:${executionIndex}:${step.category}:${step.title}`,
          ),
          stepId,
          status,
          startedAt: started.toISOString(),
          endedAt: new Date(started.getTime() + durationMs).toISOString(),
          durationMs,
          ...(step.error?.message ? { error: step.error.message.slice(0, 20_000) } : {}),
          ...(source ? { source } : {}),
        });
      }
      if (step.category === 'expect') {
        checks.push({
          checkId: createDeterministicId(
            'check',
            `${test.id}:${result.retry}:${executionIndex}:${step.title}`,
          ),
          stepId,
          status,
          message: `${step.title}${step.error?.message ? `: ${step.error.message}` : ''}`.slice(
            0,
            20_000,
          ),
          ...(source ? { source } : {}),
        });
      }
      for (const child of step.steps) visit(child, stepId);
    };
    for (const step of result.steps) visit(step);

    if (actions.length === 0 && checks.length === 0) {
      checks.push({
        checkId: createDeterministicId('check', `${test.id}:${result.retry}:playwright-result`),
        stepId: fallbackStepId,
        status: mappedStatus(result.status),
        message: `Playwright completed the test with status ${result.status}.`,
        ...(fallbackSource ? { source: fallbackSource } : {}),
      });
    }
    return { actions, checks };
  }

  /**
   * Preserve Playwright's supported screenshot, trace, and video attachments as local,
   * content-addressed diagnostic evidence. Scenebook Beat screenshots are already materialized as
   * typed States and are excluded here. These debugging artifacts are never treated as publication
   * States or as privacy-cleared merely because a typed State passed its own scanner.
   */
  private async debugAttachments(
    result: TestResult,
    beats: readonly CapturedBeatMetadata[],
  ): Promise<{ readonly attachments: AssetRef[]; readonly trace?: AssetRef }> {
    const stateAttachmentNames = new Set(
      beats.flatMap((beat) => beat.states.map((state) => state.screenshotAttachment)),
    );
    const attachments: AssetRef[] = [];
    let trace: AssetRef | undefined;
    for (const attachment of result.attachments) {
      if (stateAttachmentNames.has(attachment.name)) continue;
      const role = debugAttachmentRole(attachment);
      if (!role) continue;
      const bytes = await attachmentBytes(
        attachment,
        role === 'screenshot' ? MAX_SCREENSHOT_ATTACHMENT_BYTES : MAX_DEBUG_ATTACHMENT_BYTES,
      );
      const hash = sha256(bytes);
      const path = `assets/${hash}${extensionFor(attachment.contentType)}`;
      await atomicWrite(join(this.outputDirectory(), path), bytes);
      const dimensions =
        role === 'screenshot'
          ? await fingerprintScreenshot(bytes).then(({ width, height }) => ({ width, height }))
          : undefined;
      const reference: AssetRef = {
        sha256: hash,
        path,
        mediaType: attachment.contentType,
        byteLength: bytes.byteLength,
        role,
        ...dimensions,
      };
      if (role === 'trace') trace = reference;
      else attachments.push(reference);
    }
    return { attachments, ...(trace ? { trace } : {}) };
  }

  private revision() {
    const root = this.projectRoot();
    const repository = this.options.repository ?? process.env.GITHUB_REPOSITORY ?? basename(root);
    const environmentCommit = this.options.commit ?? process.env.GITHUB_SHA;
    const commit =
      environmentCommit && environmentCommit.length >= 7
        ? environmentCommit
        : sha256(root).slice(0, 12);
    return {
      provider: process.env.GITHUB_REPOSITORY ? ('github' as const) : ('generic' as const),
      repository,
      commit,
      ...((this.options.branch ?? process.env.GITHUB_REF_NAME)
        ? { branch: this.options.branch ?? process.env.GITHUB_REF_NAME }
        : {}),
      ...(process.env.GITHUB_REF ? { ref: process.env.GITHUB_REF } : {}),
      dirty: process.env.SCENEBOOK_GIT_DIRTY === '1',
    };
  }

  private async writeRun(test: TestCase, result: TestResult): Promise<WrittenRun> {
    const output = this.outputDirectory();
    const scene = parseSceneAnnotation(test);
    const beats = await parseBeatAttachments(result);
    const seenStepIds = new Set<string>();
    for (const beat of beats) {
      if (beat.sceneId !== scene.id) {
        throw new Error(
          `Captured beat ${beat.stepId} belongs to Scene ${beat.sceneId}, expected ${scene.id}.`,
        );
      }
      if (seenStepIds.has(beat.stepId))
        throw new Error(`Duplicate captured beat Step id: ${beat.stepId}`);
      seenStepIds.add(beat.stepId);
      const phases = new Set<string>();
      for (const state of beat.states) {
        if (state.sceneId !== scene.id || state.stepId !== beat.stepId) {
          throw new Error(`Captured State does not match beat ${scene.id}/${beat.stepId}.`);
        }
        if (phases.has(state.phase))
          throw new Error(`Duplicate ${state.phase} State for Step ${beat.stepId}.`);
        phases.add(state.phase);
      }
    }
    const attachmentByName = new Map(
      result.attachments.map((attachment) => [attachment.name, attachment]),
    );
    const states: StateEvidence[] = [];

    for (const beat of beats) {
      for (const state of beat.states) {
        const attachment = attachmentByName.get(state.screenshotAttachment);
        if (!attachment)
          throw new Error(`Missing screenshot attachment ${state.screenshotAttachment}.`);
        const bytes = await attachmentBytes(attachment, MAX_SCREENSHOT_ATTACHMENT_BYTES);
        const hash = sha256(bytes);
        if (hash !== state.screenshotHash)
          throw new Error(`Screenshot hash mismatch for ${attachment.name}.`);
        const extension = extensionFor(attachment.contentType);
        const assetPath = `assets/${hash}${extension}`;
        await atomicWrite(join(output, assetPath), bytes);
        const fingerprint = await fingerprintScreenshot(bytes);
        const reference: AssetRef = {
          sha256: hash,
          path: assetPath,
          mediaType: attachment.contentType,
          byteLength: bytes.byteLength,
          role: 'screenshot',
          width: fingerprint.width,
          height: fingerprint.height,
        };
        states.push({
          id: createDeterministicId('state', `${scene.id}:${state.stepId}:${state.phase}:${hash}`),
          sceneId: scene.id,
          stepId: state.stepId,
          phase: state.phase,
          capturedAt: state.capturedAt,
          route: state.route,
          viewport: state.viewport,
          screenshot: reference,
          ...(state.target ? { target: state.target } : {}),
          ...(state.semantic ? { semantic: state.semantic } : {}),
          screenshotHash: hash,
          perceptualHash: fingerprint.perceptualHash,
          masksApplied: [...state.masksApplied],
          privacy: PrivacySummarySchema.parse(state.privacy ?? privacy(state.capturedAt)),
        });
      }
    }

    const importedTitles = provisionalStepTitles(result.steps);
    const importedSteps = importedTitles.length
      ? importedTitles.map((title, index) => ({
          id: createDeterministicId('step', `${index}:${title}`),
          title,
        }))
      : [{ id: 'outcome', title: 'Verify the outcome' }];
    const source = this.testSourceLocation(test, scene.definition);
    const sceneArtifact = SceneSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id: scene.id,
      title: scene.title,
      slug: slugify(scene.id),
      status: 'draft',
      capability: 'monitored',
      audience: scene.audience,
      tags: scene.tags,
      ...(scene.criticality ? { criticality: scene.criticality } : {}),
      ...(scene.description ? { description: scene.description } : {}),
      steps: beats.length
        ? beats.map((beat) => {
            const evidence = states.filter((state) => state.stepId === beat.stepId);
            const before = evidence.find((state) => state.phase === 'before');
            const after = evidence.find((state) => state.phase === 'after');
            const sceneState = (state: StateEvidence) => ({
              id: state.id,
              route: state.route,
              viewport: state.viewport,
              screenshot: state.screenshot,
              capturedAt: state.capturedAt,
            });
            if (!before && !after) {
              return {
                id: beat.stepId,
                kind: 'explanation' as const,
                title: beat.title,
                ...(beat.instruction ? { instruction: beat.instruction } : {}),
                ...(source ? { source } : {}),
              };
            }
            const primary = after ?? before!;
            return {
              id: beat.stepId,
              kind: 'browser' as const,
              title: beat.title,
              ...(beat.instruction ? { instruction: beat.instruction } : {}),
              states: {
                ...(before ? { before: sceneState(before) } : {}),
                ...(after ? { after: sceneState(after) } : {}),
              },
              ...(primary.target ? { target: primary.target } : {}),
              presentation: { state: before && after ? 'both' : after ? 'after' : 'before' },
              ...(source ? { source } : {}),
            };
          })
        : importedSteps.map((step) => ({
            id: step.id,
            kind: 'explanation' as const,
            title: step.title,
            ...(source ? { source } : {}),
          })),
      assets: [
        ...new Map(states.map((state) => [state.screenshot.sha256, state.screenshot])).values(),
      ],
      automation: {
        level: 'monitored',
        framework: 'playwright',
        ...(source
          ? {
              linkedTest: {
                path: source.path,
                title: test.title,
                ...(test.parent.project()?.name ? { project: test.parent.project()!.name } : {}),
              },
            }
          : {}),
      },
    });
    const expectedStepIds = sceneArtifact.steps.map((step) => step.id);
    const sourceRevision = sceneSourceRevision(sceneArtifact);
    await atomicWrite(
      join(output, 'scenes', sceneArtifact.id, `${sourceRevision}.json`),
      `${stableStringify(sceneArtifact)}\n`,
    );
    const startedAt = result.startTime.toISOString();
    const endedAt = new Date(result.startTime.getTime() + result.duration).toISOString();
    const status = mappedStatus(result.status);
    const execution = this.executionEvidence(test, result, sceneArtifact, beats, source);
    const debug = await this.debugAttachments(result, beats);
    const attemptId = createDeterministicId(
      'attempt',
      `${test.id}:${test.repeatEachIndex ?? 0}:${result.retry}:${startedAt}`,
    );
    const errors = result.errors.map((error) => {
      const message = error.message ?? 'Playwright reported an unknown execution error.';
      return {
        class: message.toLowerCase().includes('locator')
          ? ('selector' as const)
          : ('execution' as const),
        message,
        retryable: result.status === 'timedOut',
        ...(error.stack ? { stack: error.stack } : {}),
      };
    });
    const run = RunArtifactSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      artifactVersion: ARTIFACT_VERSION,
      id: createDeterministicId('run', `${test.id}:${startedAt}`),
      projectId: this.projectId(),
      kind: 'run',
      createdAt: endedAt,
      producer: { name: '@scenebook/playwright', version: '0.1.0', runtime: process.version },
      sceneId: scene.id,
      runTargetId: this.runTargetId(test),
      repository: this.revision(),
      sourceRevision,
      status,
      expectedStepIds: [...new Set(expectedStepIds)],
      attempts: [
        {
          id: attemptId,
          index: result.retry,
          retry: result.retry,
          repeat: test.repeatEachIndex ?? 0,
          status,
          startedAt,
          endedAt,
          durationMs: Math.max(0, Math.round(result.duration)),
          actions: execution.actions,
          checks: execution.checks,
          states,
          errors,
          attachments: debug.attachments,
          ...(debug.trace ? { trace: debug.trace } : {}),
          ...(this.config?.shard ? { shard: this.config.shard } : {}),
          privacy: aggregatePrivacy(
            states.map((state) => state.privacy),
            endedAt,
          ),
        },
      ],
      selectedAttemptId: attemptId,
      startedAt,
      endedAt,
      durationMs: Math.max(0, Math.round(result.duration)),
      privacy: aggregatePrivacy(
        states.map((state) => state.privacy),
        endedAt,
      ),
    });
    const path = join(output, 'runs', `${run.id}.json`);
    return {
      artifact: run,
      path,
      hash: artifactHash(run),
      definitionIdentity: stableStringify({
        title: test.title,
        source: source ?? null,
      }),
    };
  }

  private async finalizeRuns(): Promise<WrittenRun[]> {
    const grouped = new Map<string, WrittenRun[]>();
    for (const run of this.runs) {
      const key = `${run.artifact.sceneId}\u0000${run.artifact.runTargetId}`;
      const group = grouped.get(key) ?? [];
      group.push(run);
      grouped.set(key, group);
    }
    const finalized: WrittenRun[] = [];
    for (const group of grouped.values()) {
      const definitions = new Set(group.map((entry) => entry.definitionIdentity));
      if (definitions.size !== 1) {
        const first = group[0]!.artifact;
        throw new Error(
          `Multiple Playwright tests claim Scene ${first.sceneId} on Run Target ${first.runTargetId}. Use one executable owner per Scene.`,
        );
      }
      const first = group[0]!.artifact;
      const expected = stableStringify(first.expectedStepIds);
      if (group.some((entry) => stableStringify(entry.artifact.expectedStepIds) !== expected)) {
        throw new Error(
          `Retries or repeats produced incompatible Step plans for Scene ${first.sceneId}.`,
        );
      }
      const attempts = group
        .flatMap((entry) => entry.artifact.attempts)
        .sort(
          (left, right) =>
            (left.repeat ?? 0) - (right.repeat ?? 0) ||
            (left.retry ?? left.index) - (right.retry ?? right.index) ||
            left.startedAt.localeCompare(right.startedAt),
        );
      const identities = new Set<string>();
      for (const attempt of attempts) {
        const identity = `${attempt.repeat ?? 0}\u0000${attempt.retry ?? attempt.index}`;
        if (identities.has(identity)) {
          throw new Error(
            `Duplicate Playwright attempt for Scene ${first.sceneId}: repeat ${attempt.repeat ?? 0}, retry ${attempt.retry ?? attempt.index}.`,
          );
        }
        identities.add(identity);
      }
      const indexedAttempts = attempts.map((attempt, index) => ({ ...attempt, index }));
      const finalsByRepeat = new Map<number, (typeof indexedAttempts)[number]>();
      for (const attempt of indexedAttempts) finalsByRepeat.set(attempt.repeat ?? 0, attempt);
      const finals = [...finalsByRepeat.values()].sort(
        (left, right) => (left.repeat ?? 0) - (right.repeat ?? 0),
      );
      const statusRank: Readonly<Record<RunArtifact['status'], number>> = {
        passed: 0,
        skipped: 1,
        cancelled: 2,
        failed: 3,
        blocked: 4,
      };
      const selected = finals.reduce((current, candidate) =>
        statusRank[candidate.status] >= statusRank[current.status] ? candidate : current,
      );
      const selectedSource = group.find(
        (entry) => entry.artifact.selectedAttemptId === selected.id,
      )!.artifact;
      const startedAt = indexedAttempts[0]!.startedAt;
      const endedAt = indexedAttempts.reduce(
        (latest, attempt) => (attempt.endedAt > latest ? attempt.endedAt : latest),
        indexedAttempts[0]!.endedAt,
      );
      const unclassified = RunArtifactSchema.parse({
        ...selectedSource,
        id: createDeterministicId(
          'run',
          `${this.revision().commit}:${first.sceneId}:${first.runTargetId}:${startedAt}`,
        ),
        createdAt: endedAt,
        status: selected.status,
        attempts: indexedAttempts,
        selectedAttemptId: selected.id,
        startedAt,
        endedAt,
        durationMs: indexedAttempts.reduce((total, attempt) => total + attempt.durationMs, 0),
        privacy: aggregatePrivacy(
          indexedAttempts.map((attempt) => attempt.privacy),
          endedAt,
        ),
      });
      const baseline = await this.baseline(unclassified.sceneId, unclassified.runTargetId);
      const reviewed = reviewRunEvidence(unclassified, baseline);
      const path = join(this.outputDirectory(), 'runs', `${reviewed.run.id}.json`);
      await atomicWrite(path, `${stableStringify(reviewed.run)}\n`);
      await atomicWrite(
        join(this.outputDirectory(), 'reviews', `${reviewed.review.id}.json`),
        `${stableStringify(reviewed.review)}\n`,
      );
      finalized.push({
        artifact: reviewed.run,
        path,
        hash: artifactHash(reviewed.run),
        review: reviewed.review,
        definitionIdentity: group[0]!.definitionIdentity,
      });
    }
    return finalized;
  }

  private async writeBuild(result: FullResult): Promise<void> {
    const endedAt = new Date();
    const output = this.outputDirectory();
    const runs = [...this.runs].sort(
      (left, right) =>
        left.artifact.sceneId.localeCompare(right.artifact.sceneId) ||
        left.artifact.runTargetId.localeCompare(right.artifact.runTargetId) ||
        left.artifact.id.localeCompare(right.artifact.id),
    );
    const planned = new Map<string, { sceneId: string; runTargetId: string; required: true }>();
    for (const test of this.suite?.allTests() ?? []) {
      const scene = parseSceneAnnotation(test);
      const runTargetId = this.runTargetId(test);
      planned.set(`${scene.id}\u0000${runTargetId}`, {
        sceneId: scene.id,
        runTargetId,
        required: true,
      });
    }
    for (const { artifact } of runs) {
      planned.set(`${artifact.sceneId}\u0000${artifact.runTargetId}`, {
        sceneId: artifact.sceneId,
        runTargetId: artifact.runTargetId,
        required: true,
      });
    }
    const expectedRunPlan = [...planned.values()];
    if (expectedRunPlan.length === 0) {
      expectedRunPlan.push({
        sceneId: 'no-tests-discovered',
        runTargetId: 'primary',
        required: true,
      });
    }
    const unfinished = Math.max(0, expectedRunPlan.length - runs.length);
    const nonFinal = runs.filter(
      (run) => run.artifact.status === 'skipped' || run.artifact.status === 'cancelled',
    ).length;
    const pending = unfinished + nonFinal;
    const finalRuns = runs.filter(
      (run) => run.artifact.status !== 'skipped' && run.artifact.status !== 'cancelled',
    );
    const passed = finalRuns.filter((run) => run.artifact.changeState === 'passed').length;
    const changed = finalRuns.filter((run) => run.artifact.changeState === 'changed').length;
    const broken = finalRuns.filter((run) => run.artifact.changeState === 'broken').length;
    const blocked = finalRuns.filter((run) => run.artifact.changeState === 'blocked').length;
    const status =
      result.status === 'interrupted'
        ? ('cancelled' as const)
        : broken > 0 || pending > 0
          ? ('failed' as const)
          : blocked > 0
            ? ('blocked' as const)
            : changed > 0
              ? ('changed' as const)
              : ('passed' as const);
    const shard = this.config?.shard ?? undefined;
    const build: BuildArtifact = BuildArtifactSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      artifactVersion: ARTIFACT_VERSION,
      id: createDeterministicId(
        'build',
        `${this.revision().commit}:${this.startedAt.toISOString()}`,
      ),
      projectId: this.projectId(),
      kind: 'build',
      createdAt: endedAt.toISOString(),
      producer: { name: '@scenebook/playwright', version: '0.1.0', runtime: process.version },
      repository: this.revision(),
      trigger:
        process.env.GITHUB_EVENT_NAME === 'pull_request'
          ? 'pull-request'
          : process.env.CI
            ? 'push'
            : 'local',
      completeness: shard ? 'partial' : 'complete',
      ...(shard ? { shard } : {}),
      status,
      expectedRunPlan,
      runs: runs.map(({ artifact, path, hash }) => ({
        sceneId: artifact.sceneId,
        runTargetId: artifact.runTargetId,
        required: true,
        run: {
          id: artifact.id,
          kind: 'run',
          sha256: hash,
          path: relative(output, path).replaceAll('\\', '/'),
        },
        status: artifact.status,
        changeState: artifact.changeState,
      })),
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      summary: {
        total: expectedRunPlan.length,
        passed,
        changed,
        broken,
        blocked,
        pending,
      },
    });
    const buildDirectory = shard
      ? join(output, 'shards', `${shard.current}-of-${shard.total}`)
      : output;
    await atomicWrite(join(buildDirectory, 'build.json'), `${stableStringify(build)}\n`);
    const reviews = runs.flatMap((run) => (run.review ? [run.review] : []));
    const githubChecks = githubCheckPayloadsForReviews({
      headSha: build.repository.commit,
      reviews,
      ...(this.options.githubDetailsUrl ? { detailsUrl: this.options.githubDetailsUrl } : {}),
    });
    await atomicWrite(
      join(buildDirectory, 'github-checks.json'),
      `${stableStringify(githubChecks)}\n`,
    );
  }
}
