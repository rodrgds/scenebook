#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, realpath } from 'node:fs/promises';
import {
  DEFAULT_MAX_JSON_BYTES,
  REVIEW_FORMAT,
  REVIEW_VERSION,
  readBoundedAbsoluteFile,
  readBoundedRegularFile,
  ReviewArtifactError,
  validateRelativePath,
} from './github-review-artifact.mjs';

const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ARTIFACT_SHA = /^[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TOKEN_CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_CHECK_PAYLOADS = 100;
const MAX_RESPONSE_BYTES = 64 * 1024;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function boundedText(value, maximum, label, { allowEmpty = false } = {}) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    FORBIDDEN_TEXT.test(value)
  ) {
    throw new ReviewArtifactError(`${label} is not a bounded printable string.`, 'checks-schema');
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReviewArtifactError(`${label} must be a positive integer.`, 'checks-schema');
  }
  return value;
}

function safeDetailsUrl(value, serverUrl) {
  if (value === undefined) return undefined;
  const raw = boundedText(value, 2_048, 'Check details URL');
  let url;
  let server;
  try {
    url = new URL(raw);
    server = new URL(serverUrl);
  } catch {
    throw new ReviewArtifactError('Check details URL must be an absolute URL.', 'checks-schema');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.origin !== server.origin
  ) {
    throw new ReviewArtifactError(
      'Check details URL must be credential-free HTTPS on the GitHub server origin.',
      'checks-schema',
    );
  }
  return url.href;
}

function checkAnnotation(value) {
  const candidate = record(value);
  if (!candidate) throw new ReviewArtifactError('Check annotation is malformed.', 'checks-schema');
  const path = validateRelativePath(candidate.path, 'Check annotation path');
  const startLine = positiveInteger(candidate.start_line, 'Check annotation start line');
  const endLine = positiveInteger(candidate.end_line, 'Check annotation end line');
  if (endLine < startLine) {
    throw new ReviewArtifactError('Check annotation line range is reversed.', 'checks-schema');
  }
  if (!['notice', 'warning', 'failure'].includes(candidate.annotation_level)) {
    throw new ReviewArtifactError('Check annotation level is unsupported.', 'checks-schema');
  }
  return {
    path,
    start_line: startLine,
    end_line: endLine,
    annotation_level: candidate.annotation_level,
    title: boundedText(candidate.title, 255, 'Check annotation title'),
    message: boundedText(candidate.message, 65_535, 'Check annotation message'),
  };
}

export function validateCheckPayload(value, options) {
  const candidate = record(value);
  const output = record(candidate?.output);
  if (!candidate || !output) {
    throw new ReviewArtifactError('GitHub Check payload is malformed.', 'checks-schema');
  }
  if (candidate.head_sha !== options.headSha) {
    throw new ReviewArtifactError(
      'GitHub Check payload is not bound to the tested GITHUB_SHA.',
      'provenance',
    );
  }
  if (
    candidate.status !== 'completed' ||
    !['success', 'neutral', 'failure'].includes(candidate.conclusion)
  ) {
    throw new ReviewArtifactError(
      'Only completed Scenebook Check payloads are accepted.',
      'checks-schema',
    );
  }
  const annotations = Array.isArray(output.annotations) ? output.annotations : [];
  if (annotations.length > 50) {
    throw new ReviewArtifactError(
      'A GitHub Check payload exceeds the 50-annotation API limit.',
      'checks-schema',
    );
  }
  const uploadedDetailsUrl = options.artifactUrl
    ? safeDetailsUrl(options.artifactUrl, options.serverUrl)
    : undefined;
  const existingDetailsUrl =
    !uploadedDetailsUrl && candidate.details_url
      ? safeDetailsUrl(candidate.details_url, options.serverUrl)
      : undefined;
  return {
    name: boundedText(candidate.name, 100, 'Check name'),
    head_sha: options.headSha,
    status: 'completed',
    conclusion: candidate.conclusion,
    ...(uploadedDetailsUrl || existingDetailsUrl
      ? { details_url: uploadedDetailsUrl ?? existingDetailsUrl }
      : {}),
    output: {
      title: boundedText(output.title, 255, 'Check title'),
      summary: boundedText(output.summary, 65_535, 'Check summary'),
      text: boundedText(output.text, 65_535, 'Check text', { allowEmpty: true }),
      annotations: annotations.map(checkAnnotation),
    },
  };
}

async function readJsonFile(path, maximumBytes = DEFAULT_MAX_JSON_BYTES) {
  const file = await readBoundedAbsoluteFile(path, { maximumBytes, minimumBytes: 2 });
  try {
    return JSON.parse(file.bytes.toString('utf8'));
  } catch {
    throw new ReviewArtifactError('GitHub event payload is not valid JSON.', 'json');
  }
}

async function canonicalDirectory(path, label) {
  const supplied = resolve(path);
  const metadata = await lstat(supplied, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ReviewArtifactError(`${label} must be a real directory.`, 'symlink');
  }
  return realpath(supplied);
}

async function forkDisposition(environment) {
  const eventName = environment.GITHUB_EVENT_NAME;
  if (eventName === 'pull_request_target') {
    return { allowed: false, reason: 'pull_request_target workflows never post Scenebook Checks' };
  }
  if (eventName !== 'pull_request') return { allowed: true };
  if (!environment.GITHUB_EVENT_PATH) {
    return { allowed: false, reason: 'pull-request provenance is unavailable' };
  }
  let event;
  try {
    event = await readJsonFile(environment.GITHUB_EVENT_PATH, 8 * 1024 * 1024);
  } catch {
    return { allowed: false, reason: 'pull-request provenance could not be verified' };
  }
  const headRepository = record(record(record(event)?.pull_request)?.head)?.repo;
  const fullName = record(headRepository)?.full_name;
  if (fullName !== environment.GITHUB_REPOSITORY) {
    return { allowed: false, reason: 'fork pull requests never receive or use a Checks token' };
  }
  return { allowed: true };
}

async function reviewManifest(reportDirectory, headSha) {
  if (typeof reportDirectory !== 'string' || reportDirectory.length < 1) {
    throw new ReviewArtifactError('The generated review directory is required.', 'report');
  }
  let value;
  try {
    const reportRoot = await canonicalDirectory(reportDirectory, 'Generated review directory');
    const file = await readBoundedRegularFile(reportRoot, 'manifest.json', {
      maximumBytes: DEFAULT_MAX_JSON_BYTES,
      minimumBytes: 2,
    });
    value = JSON.parse(file.bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof ReviewArtifactError) throw error;
    throw new ReviewArtifactError('Review manifest is unavailable or invalid.', 'report');
  }
  const manifest = record(value);
  const build = record(manifest?.build);
  if (
    manifest?.format !== REVIEW_FORMAT ||
    manifest?.version !== REVIEW_VERSION ||
    !build ||
    !Array.isArray(manifest.integrityIssues)
  ) {
    throw new ReviewArtifactError('Review manifest is malformed.', 'report');
  }
  if (
    build.status === 'unavailable' &&
    build.id === null &&
    build.revision === null &&
    build.commit === null
  ) {
    return { usable: false, reason: 'no exact current Build is available for Check posting' };
  }
  if (!SAFE_BUILD_STATUS.has(build.status) || !ARTIFACT_SHA.test(build.revision ?? '')) {
    throw new ReviewArtifactError('Review manifest Build binding is malformed.', 'report');
  }
  if (build.commit !== headSha || typeof build.id !== 'string') {
    return { usable: false, reason: 'no exact current Build is available for Check posting' };
  }
  if (manifest.integrityIssues.length > 0) {
    return { usable: false, reason: 'review evidence has integrity issues' };
  }
  return { usable: true, buildStatus: build.status };
}

const SAFE_BUILD_STATUS = new Set(['passed', 'changed', 'failed', 'blocked', 'cancelled']);

function conclusionForBuild(status) {
  if (status === 'passed') return 'success';
  if (status === 'changed') return 'neutral';
  return 'failure';
}

function bindPayloadToBuild(payload, status) {
  const conclusion = conclusionForBuild(status);
  if (payload.conclusion === conclusion) return payload;
  return {
    ...payload,
    conclusion,
    output: {
      title: `Scenebook review — ${status}`,
      summary: `## Scenebook review\n\nBuild status: **${status}**. Verification did not produce a releasable unchanged Build. Download the privacy-safe artifact for bounded evidence.`,
      text: 'The Check conclusion is fail-closed from the exact current Build status.',
      annotations: [],
    },
  };
}

async function responseBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return '[response exceeded 64 KiB]';
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryDelay(response, attempt) {
  const raw = response.headers.get('retry-after');
  const seconds = raw && /^\d+$/u.test(raw) ? Number(raw) : undefined;
  return Math.min(seconds === undefined ? 250 * 4 ** attempt : seconds * 1_000, 5_000);
}

async function postOne(fetchImplementation, url, token, payload) {
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImplementation(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'scenebook-github-action/1',
          'x-github-api-version': '2022-11-28',
        },
        body,
      });
    } catch {
      if (attempt < 2) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * 4 ** attempt));
        continue;
      }
      throw new ReviewArtifactError('GitHub Checks API request failed.', 'github-api');
    }
    const responseText = await responseBody(response);
    if (response.ok) return;
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay(response, attempt)));
      continue;
    }
    throw new ReviewArtifactError(
      `GitHub Checks API returned ${response.status}; response bytes: ${Buffer.byteLength(responseText)}.`,
      'github-api',
    );
  }
}

/** Post only exact, locally generated payloads to the active repository. */
export async function postGithubChecks(options) {
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS !== 'true') {
    throw new ReviewArtifactError('GitHub Checks posting requires GitHub Actions.', 'environment');
  }
  const repository = environment.GITHUB_REPOSITORY;
  const headSha = environment.GITHUB_SHA;
  const token = options.token;
  if (!REPOSITORY.test(repository ?? '') || !FULL_GIT_SHA.test(headSha ?? '')) {
    throw new ReviewArtifactError(
      'GitHub repository or tested commit provenance is invalid.',
      'provenance',
    );
  }
  const disposition = await forkDisposition(environment);
  if (!disposition.allowed) return { status: 'skipped', reason: disposition.reason, posted: 0 };
  if (
    typeof token !== 'string' ||
    token.length < 1 ||
    token.length > 4_096 ||
    TOKEN_CONTROL.test(token)
  ) {
    throw new ReviewArtifactError('An explicit bounded GitHub token is required.', 'token');
  }
  const manifest = await reviewManifest(options.reportDirectory, headSha);
  if (!manifest.usable) return { status: 'skipped', reason: manifest.reason, posted: 0 };

  const workspace = await canonicalDirectory(options.workspace, 'Working directory');
  const evidenceRoot = resolve(workspace, validateRelativePath(options.evidenceDirectory));
  let checksFile;
  try {
    checksFile = await readBoundedRegularFile(evidenceRoot, 'github-checks.json', {
      maximumBytes: DEFAULT_MAX_JSON_BYTES,
      minimumBytes: 2,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ReviewArtifactError(
        'The exact current Build produced no GitHub Check payload.',
        'checks-schema',
      );
    }
    throw error;
  }
  let values;
  try {
    values = JSON.parse(checksFile.bytes.toString('utf8'));
  } catch {
    throw new ReviewArtifactError('github-checks.json is not valid JSON.', 'json');
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_CHECK_PAYLOADS) {
    throw new ReviewArtifactError(
      'github-checks.json has an invalid payload count.',
      'checks-schema',
    );
  }
  const serverUrl = environment.GITHUB_SERVER_URL ?? 'https://github.com';
  const payloads = values.map((value) =>
    bindPayloadToBuild(
      validateCheckPayload(value, {
        headSha,
        serverUrl,
        artifactUrl: options.artifactUrl,
      }),
      manifest.buildStatus,
    ),
  );
  let api;
  try {
    api = new URL(environment.GITHUB_API_URL ?? 'https://api.github.com');
  } catch {
    throw new ReviewArtifactError('GITHUB_API_URL is invalid.', 'environment');
  }
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) {
    throw new ReviewArtifactError('GitHub API URL must be credential-free HTTPS.', 'environment');
  }
  const server = new URL(serverUrl);
  const isPublicGitHub = server.origin === 'https://github.com';
  if (
    (isPublicGitHub && (api.origin !== 'https://api.github.com' || api.pathname !== '/')) ||
    (!isPublicGitHub && (api.origin !== server.origin || !/^\/api\/v3\/?$/u.test(api.pathname)))
  ) {
    throw new ReviewArtifactError(
      'GitHub API URL does not match the active GitHub server.',
      'environment',
    );
  }
  const [owner, name] = repository.split('/').map(encodeURIComponent);
  const endpoint = new URL(
    `${api.pathname.replace(/\/$/u, '')}/repos/${owner}/${name}/check-runs`,
    api.origin,
  ).href;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  for (const payload of payloads) {
    await postOne(fetchImplementation, endpoint, token, payload);
  }
  return { status: 'posted', posted: payloads.length };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new ReviewArtifactError('Expected named GitHub Checks arguments.');
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const workspace = args.get('working-directory');
  const token = process.env.SCENEBOOK_ACTION_GITHUB_TOKEN;
  if (!workspace) throw new ReviewArtifactError('--working-directory is required.');
  const result = await postGithubChecks({
    workspace,
    evidenceDirectory: args.get('evidence-directory') ?? '.scenebook/runs',
    reportDirectory: args.get('report-directory'),
    artifactUrl: args.get('artifact-url') || undefined,
    token,
  });
  if (result.status === 'skipped') {
    process.stdout.write(`Scenebook Checks skipped: ${result.reason}.\n`);
  } else {
    process.stdout.write(`Scenebook Checks: posted ${result.posted} completed check(s).\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `Scenebook Checks failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 4;
  });
}
