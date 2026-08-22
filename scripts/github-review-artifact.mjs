#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEW_FORMAT = 'scenebook-github-review';
export const REVIEW_VERSION = 1;
export const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_ASSET_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const MAX_RUNS = 5_000;
const MAX_STATES = 20_000;
const MAX_TOTAL_JSON_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const BUILD_STATUSES = new Set(['passed', 'changed', 'failed', 'blocked', 'cancelled']);
const RUN_STATUSES = new Set(['passed', 'failed', 'blocked', 'cancelled', 'skipped']);
const CHANGE_STATES = new Set(['passed', 'changed', 'broken', 'blocked', 'unknown']);
const SUMMARY_KEYS = ['passed', 'changed', 'broken', 'blocked', 'pending'];

export class ReviewArtifactError extends Error {
  constructor(message, code = 'invalid-evidence') {
    super(message);
    this.name = 'ReviewArtifactError';
    this.code = code;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalArtifactHash(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8'));
}

export function validateRelativePath(value, label = 'path') {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new ReviewArtifactError(`${label} must be a normalized POSIX relative path.`, 'path');
  }
  return value;
}

function within(root, path) {
  const fromRoot = relative(root, path);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  );
}

async function assertDirectoryTree(root, path) {
  const fromRoot = relative(root, path);
  if (!within(root, path)) throw new ReviewArtifactError('Resolved path escapes its root.', 'path');
  if (fromRoot === '') return;
  let current = root;
  for (const part of fromRoot.split(sep).slice(0, -1)) {
    current = resolve(current, part);
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ReviewArtifactError('Evidence path crosses a symlink or non-directory.', 'symlink');
    }
  }
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Read a bounded regular file through one descriptor. Every path component is
 * symlink-free and the descriptor identity is rechecked after the read.
 */
export async function readBoundedRegularFile(root, relativePath, options = {}) {
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAX_JSON_BYTES;
  const minimumBytes = options.minimumBytes ?? 1;
  const normalized = validateRelativePath(relativePath);
  const suppliedRoot = resolve(root);
  const rootMetadata = await lstat(suppliedRoot, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new ReviewArtifactError('Evidence root must be a real directory.', 'symlink');
  }
  const trustedRoot = await realpath(suppliedRoot);
  if (trustedRoot !== suppliedRoot) {
    throw new ReviewArtifactError(
      'Evidence root crosses a symlinked directory component.',
      'symlink',
    );
  }
  const path = resolve(trustedRoot, normalized);
  if (!within(trustedRoot, path))
    throw new ReviewArtifactError('Evidence path escapes its root.', 'path');
  await assertDirectoryTree(trustedRoot, path);

  const pathBefore = await lstat(path, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new ReviewArtifactError('Evidence input must be a regular, non-symlink file.', 'symlink');
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFile(pathBefore, before)) {
      throw new ReviewArtifactError('Evidence input identity changed before it was read.', 'race');
    }
    if (before.size < BigInt(minimumBytes) || before.size > BigInt(maximumBytes)) {
      throw new ReviewArtifactError(
        `Evidence input must be between ${minimumBytes} and ${maximumBytes} bytes.`,
        'size',
      );
    }
    const resolvedPath = await realpath(path);
    if (resolvedPath !== path || !within(trustedRoot, resolvedPath)) {
      throw new ReviewArtifactError('Evidence input resolves outside its trusted root.', 'symlink');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      bytes.byteLength !== Number(before.size) ||
      !sameFile(before, after) ||
      !sameFile(before, pathAfter) ||
      (await realpath(path)) !== resolvedPath
    ) {
      throw new ReviewArtifactError('Evidence input changed while it was being read.', 'race');
    }
    return {
      bytes,
      path: resolvedPath,
      sha256: sha256(bytes),
      modifiedAtMs: Number(after.mtimeNs / 1_000_000n),
    };
  } finally {
    await handle.close();
  }
}

export async function readBoundedAbsoluteFile(path, options = {}) {
  const parent = await realpath(dirname(resolve(path)));
  return readBoundedRegularFile(parent, basename(path), options);
}

async function readJson(root, path, maximumBytes = DEFAULT_MAX_JSON_BYTES) {
  const file = await readBoundedRegularFile(root, path, { maximumBytes, minimumBytes: 2 });
  try {
    return { value: JSON.parse(file.bytes.toString('utf8')), file };
  } catch {
    throw new ReviewArtifactError(`${path} is not valid JSON.`, 'json');
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function privacyStatus(value) {
  const summary = record(value);
  const counts = record(summary?.counts);
  const findings = Array.isArray(summary?.findings) ? summary.findings : undefined;
  const status = text(summary?.status, 'unknown');
  const scannedAt = text(summary?.scannedAt);
  const scannerVersion = text(summary?.scannerVersion);
  if (
    !summary ||
    !counts ||
    !findings ||
    !['clear', 'warning', 'unknown', 'blocked', 'quarantined'].includes(status) ||
    !Number.isFinite(Date.parse(scannedAt)) ||
    scannerVersion.length < 1 ||
    scannerVersion.length > 100
  ) {
    return 'unknown';
  }
  const severities = ['info', 'low', 'medium', 'high', 'blocking'];
  if (
    severities.some(
      (severity) => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0,
    ) ||
    findings.some((finding) => {
      const candidate = record(finding);
      return (
        !candidate ||
        !severities.includes(candidate.severity) ||
        !['open', 'masked', 'allowed', 'false-positive', 'quarantined'].includes(
          candidate.disposition,
        )
      );
    }) ||
    severities.some(
      (severity) =>
        counts[severity] !==
        findings.filter((finding) => record(finding)?.severity === severity).length,
    )
  ) {
    return 'unknown';
  }
  if (
    status === 'clear' &&
    (findings.some((finding) => record(finding)?.disposition === 'open') ||
      /(?:unscanned|unknown|pending)/iu.test(scannerVersion) ||
      !/@scenebook\/privacy\/[0-9]/u.test(scannerVersion))
  ) {
    return 'unknown';
  }
  return status;
}

function safeId(value, fallback) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : fallback;
}

function pngDimensions(bytes) {
  if (
    bytes.byteLength < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new ReviewArtifactError('Screenshot bytes are not a canonical PNG stream.', 'media');
  }
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.byteLength - offset - 12) {
      throw new ReviewArtifactError('PNG screenshot contains a truncated chunk.', 'media');
    }
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    offset += length + 12;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.byteLength) {
    throw new ReviewArtifactError('PNG screenshot has no exact terminal IEND chunk.', 'media');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), extension: 'png' };
}

function jpegDimensions(bytes) {
  if (
    bytes.byteLength < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    throw new ReviewArtifactError('Screenshot bytes are not a JPEG stream.', 'media');
  }
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
        extension: 'jpg',
      };
    }
    offset += length;
  }
  throw new ReviewArtifactError('JPEG screenshot has no valid frame header.', 'media');
}

export function inspectScreenshot(bytes, mediaType, maximumPixels = DEFAULT_MAX_IMAGE_PIXELS) {
  const dimensions =
    mediaType === 'image/png'
      ? pngDimensions(bytes)
      : mediaType === 'image/jpeg'
        ? jpegDimensions(bytes)
        : (() => {
            throw new ReviewArtifactError(
              'Only PNG and JPEG screenshots may enter review artifacts.',
              'media',
            );
          })();
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > 16_384 ||
    dimensions.height > 16_384 ||
    dimensions.width * dimensions.height > maximumPixels
  ) {
    throw new ReviewArtifactError(
      'Screenshot dimensions exceed the review artifact limit.',
      'dimensions',
    );
  }
  return dimensions;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusClass(value) {
  return ['passed', 'changed', 'failed', 'broken', 'blocked', 'cancelled', 'skipped'].includes(
    value,
  )
    ? value
    : 'unknown';
}

function renderHtml(report) {
  const cards = report.runs
    .map((run) => {
      const images = run.states
        .map(
          (state) => `<figure>
            <a href="${escapeHtml(state.assetPath)}" aria-label="Open full-resolution ${escapeHtml(`${run.sceneId}, ${state.stepId}, ${state.phase}`)} screenshot"><img src="${escapeHtml(state.assetPath)}" alt="${escapeHtml(`${run.sceneId}, ${state.stepId}, ${state.phase}`)}" width="${state.width}" height="${state.height}" loading="lazy"></a>
            <figcaption><strong>${escapeHtml(state.stepId)}</strong> · ${escapeHtml(state.phase)} · ${state.width}×${state.height}</figcaption>
          </figure>`,
        )
        .join('\n');
      const privacy =
        run.privacy === 'clear' ? 'Clear screenshot evidence' : 'Screenshots withheld';
      return `<article class="run">
        <header><div><h2>${escapeHtml(run.sceneId)}</h2><p>${escapeHtml(run.runTargetId)} · execution ${escapeHtml(run.status)}</p></div><span class="pill ${statusClass(run.changeState)}">${escapeHtml(run.changeState)}</span></header>
        <p class="privacy ${run.privacy === 'clear' ? 'clear' : 'withheld'}">${escapeHtml(privacy)} · ${run.included} included · ${run.excluded} withheld</p>
        ${images ? `<div class="grid">${images}</div>` : '<div class="empty">No privacy-clear screenshot pixels were included for this run.</div>'}
      </article>`;
    })
    .join('\n');
  const warnings = report.integrityIssues.length
    ? `<section class="issues"><h2>Evidence integrity</h2><p>${report.integrityIssues.length} input issue(s) were withheld. The artifact contains no bytes from rejected inputs.</p><ul>${report.integrityIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul></section>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <meta name="referrer" content="no-referrer">
  <title>Scenebook visual review</title>
  <style>
    :root{color-scheme:dark;--bg:#12110f;--panel:#1c1a17;--line:#37312a;--text:#f2ede4;--muted:#ada498;--accent:#f07d24;--good:#54b788;--bad:#ef6b63;--warn:#e6af4b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}main{width:min(1400px,100%);margin:auto;padding:32px}h1,h2,p{margin-top:0}.lede{color:var(--muted);max-width:72ch}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.metric,.run,.issues{background:var(--panel);border:1px solid var(--line);border-radius:14px}.metric{padding:16px}.metric b{display:block;font-size:24px}.metric span,figcaption,.run header p{color:var(--muted)}.run{padding:20px;margin:18px 0}.run header{display:flex;justify-content:space-between;gap:16px;align-items:start}.run h2{margin-bottom:2px}.pill{border:1px solid var(--line);border-radius:999px;padding:4px 10px;text-transform:capitalize}.pill.passed{color:var(--good)}.pill.changed,.pill.unknown{color:var(--warn)}.pill.failed,.pill.broken,.pill.blocked{color:var(--bad)}.privacy{padding:9px 12px;border-radius:8px;background:#151411}.privacy.clear{color:var(--good)}.privacy.withheld{color:var(--warn)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr));gap:16px}figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#0c0c0b}img{display:block;width:100%;height:auto}figcaption{padding:9px 12px}.empty{border:1px dashed var(--line);border-radius:10px;padding:28px;color:var(--muted)}.issues{padding:18px;border-color:#714b27}.issues li{margin:6px 0}@media(max-width:600px){main{padding:18px}.run{padding:14px}}
  </style>
</head>
<body><main>
  <h1>Scenebook visual review</h1>
  <p class="lede">A static, script-free review of exact screenshot evidence. Screenshots are included only when the Run, selected attempt, and State each have clear privacy attestation and the asset passes path, descriptor, hash, size, and media validation.</p>
  <section class="summary">
    <div class="metric"><span>Verification exit</span><b>${report.verificationExitCode}</b></div>
    <div class="metric"><span>Build status</span><b>${escapeHtml(report.build.status)}</b></div>
    <div class="metric"><span>Runs</span><b>${report.runs.length}</b></div>
    <div class="metric"><span>Screenshots included</span><b>${report.summary.included}</b></div>
    <div class="metric"><span>Screenshots withheld</span><b>${report.summary.excluded}</b></div>
  </section>
  ${warnings}
  ${cards || '<div class="empty">No complete Build evidence was available. The verification exit code is retained above.</div>'}
</main></body></html>\n`;
}

function renderSummary(report) {
  const lines = [
    '## Scenebook visual review',
    '',
    `- Verification exit: ${report.verificationExitCode}`,
    `- Build status: ${report.build.status}`,
    `- Runs: ${report.runs.length}`,
    `- Privacy-clear screenshots included: ${report.summary.included}`,
    `- Screenshots withheld: ${report.summary.excluded}`,
    `- Evidence integrity issues: ${report.integrityIssues.length}`,
    '',
    'Download the **Scenebook visual review** artifact and open `index.html` for the static report.',
  ];
  return `${lines.join('\n')}\n`;
}

function buildReference(value) {
  const candidate = record(value);
  if (!candidate) throw new ReviewArtifactError('Build Run reference is malformed.', 'schema');
  const run = record(candidate.run);
  if (!run) throw new ReviewArtifactError('Build Run reference is missing.', 'schema');
  const id = safeId(run.id);
  const sceneId = safeId(candidate.sceneId);
  const runTargetId = safeId(candidate.runTargetId);
  if (
    !id ||
    !sceneId ||
    !runTargetId ||
    typeof candidate.required !== 'boolean' ||
    run.kind !== 'run' ||
    !SHA256.test(text(run.sha256))
  ) {
    throw new ReviewArtifactError('Build Run binding is malformed.', 'schema');
  }
  const path = validateRelativePath(run.path, 'Run reference path');
  if (path !== `runs/${id}.json`) {
    throw new ReviewArtifactError('Build Run path is not the canonical reporter path.', 'path');
  }
  const status = text(candidate.status, 'unknown');
  const changeState = text(candidate.changeState, 'unknown');
  if (!RUN_STATUSES.has(status) || !CHANGE_STATES.has(changeState)) {
    throw new ReviewArtifactError('Build Run status is unsupported.', 'schema');
  }
  return {
    id,
    sha256: run.sha256,
    path,
    sceneId,
    runTargetId,
    required: candidate.required,
    status,
    changeState,
  };
}

function screenshotReference(value) {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.role !== 'screenshot' ||
    !SHA256.test(text(candidate.sha256)) ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength < 1
  ) {
    throw new ReviewArtifactError('State screenshot reference is malformed.', 'schema');
  }
  const path = validateRelativePath(candidate.path, 'Screenshot path');
  const filename = basename(path);
  if (!filename.startsWith(candidate.sha256)) {
    throw new ReviewArtifactError('Screenshot filename is not content-addressed.', 'schema');
  }
  if (
    (candidate.mediaType === 'image/png' && filename !== `${candidate.sha256}.png`) ||
    (candidate.mediaType === 'image/jpeg' &&
      filename !== `${candidate.sha256}.jpg` &&
      filename !== `${candidate.sha256}.jpeg`)
  ) {
    throw new ReviewArtifactError(
      'Screenshot extension disagrees with its declared media type.',
      'media',
    );
  }
  if (path !== `assets/${filename}`) {
    throw new ReviewArtifactError(
      'Screenshot is not in the canonical evidence asset directory.',
      'path',
    );
  }
  return {
    sha256: candidate.sha256,
    byteLength: candidate.byteLength,
    mediaType: text(candidate.mediaType),
    path,
    declaredWidth: Number.isSafeInteger(candidate.width) ? candidate.width : undefined,
    declaredHeight: Number.isSafeInteger(candidate.height) ? candidate.height : undefined,
  };
}

function issueMessage(error, context) {
  const code = error instanceof ReviewArtifactError ? error.code : 'invalid-evidence';
  return `${context}: withheld (${code}).`;
}

async function ensureNewOutputParent(outputDirectory) {
  const target = resolve(outputDirectory);
  const parent = dirname(target);
  const parentMetadata = await lstat(parent, { bigint: true });
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new ReviewArtifactError('Review artifact parent must be a real directory.', 'symlink');
  }
  try {
    await lstat(target);
    throw new ReviewArtifactError('Review artifact destination already exists.', 'output-exists');
  } catch (error) {
    if (error instanceof ReviewArtifactError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return { target, parent };
}

/** Generate a privacy-filtered static report from the exact reporter Build. */
export async function generateReviewArtifact(options) {
  const verificationExitCode = Number(options.verificationExitCode ?? 0);
  if (
    !Number.isInteger(verificationExitCode) ||
    verificationExitCode < 0 ||
    verificationExitCode > 255
  ) {
    throw new ReviewArtifactError('Verification exit code must be an integer from 0 through 255.');
  }
  const suppliedWorkspace = resolve(options.workspace);
  const workspaceMetadata = await lstat(suppliedWorkspace, { bigint: true });
  if (workspaceMetadata.isSymbolicLink() || !workspaceMetadata.isDirectory()) {
    throw new ReviewArtifactError('Working directory must be a real directory.', 'symlink');
  }
  const workspace = await realpath(suppliedWorkspace);
  const evidenceRelative = validateRelativePath(options.evidenceDirectory ?? '.scenebook/runs');
  const evidenceRoot = resolve(workspace, evidenceRelative);
  if (!within(workspace, evidenceRoot))
    throw new ReviewArtifactError('Evidence root escapes the workspace.', 'path');

  const maxAssetBytes = options.maximumAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  const maxTotalAssetBytes = options.maximumTotalAssetBytes ?? DEFAULT_MAX_TOTAL_ASSET_BYTES;
  const maxImagePixels = options.maximumImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS;
  const integrityIssues = [];
  const report = {
    format: REVIEW_FORMAT,
    version: REVIEW_VERSION,
    generatedAt: new Date().toISOString(),
    verificationExitCode,
    build: { id: null, revision: null, status: 'unavailable', commit: null },
    summary: { included: 0, excluded: 0, uniqueAssets: 0, totalAssetBytes: 0 },
    integrityIssues,
    runs: [],
    assets: [],
  };

  const { target, parent } = await ensureNewOutputParent(options.outputDirectory);
  const staging = resolve(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o700 });
  await mkdir(resolve(staging, 'assets'), { mode: 0o700 });
  let degraded = false;
  try {
    let build;
    let buildIsValid = false;
    let remainingJsonBytes = MAX_TOTAL_JSON_BYTES;
    try {
      const buildInput = await readJson(evidenceRoot, 'build.json');
      build = buildInput.value;
      remainingJsonBytes -= buildInput.file.bytes.byteLength;
      const candidate = record(build);
      if (
        !candidate ||
        candidate.schemaVersion !== 1 ||
        candidate.artifactVersion !== 1 ||
        candidate.kind !== 'build' ||
        !SAFE_ID.test(text(candidate.id)) ||
        !SAFE_ID.test(text(candidate.projectId)) ||
        candidate.completeness !== 'complete'
      ) {
        throw new ReviewArtifactError('build.json is not a Scenebook Build artifact.', 'schema');
      }
      if (
        !Array.isArray(candidate.runs) ||
        candidate.runs.length > MAX_RUNS ||
        !Array.isArray(candidate.expectedRunPlan) ||
        candidate.expectedRunPlan.length < 1 ||
        candidate.expectedRunPlan.length > MAX_RUNS
      ) {
        throw new ReviewArtifactError('Build Run references exceed the report limit.', 'schema');
      }
      if (!BUILD_STATUSES.has(candidate.status)) {
        throw new ReviewArtifactError('Build status is unsupported.', 'schema');
      }
      const summary = record(candidate.summary);
      const plan = new Map();
      for (const planned of candidate.expectedRunPlan) {
        const entry = record(planned);
        const sceneId = safeId(entry?.sceneId);
        const runTargetId = safeId(entry?.runTargetId);
        if (!sceneId || !runTargetId || typeof entry.required !== 'boolean') {
          throw new ReviewArtifactError('Build Run plan is malformed.', 'schema');
        }
        const key = `${sceneId}\u0000${runTargetId}`;
        if (plan.has(key)) {
          throw new ReviewArtifactError('Build Run plan contains duplicates.', 'schema');
        }
        plan.set(key, entry.required);
      }
      const parsedReferences = candidate.runs.map(buildReference);
      const referenceKeys = new Set();
      const calculatedSummary = {
        total: candidate.expectedRunPlan.length,
        passed: 0,
        changed: 0,
        broken: 0,
        blocked: 0,
        pending: candidate.expectedRunPlan.length - parsedReferences.length,
      };
      for (const reference of parsedReferences) {
        const key = `${reference.sceneId}\u0000${reference.runTargetId}`;
        if (referenceKeys.has(key) || !plan.has(key) || plan.get(key) !== reference.required) {
          throw new ReviewArtifactError(
            'Build Run ownership is duplicated or disagrees with its plan.',
            'schema',
          );
        }
        referenceKeys.add(key);
        if (
          reference.status === 'skipped' ||
          reference.status === 'cancelled' ||
          reference.changeState === 'unknown'
        ) {
          calculatedSummary.pending += 1;
        } else {
          calculatedSummary[reference.changeState] += 1;
        }
      }
      const calculatedStatus =
        calculatedSummary.broken > 0 || calculatedSummary.pending > 0
          ? 'failed'
          : calculatedSummary.blocked > 0
            ? 'blocked'
            : calculatedSummary.changed > 0
              ? 'changed'
              : 'passed';
      if (
        !summary ||
        !Number.isSafeInteger(summary.total) ||
        summary.total !== candidate.expectedRunPlan.length ||
        SUMMARY_KEYS.some((key) => !Number.isSafeInteger(summary[key]) || summary[key] < 0) ||
        SUMMARY_KEYS.reduce((total, key) => total + summary[key], 0) !== summary.total ||
        SUMMARY_KEYS.some((key) => summary[key] !== calculatedSummary[key]) ||
        (candidate.status !== 'cancelled' && candidate.status !== calculatedStatus)
      ) {
        throw new ReviewArtifactError('Build summary or status is not exact.', 'schema');
      }
      const repository = record(candidate.repository);
      const startedAt = Date.parse(text(candidate.startedAt));
      const minimumStartedAt = options.verificationStartedAt
        ? Date.parse(options.verificationStartedAt)
        : undefined;
      if (
        !Number.isFinite(startedAt) ||
        (minimumStartedAt !== undefined &&
          (!Number.isFinite(minimumStartedAt) ||
            startedAt < minimumStartedAt ||
            buildInput.file.modifiedAtMs < minimumStartedAt))
      ) {
        throw new ReviewArtifactError(
          'Build evidence predates this verification invocation.',
          'stale',
        );
      }
      if (
        options.expectedCommit &&
        (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options.expectedCommit) ||
          repository?.commit !== options.expectedCommit)
      ) {
        throw new ReviewArtifactError(
          'Build evidence is not bound to the tested commit.',
          'provenance',
        );
      }
      report.build = {
        id: candidate.id,
        revision: canonicalArtifactHash(candidate),
        status: text(candidate.status, 'unknown'),
        commit: /^[a-f0-9]{7,64}$/u.test(text(repository?.commit)) ? repository.commit : null,
      };
      buildIsValid = true;
    } catch (error) {
      degraded = true;
      integrityIssues.push(issueMessage(error, 'Build evidence'));
    }

    const copied = new Map();
    let stateCount = 0;
    if (buildIsValid && record(build) && Array.isArray(build.runs)) {
      for (const [runIndex, rawReference] of build.runs.entries()) {
        let reference;
        let run;
        let inputBudgetExhausted = false;
        try {
          reference = buildReference(rawReference);
          if (remainingJsonBytes < 2) {
            inputBudgetExhausted = true;
            throw new ReviewArtifactError('Run JSON exceeds the aggregate input limit.', 'size');
          }
          const runInput = await readJson(
            evidenceRoot,
            reference.path,
            Math.min(DEFAULT_MAX_JSON_BYTES, remainingJsonBytes),
          );
          run = runInput.value;
          remainingJsonBytes -= runInput.file.bytes.byteLength;
          const candidate = record(run);
          if (
            !candidate ||
            candidate.kind !== 'run' ||
            candidate.schemaVersion !== 1 ||
            candidate.artifactVersion !== 1 ||
            candidate.id !== reference.id ||
            candidate.projectId !== build.projectId ||
            canonicalArtifactHash(candidate) !== reference.sha256 ||
            safeId(candidate.sceneId) !== reference.sceneId ||
            safeId(candidate.runTargetId) !== reference.runTargetId ||
            text(candidate.status, 'unknown') !== reference.status ||
            text(candidate.changeState, 'unknown') !== reference.changeState ||
            (report.build.commit && record(candidate.repository)?.commit !== report.build.commit)
          ) {
            throw new ReviewArtifactError('Run does not match its exact Build binding.', 'binding');
          }
        } catch (error) {
          degraded = true;
          integrityIssues.push(issueMessage(error, `Run ${runIndex + 1}`));
          if (inputBudgetExhausted || error?.code === 'size') break;
          continue;
        }

        const runRecord = record(run);
        const attempts = Array.isArray(runRecord.attempts) ? runRecord.attempts : [];
        const selected = attempts.find(
          (attempt) => record(attempt)?.id === runRecord.selectedAttemptId,
        );
        const runPrivacy = privacyStatus(runRecord.privacy);
        const attemptPrivacy = privacyStatus(record(selected)?.privacy);
        const rawStates = Array.isArray(record(selected)?.states) ? selected.states : [];
        if (!selected) {
          degraded = true;
          integrityIssues.push(
            `Run ${runIndex + 1}: selected attempt is unavailable; screenshots were withheld.`,
          );
        }
        const containsNonClearState = rawStates.some(
          (state) => privacyStatus(record(state)?.privacy) !== 'clear',
        );
        if (
          (reference.changeState === 'passed' || reference.changeState === 'changed') &&
          (runPrivacy !== 'clear' || attemptPrivacy !== 'clear' || containsNonClearState)
        ) {
          degraded = true;
          integrityIssues.push(
            `Run ${runIndex + 1}: release-eligible status contradicts its privacy evidence; screenshots were withheld.`,
          );
        }
        stateCount += rawStates.length;
        if (stateCount > MAX_STATES) {
          degraded = true;
          integrityIssues.push(
            'State evidence exceeds the report limit: remaining screenshots were withheld.',
          );
          break;
        }
        const runReport = {
          sceneId: reference.sceneId,
          runTargetId: reference.runTargetId,
          status: reference.status,
          changeState: reference.changeState,
          privacy:
            runPrivacy === 'clear' && attemptPrivacy === 'clear' && !containsNonClearState
              ? 'clear'
              : runPrivacy === 'clear'
                ? attemptPrivacy === 'clear'
                  ? 'unknown'
                  : attemptPrivacy
                : runPrivacy,
          included: 0,
          excluded: 0,
          states: [],
        };
        for (const [stateIndex, rawState] of rawStates.entries()) {
          const state = record(rawState);
          const isPrivacyClear =
            runPrivacy === 'clear' &&
            attemptPrivacy === 'clear' &&
            privacyStatus(state?.privacy) === 'clear';
          if (!isPrivacyClear) {
            runReport.excluded += 1;
            report.summary.excluded += 1;
            continue;
          }
          try {
            if (!state) throw new ReviewArtifactError('State evidence is malformed.', 'schema');
            const stateId = safeId(state.id);
            const stepId = safeId(state.stepId);
            if (
              !stateId ||
              !stepId ||
              state.sceneId !== reference.sceneId ||
              !['before', 'after'].includes(state.phase)
            ) {
              throw new ReviewArtifactError('State identity is malformed.', 'schema');
            }
            const screenshot = screenshotReference(state.screenshot);
            if (state.screenshotHash !== screenshot.sha256) {
              throw new ReviewArtifactError('State screenshot hash binding disagrees.', 'binding');
            }
            if (screenshot.byteLength > maxAssetBytes) {
              throw new ReviewArtifactError('Screenshot exceeds its per-asset size limit.', 'size');
            }
            let copiedAsset = copied.get(screenshot.sha256);
            if (!copiedAsset) {
              if (report.summary.totalAssetBytes + screenshot.byteLength > maxTotalAssetBytes) {
                throw new ReviewArtifactError(
                  'Screenshots exceed the total artifact size limit.',
                  'size',
                );
              }
              const file = await readBoundedRegularFile(evidenceRoot, screenshot.path, {
                maximumBytes: maxAssetBytes,
                minimumBytes: 1,
              });
              if (
                file.sha256 !== screenshot.sha256 ||
                file.bytes.byteLength !== screenshot.byteLength
              ) {
                throw new ReviewArtifactError(
                  'Screenshot bytes do not match their exact asset binding.',
                  'binding',
                );
              }
              const dimensions = inspectScreenshot(
                file.bytes,
                screenshot.mediaType,
                maxImagePixels,
              );
              if (
                (screenshot.declaredWidth !== undefined &&
                  screenshot.declaredWidth !== dimensions.width) ||
                (screenshot.declaredHeight !== undefined &&
                  screenshot.declaredHeight !== dimensions.height)
              ) {
                throw new ReviewArtifactError(
                  'Screenshot dimensions disagree with its asset binding.',
                  'dimensions',
                );
              }
              const assetPath = `assets/${screenshot.sha256}.${dimensions.extension}`;
              await writeFile(resolve(staging, assetPath), file.bytes, { flag: 'wx', mode: 0o600 });
              copiedAsset = {
                sha256: screenshot.sha256,
                byteLength: screenshot.byteLength,
                mediaType: screenshot.mediaType,
                width: dimensions.width,
                height: dimensions.height,
                path: assetPath,
              };
              copied.set(screenshot.sha256, copiedAsset);
              report.assets.push(copiedAsset);
              report.summary.totalAssetBytes += screenshot.byteLength;
            } else if (
              copiedAsset.byteLength !== screenshot.byteLength ||
              copiedAsset.mediaType !== screenshot.mediaType ||
              (screenshot.declaredWidth !== undefined &&
                screenshot.declaredWidth !== copiedAsset.width) ||
              (screenshot.declaredHeight !== undefined &&
                screenshot.declaredHeight !== copiedAsset.height)
            ) {
              throw new ReviewArtifactError('Duplicate screenshot references disagree.', 'binding');
            }
            runReport.states.push({
              id: stateId,
              stepId,
              phase: state.phase,
              assetPath: copiedAsset.path,
              width: copiedAsset.width,
              height: copiedAsset.height,
            });
            runReport.included += 1;
            report.summary.included += 1;
          } catch (error) {
            degraded = true;
            runReport.excluded += 1;
            report.summary.excluded += 1;
            integrityIssues.push(
              issueMessage(error, `Run ${runIndex + 1}, privacy-clear State ${stateIndex + 1}`),
            );
          }
        }
        report.runs.push(runReport);
      }
    }

    report.summary.uniqueAssets = copied.size;
    report.assets.sort((left, right) => left.sha256.localeCompare(right.sha256));
    report.runs.sort(
      (left, right) =>
        left.sceneId.localeCompare(right.sceneId) ||
        left.runTargetId.localeCompare(right.runTargetId),
    );
    await writeFile(resolve(staging, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(resolve(staging, 'summary.md'), renderSummary(report), {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(resolve(staging, 'index.html'), renderHtml(report), {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(staging, target);
    return { report, degraded, exitCode: degraded && verificationExitCode === 0 ? 3 : 0 };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new ReviewArtifactError(
        'Expected --working-directory, --evidence-directory, --output, and --verification-exit-code.',
      );
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const workspace = args.get('working-directory');
  const outputDirectory = args.get('output');
  const verificationStartedAt = args.get('verification-started-at');
  const expectedCommit = args.get('expected-commit');
  if (!workspace || !outputDirectory || !verificationStartedAt || !expectedCommit) {
    throw new ReviewArtifactError(
      '--working-directory, --output, --verification-started-at, and --expected-commit are required.',
    );
  }
  const result = await generateReviewArtifact({
    workspace,
    evidenceDirectory: args.get('evidence-directory') ?? '.scenebook/runs',
    outputDirectory,
    verificationExitCode: Number(args.get('verification-exit-code') ?? '0'),
    verificationStartedAt,
    expectedCommit,
  });
  process.stdout.write(
    `Scenebook visual review: ${result.report.summary.included} privacy-clear screenshot(s), ${result.report.summary.excluded} withheld.\n`,
  );
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `Scenebook review artifact failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 3;
  });
}
