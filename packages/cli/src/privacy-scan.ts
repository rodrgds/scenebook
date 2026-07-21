import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { sha256, stableStringify } from '@scenebook/core';
import {
  PRIVACY_SCANNER_VERSION,
  assessAssetPrivacy,
  scanOcrSegments,
  scanStructuredValue,
  combinePrivacyScanResults,
  type AssetPrivacyAssessment,
  type OcrSegment,
  type PrivacyScanResult,
  type PrivacyScanOptions,
} from '@scenebook/privacy';
import {
  BaselineSchema,
  BuildArtifactSchema,
  PrivacySummarySchema,
  RunArtifactSchema,
  type Baseline,
  type PrivacySummary,
  type Review,
  type RunArtifact,
} from '@scenebook/schema';
import {
  githubCheckPayloadsForReviews,
  readBoundedRegularFile,
  readBoundedRegularFileAtPath,
  rebuildBuildEvidence,
  reviewRunEvidence,
  SafeFileReadError,
} from '@scenebook/playwright';
import { glob } from 'tinyglobby';
import { writeFileAtomically } from './atomic-write.js';

export interface OcrProvider {
  readonly id: string;
  readonly version: string;
  scan(input: {
    readonly path: string;
    readonly assetHash: string;
  }): Promise<readonly OcrSegment[]>;
}

export interface PrivacyCacheBinding {
  readonly version: 1;
  readonly policyDigest: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly privacyScannerVersion: string;
  readonly scannerVersion: string;
}

export interface RunEvidenceAttestation {
  readonly run: RunArtifact;
  readonly review: Review;
  readonly assessments: readonly AssetPrivacyAssessment[];
}

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_OCR_STDOUT_BYTES = 8 * 1024 * 1024;
const OCR_PROCESS_TIMEOUT_MS = 120_000;
const MAX_EVIDENCE_JSON_BYTES = 16 * 1024 * 1024;
const MAX_OCR_INPUT_BYTES = 250 * 1024 * 1024;
const SENSITIVE_ENVIRONMENT_KEY =
  /(auth|cookie|credential|database_url|pass(word|wd)?|private[_-]?key|secret|token|(^|_)key($|_))/iu;

function providerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !SENSITIVE_ENVIRONMENT_KEY.test(key)),
  );
}

function runCapture(executable: string, arguments_: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: providerEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let processError: Error | undefined;
    const timeout = setTimeout(() => {
      processError = new Error(
        `OCR provider exceeded its ${OCR_PROCESS_TIMEOUT_MS / 1_000}-second execution limit.`,
      );
      child.kill('SIGKILL');
    }, OCR_PROCESS_TIMEOUT_MS);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_OCR_STDOUT_BYTES) {
        processError = new Error(
          `OCR provider exceeded its ${MAX_OCR_STDOUT_BYTES / (1024 * 1024)} MiB output limit.`,
        );
        child.kill('SIGKILL');
        return;
      }
      stdout = `${stdout}${chunk}`;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (processError) reject(processError);
      else resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

function substitute(argument: string, input: { path: string; assetHash: string }): string {
  return argument.replaceAll('{input}', input.path).replaceAll('{hash}', input.assetHash);
}

export function createCommandOcrProvider(options: {
  readonly command: readonly [string, ...string[]];
  readonly id: string;
  readonly version: string;
  readonly run?: (executable: string, arguments_: readonly string[]) => Promise<ProcessResult>;
}): OcrProvider {
  const [executable, ...arguments_] = options.command;
  if (!executable) throw new Error('OCR command requires an executable.');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(options.id)) {
    throw new Error('OCR provider id must use letters, numbers, dots, underscores, or hyphens.');
  }
  if (
    !options.version.trim() ||
    options.version.length > 500 ||
    /[\u0000-\u001f\u007f]/u.test(options.version)
  ) {
    throw new Error('OCR provider version must be non-empty printable text.');
  }
  if (!options.command.some((argument) => argument.includes('{input}'))) {
    throw new Error('OCR command must contain an {input} placeholder.');
  }
  const runner = options.run ?? runCapture;
  return {
    id: options.id,
    version: options.version,
    async scan(input) {
      let result: ProcessResult;
      try {
        result = await runner(
          executable,
          arguments_.map((argument) => substitute(argument, input)),
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(
            `OCR executable ${JSON.stringify(executable)} is not installed or not on PATH. Install it or provide --command-json with a local OCR provider.`,
          );
        }
        throw error;
      }
      if (result.code !== 0) {
        throw new Error(
          `OCR provider ${options.id} exited with ${result.code}: ${result.stderr.trim() || 'no diagnostic output'}`,
        );
      }
      return [{ text: result.stdout, assetHash: input.assetHash }];
    },
  };
}

export async function tesseractProvider(): Promise<OcrProvider> {
  let version: ProcessResult;
  try {
    version = await runCapture('tesseract', ['--version']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Tesseract OCR is not installed or not on PATH. Install tesseract, or use --command-json with another local OCR provider.',
      );
    }
    throw error;
  }
  if (version.code !== 0) throw new Error(`Unable to identify Tesseract: ${version.stderr.trim()}`);
  const scannerVersion = version.stdout.split(/\r?\n/u)[0]?.trim() || 'tesseract-unknown';
  return createCommandOcrProvider({
    command: ['tesseract', '{input}', 'stdout'],
    id: 'tesseract',
    version: scannerVersion,
  });
}

export async function scanAssetFiles(options: {
  readonly assets: readonly {
    readonly hash: string;
    readonly path: string;
    readonly root?: string;
    readonly byteLength?: number;
  }[];
  readonly provider: OcrProvider;
  readonly assessmentDirectory: string;
  readonly scanOptions?: PrivacyScanOptions;
  readonly policyDigest: string;
}): Promise<readonly AssetPrivacyAssessment[]> {
  if (!/^[a-f0-9]{64}$/u.test(options.policyDigest)) {
    throw new Error('Privacy policy digest must be a lowercase SHA-256 value.');
  }
  await mkdir(options.assessmentDirectory, { recursive: true, mode: 0o700 });
  const scanDirectory = await mkdtemp(join(options.assessmentDirectory, '.scan-'));
  try {
    const assessments: AssetPrivacyAssessment[] = [];
    let privacyScannerVersion: string | undefined;
    for (const asset of [...options.assets].sort((left, right) =>
      left.hash.localeCompare(right.hash),
    )) {
      const source = asset.root
        ? await readBoundedRegularFile(asset.root, asset.path, {
            maximumBytes: MAX_OCR_INPUT_BYTES,
            minimumBytes: 1,
          })
        : await readBoundedRegularFileAtPath(asset.path, {
            maximumBytes: MAX_OCR_INPUT_BYTES,
            minimumBytes: 1,
          });
      const bytes = source.bytes;
      const actualHash = sha256(bytes);
      if (
        actualHash !== asset.hash ||
        (asset.byteLength !== undefined && bytes.byteLength !== asset.byteLength)
      ) {
        throw new Error(
          `Refusing OCR assessment for ${asset.path}: expected ${asset.hash}, received ${actualHash}.`,
        );
      }

      // Providers receive a private copy of the bytes we just hashed instead of
      // reopening the source path. This keeps the OCR result bound to the exact
      // derivative even if another process replaces the source during a scan.
      const sourceExtension = extname(asset.path).toLowerCase();
      const extension = /^\.[a-z0-9]{1,12}$/u.test(sourceExtension) ? sourceExtension : '';
      const scanPath = join(scanDirectory, `${asset.hash}.${randomUUID()}${extension}`);
      await writeFile(scanPath, bytes, { flag: 'wx', mode: 0o600 });
      const segments = await options.provider.scan({ path: scanPath, assetHash: asset.hash });
      let scannedHash: string;
      try {
        scannedHash = sha256(
          (
            await readBoundedRegularFileAtPath(scanPath, {
              maximumBytes: bytes.byteLength,
              minimumBytes: bytes.byteLength,
            })
          ).bytes,
        );
      } catch (error) {
        if (error instanceof SafeFileReadError) {
          throw new Error(
            `OCR provider ${options.provider.id} modified its immutable input for ${asset.hash}.`,
            { cause: error },
          );
        }
        throw error;
      }
      if (scannedHash !== asset.hash) {
        throw new Error(
          `OCR provider ${options.provider.id} modified its immutable input for ${asset.hash}.`,
        );
      }
      if (segments.some((segment) => segment.assetHash !== asset.hash)) {
        throw new Error(
          `OCR provider ${options.provider.id} returned a segment for the wrong asset hash.`,
        );
      }
      const result = scanOcrSegments(segments, options.scanOptions);
      if (privacyScannerVersion && privacyScannerVersion !== result.scannerVersion) {
        throw new Error('Privacy scanner version changed during one OCR assessment batch.');
      }
      privacyScannerVersion = result.scannerVersion;
      const scannerVersion = `${options.provider.id}/${options.provider.version};@scenebook/privacy/${result.scannerVersion}`;
      const assessment: AssetPrivacyAssessment = {
        ...assessAssetPrivacy(asset.hash, result, 'ocr'),
        scannerVersion,
        policyDigest: options.policyDigest,
        providerId: options.provider.id,
        providerVersion: options.provider.version,
      };
      await writeFileAtomically(
        resolve(options.assessmentDirectory, `${asset.hash}.json`),
        `${JSON.stringify(assessment, null, 2)}\n`,
      );
      assessments.push(assessment);
    }
    const resolvedPrivacyScannerVersion = privacyScannerVersion ?? PRIVACY_SCANNER_VERSION;
    const binding: PrivacyCacheBinding = {
      version: 1,
      policyDigest: options.policyDigest,
      providerId: options.provider.id,
      providerVersion: options.provider.version,
      privacyScannerVersion: resolvedPrivacyScannerVersion,
      scannerVersion: `${options.provider.id}/${options.provider.version};@scenebook/privacy/${resolvedPrivacyScannerVersion}`,
    };
    await writeFileAtomically(
      resolve(options.assessmentDirectory, '_context.json'),
      `${JSON.stringify(binding, null, 2)}\n`,
    );
    return assessments;
  } finally {
    await rm(scanDirectory, { recursive: true, force: true });
  }
}

function withoutPrivacy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => withoutPrivacy(entry));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'privacy')
      .map(([key, entry]) => [key, withoutPrivacy(entry)]),
  );
}

function privacySummary(
  results: readonly PrivacyScanResult[],
  scannedAt: string,
  scannerVersion: string,
): PrivacySummary {
  const combined = combinePrivacyScanResults(results, { now: () => new Date(scannedAt) });
  const findings = [
    ...new Map(
      combined.findings.map((finding) => [
        `${finding.ruleId}\u0000${finding.path}\u0000${finding.fingerprint}`,
        finding,
      ]),
    ).values(),
  ];
  return PrivacySummarySchema.parse({
    status: combined.status,
    scannedAt,
    scannerVersion: scannerVersion.slice(0, 100),
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

function resultFromAssessment(assessment: AssetPrivacyAssessment): PrivacyScanResult {
  if (assessment.status === 'unknown' || !assessment.scannedAt || !assessment.scannerVersion) {
    throw new Error(`Exact screenshot ${assessment.assetHash} has no completed OCR attestation.`);
  }
  return {
    status: assessment.status,
    scannedAt: assessment.scannedAt,
    scannerVersion: assessment.scannerVersion,
    counts: {
      info: assessment.findings.filter((finding) => finding.severity === 'info').length,
      low: assessment.findings.filter((finding) => finding.severity === 'low').length,
      medium: assessment.findings.filter((finding) => finding.severity === 'medium').length,
      high: assessment.findings.filter((finding) => finding.severity === 'high').length,
      blocking: assessment.findings.filter((finding) => finding.severity === 'blocking').length,
    },
    findings: assessment.findings,
  };
}

async function loadBaseline(
  baselineDirectory: string,
  run: RunArtifact,
): Promise<Baseline | undefined> {
  try {
    const value = await readBoundedRegularFile(
      baselineDirectory,
      join(run.sceneId, `${run.runTargetId}.json`),
      { maximumBytes: MAX_EVIDENCE_JSON_BYTES, minimumBytes: 1 },
    );
    return BaselineSchema.parse(JSON.parse(Buffer.from(value.bytes).toString('utf8')));
  } catch (error) {
    if (error instanceof SafeFileReadError && error.reason === 'missing') return undefined;
    throw error;
  }
}

export async function attestRunEvidence(options: {
  readonly runPath: string;
  readonly evidenceDirectory: string;
  readonly baselineDirectory: string;
  readonly assessmentDirectory: string;
  readonly provider: OcrProvider;
  readonly scanOptions?: PrivacyScanOptions;
  readonly policyDigest: string;
}): Promise<RunEvidenceAttestation> {
  const evidenceDirectory = resolve(options.evidenceDirectory);
  const requestedRunPath = resolve(options.runPath);
  const logicalRunPath = relative(evidenceDirectory, requestedRunPath);
  if (!logicalRunPath || logicalRunPath.startsWith('..') || isAbsolute(logicalRunPath)) {
    throw new Error('Run artifact must be inside the configured evidence directory.');
  }
  const runFile = await readBoundedRegularFile(evidenceDirectory, logicalRunPath, {
    maximumBytes: MAX_EVIDENCE_JSON_BYTES,
    minimumBytes: 1,
  });
  const runPath = runFile.path;
  const run = RunArtifactSchema.parse(JSON.parse(Buffer.from(runFile.bytes).toString('utf8')));
  const assets = new Map<
    string,
    { hash: string; path: string; root: string; byteLength: number }
  >();
  for (const attempt of run.attempts) {
    for (const state of attempt.states) {
      const existing = assets.get(state.screenshot.sha256);
      if (existing && existing.byteLength !== state.screenshot.byteLength) {
        throw new Error(`Run screenshot identity has conflicting sizes: ${state.screenshot.path}`);
      }
      assets.set(state.screenshot.sha256, {
        hash: state.screenshot.sha256,
        path: state.screenshot.path,
        root: evidenceDirectory,
        byteLength: state.screenshot.byteLength,
      });
    }
  }
  const assessments = await scanAssetFiles({
    assets: [...assets.values()],
    provider: options.provider,
    assessmentDirectory: options.assessmentDirectory,
    scanOptions: options.scanOptions,
    policyDigest: options.policyDigest,
  });
  const assessmentByHash = new Map(
    assessments.map((assessment) => [assessment.assetHash, assessment]),
  );
  const scannedAt = assessments[0]?.scannedAt ?? new Date().toISOString();
  const scannerVersion =
    assessments[0]?.scannerVersion ??
    `${options.provider.id}/${options.provider.version};@scenebook/privacy/${PRIVACY_SCANNER_VERSION}`;
  const attempts = run.attempts.map((attempt) => {
    const stateResults: PrivacyScanResult[] = [];
    const states = attempt.states.map((state) => {
      const assessment = assessmentByHash.get(state.screenshot.sha256);
      if (!assessment) throw new Error(`Missing OCR assessment for ${state.screenshot.sha256}.`);
      const results = [
        scanStructuredValue(withoutPrivacy(state), {
          ...options.scanOptions,
          path: `$run/${run.id}/attempt/${attempt.id}/state/${state.id}`,
          now: () => new Date(scannedAt),
        }),
        resultFromAssessment(assessment),
      ];
      stateResults.push(...results);
      return { ...state, privacy: privacySummary(results, scannedAt, scannerVersion) };
    });
    const attemptResult = scanStructuredValue(withoutPrivacy({ ...attempt, states: [] }), {
      ...options.scanOptions,
      path: `$run/${run.id}/attempt/${attempt.id}`,
      now: () => new Date(scannedAt),
    });
    return {
      ...attempt,
      states,
      privacy: privacySummary([attemptResult, ...stateResults], scannedAt, scannerVersion),
    };
  });
  const runResult = scanStructuredValue(withoutPrivacy({ ...run, attempts: [] }), {
    ...options.scanOptions,
    path: `$run/${run.id}`,
    now: () => new Date(scannedAt),
  });
  const attested = RunArtifactSchema.parse({
    ...run,
    attempts,
    privacy: privacySummary(
      [
        runResult,
        ...attempts.flatMap((attempt) => [
          scanStructuredValue(withoutPrivacy({ ...attempt, states: [] }), {
            ...options.scanOptions,
            path: `$run/${run.id}/attempt/${attempt.id}`,
            now: () => new Date(scannedAt),
          }),
          ...attempt.states.map((state) =>
            resultFromAssessment(assessmentByHash.get(state.screenshot.sha256)!),
          ),
        ]),
      ],
      scannedAt,
      scannerVersion,
    ),
  });
  const baseline = await loadBaseline(options.baselineDirectory, attested);
  const reviewed = reviewRunEvidence(attested, baseline);
  await writeFileAtomically(runPath, `${stableStringify(reviewed.run)}\n`, { mode: 0o600 });
  const reviewPath = resolve(evidenceDirectory, 'reviews', `${reviewed.review.id}.json`);
  await writeFileAtomically(reviewPath, `${stableStringify(reviewed.review)}\n`, { mode: 0o600 });
  return { ...reviewed, assessments };
}

export async function refreshEvidenceBuilds(options: {
  readonly evidenceDirectory: string;
  readonly baselineDirectory: string;
  readonly githubDetailsUrl?: string;
}): Promise<void> {
  const buildPaths = await glob(['build.json', 'shards/*/build.json'], {
    cwd: options.evidenceDirectory,
    absolute: true,
    onlyFiles: true,
  });
  for (const buildPath of buildPaths) {
    const buildFile = await readBoundedRegularFileAtPath(buildPath, {
      maximumBytes: MAX_EVIDENCE_JSON_BYTES,
      minimumBytes: 1,
    });
    const build = BuildArtifactSchema.parse(
      JSON.parse(Buffer.from(buildFile.bytes).toString('utf8')),
    );
    const runs: RunArtifact[] = [];
    const reviews: Review[] = [];
    for (const reference of build.runs) {
      if (!reference.run?.path) continue;
      const runFile = await readBoundedRegularFile(options.evidenceDirectory, reference.run.path, {
        maximumBytes: MAX_EVIDENCE_JSON_BYTES,
        minimumBytes: 1,
      });
      const runPath = runFile.path;
      const run = RunArtifactSchema.parse(JSON.parse(Buffer.from(runFile.bytes).toString('utf8')));
      const baseline = await loadBaseline(options.baselineDirectory, run);
      const reviewed = reviewRunEvidence(run, baseline);
      if (stableStringify(reviewed.run) !== stableStringify(run)) {
        await writeFileAtomically(runPath, `${stableStringify(reviewed.run)}\n`, { mode: 0o600 });
      }
      await writeFileAtomically(
        resolve(options.evidenceDirectory, 'reviews', `${reviewed.review.id}.json`),
        `${stableStringify(reviewed.review)}\n`,
        { mode: 0o600 },
      );
      runs.push(reviewed.run);
      reviews.push(reviewed.review);
    }
    const refreshed = rebuildBuildEvidence(build, runs);
    await writeFileAtomically(buildPath, `${stableStringify(refreshed)}\n`, { mode: 0o600 });
    await writeFileAtomically(
      resolve(dirname(buildPath), 'github-checks.json'),
      `${stableStringify(
        githubCheckPayloadsForReviews({
          headSha: refreshed.repository.commit,
          reviews,
          ...(options.githubDetailsUrl ? { detailsUrl: options.githubDetailsUrl } : {}),
        }),
      )}\n`,
      { mode: 0o600 },
    );
  }
}
