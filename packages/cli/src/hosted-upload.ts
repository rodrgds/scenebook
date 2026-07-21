import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, open, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { FORMAT_POLICY } from '@scenebook/compiler';
import {
  artifactHash,
  canonicalJsonHash,
  sceneSourceRevision,
  sha256,
  stableStringify,
} from '@scenebook/core';
import {
  combinePrivacyScanResults,
  PRIVACY_SCANNER_VERSION,
  scanOcrSegments,
  scanScenePrivacy,
  scanStructuredValue,
  type PrivacyScanResult,
} from '@scenebook/privacy';
import {
  BaselineSchema,
  BuildArtifactSchema,
  CompilerPublicationManifestSchema,
  IdSchema,
  MAX_PUBLICATION_FILES,
  PrivacySummarySchema,
  PublicationInventorySchema,
  ReleasePublicationSchema,
  RunArtifactSchema,
  ReviewSchema,
  SceneSchema,
  type BuildArtifact,
  type PrivacySummary,
  type PublicationFile as SchemaPublicationFile,
  type PublicationInventory,
  type ReleasePublication,
  type Review,
  type RunArtifact,
  type Scene,
} from '@scenebook/schema';
import {
  readBoundedRegularFile,
  readBoundedRegularFileAtPath,
  rebuildBuildEvidence,
  reviewRunEvidence,
  SafeFileReadError,
} from '@scenebook/playwright';
import { Zip, ZipDeflate } from 'fflate';

import type { OcrProvider } from './privacy-scan.js';
import { projectPrivacyScanOptions } from './project.js';
import { CliError, type LoadedConfig } from './types.js';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_OBJECT_BYTES = 250 * 1024 * 1024;
const MAX_OBJECTS = 512;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DETERMINISTIC_ZIP_ATTRIBUTES = (0o100644 << 16) >>> 0;

interface GitHubProvenance {
  readonly repository: string;
  readonly commit: string;
  readonly ref: string;
  readonly refName: string;
  readonly workflowRef: string;
}

export interface HostedUploadSettings {
  readonly serverUrl: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly oidcAudience: string;
  readonly oidcRequestUrl: string;
  readonly oidcRequestToken: string;
  readonly github: GitHubProvenance;
}

export interface HostedUploadInput {
  readonly serverUrl?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly oidcAudience?: string;
}

export interface HostedUploadResult {
  readonly uploadId: string;
  readonly manifestHash: string;
  readonly objectCount: number;
  readonly byteLength: number;
  readonly sceneCount: number;
  readonly runCount: number;
  readonly reviewCount: number;
  /** Exact immutable object binding required by hosted Release approval and promotion. */
  readonly publication: ReleasePublication;
}

/**
 * Exact deterministic archive contract shared by hosted upload and local
 * immutable candidate sealing. The archive remains in `stagingDirectory`
 * until its caller promotes or removes that directory.
 */
export interface CompiledPublicationArchive {
  readonly archivePath: string;
  readonly files: readonly SchemaPublicationFile[];
  readonly inventory: PublicationInventory;
  readonly publication: ReleasePublication;
  readonly byteLength: number;
}

interface ObjectSpec {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

interface UploadObject {
  readonly path: string;
  readonly spec: ObjectSpec;
  readonly source:
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
    | { readonly kind: 'file'; readonly path: string };
}

interface HostedAccessToken {
  readonly token: string;
  readonly expiresAt: number;
}

interface SceneRequest {
  readonly scene: Scene;
  readonly privacy: PrivacySummary;
}

interface RunRequest {
  readonly run: RunArtifact;
}

interface BuildRequest {
  readonly build: BuildArtifact;
}

interface ReviewRequest {
  readonly review: Review;
}

interface PreparedHostedEvidence {
  readonly build: BuildArtifact;
  readonly scenes: readonly SceneRequest[];
  readonly runs: readonly RunRequest[];
  readonly reviews: readonly ReviewRequest[];
  readonly buildRequest: BuildRequest;
  readonly objects: readonly UploadObject[];
  readonly objectFiles: readonly {
    path: string;
    sha256: string;
    byteLength: number;
    mediaType: string;
  }[];
  readonly publication: ReleasePublication & {
    readonly fileCount: number;
    readonly byteLength: number;
  };
}

type Fetch = typeof fetch;
type GitRunner = (
  directory: string,
  environment: NodeJS.ProcessEnv,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new CliError(`${label} is required for hosted evidence upload.`);
  return value.trim();
}

function refName(ref: string): string {
  for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/pull/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

function canonicalServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('Hosted server URL must be an absolute HTTPS URL.');
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CliError(
      'Hosted server URL must use HTTPS (or loopback HTTP) without credentials, query, or fragment.',
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url.href;
}

function safeOidcRequestUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('ACTIONS_ID_TOKEN_REQUEST_URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !/^(?:[a-z0-9-]+\.)*actions\.githubusercontent\.com$/iu.test(url.hostname)
  ) {
    throw new CliError(
      'ACTIONS_ID_TOKEN_REQUEST_URL must use the standard GitHub Actions HTTPS token host without credentials or a custom port.',
    );
  }
  return url.href;
}

export function prepareHostedUploadSettings(
  config: LoadedConfig,
  input: HostedUploadInput,
  environment: NodeJS.ProcessEnv,
): HostedUploadSettings {
  const workspaceId = IdSchema.parse(required(input.workspaceId, '--workspace-id'));
  const projectId = IdSchema.parse(required(input.projectId, '--project-id'));
  if (projectId !== config.project.id) {
    throw new CliError(
      `Hosted Project ${projectId} does not match configured Project ${config.project.id}.`,
    );
  }
  if (environment.GITHUB_ACTIONS !== 'true') {
    throw new CliError('Hosted upload requires the GitHub Actions OIDC environment.');
  }
  const repository = required(environment.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const commit = required(environment.GITHUB_SHA, 'GITHUB_SHA');
  const ref = required(environment.GITHUB_REF, 'GITHUB_REF');
  const environmentRefName = required(environment.GITHUB_REF_NAME, 'GITHUB_REF_NAME');
  const workflowRef = required(environment.GITHUB_WORKFLOW_REF, 'GITHUB_WORKFLOW_REF');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new CliError('GITHUB_REPOSITORY must be an owner/repository identifier.');
  }
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new CliError('GITHUB_SHA must be a full lowercase Git commit SHA.');
  }
  if (ref.length > 500 || environmentRefName.length > 500 || workflowRef.length > 1_000) {
    throw new CliError('GitHub ref or workflow provenance exceeds its safe length.');
  }
  if (!ref.startsWith('refs/') || environmentRefName !== refName(ref)) {
    throw new CliError('GITHUB_REF and GITHUB_REF_NAME do not describe the same exact ref.');
  }
  if (!workflowRef.startsWith(`${repository}/.github/workflows/`) || !workflowRef.includes('@')) {
    throw new CliError('GITHUB_WORKFLOW_REF is not bound to the active repository workflow.');
  }
  const audience = input.oidcAudience?.trim() || 'scenebook';
  if (audience.length > 200 || /[\u0000-\u001f\u007f]/u.test(audience)) {
    throw new CliError('--oidc-audience must be at most 200 printable characters.');
  }
  const oidcRequestToken = required(
    environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  );
  if (oidcRequestToken.length > 20_000 || /[\u0000-\u001f\u007f]/u.test(oidcRequestToken)) {
    throw new CliError('ACTIONS_ID_TOKEN_REQUEST_TOKEN has an invalid shape.');
  }
  return {
    serverUrl: canonicalServerUrl(required(input.serverUrl, '--server-url')),
    workspaceId,
    projectId,
    oidcAudience: audience,
    oidcRequestUrl: safeOidcRequestUrl(
      required(environment.ACTIONS_ID_TOKEN_REQUEST_URL, 'ACTIONS_ID_TOKEN_REQUEST_URL'),
    ),
    oidcRequestToken,
    github: { repository, commit, ref, refName: environmentRefName, workflowRef },
  };
}

const runGitHead: GitRunner = (directory, environment) =>
  new Promise((resolveResult, reject) => {
    const childEnvironment: NodeJS.ProcessEnv = {
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    };
    for (const name of [
      'PATH',
      'HOME',
      'TMPDIR',
      'SystemRoot',
      'ComSpec',
      'PATHEXT',
      'XDG_CONFIG_HOME',
    ]) {
      if (environment[name]) childEnvironment[name] = environment[name];
    }
    const child = spawn('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: directory,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new CliError('Git checkout attestation timed out.')));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4_096) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_096);
    });
    child.once('error', (error) =>
      finish(() => reject(new CliError(`Could not attest Git checkout HEAD: ${error.message}`))),
    );
    child.once('close', (code) => finish(() => resolveResult({ code: code ?? 1, stdout, stderr })));
  });

export async function assertHostedGitHead(
  config: LoadedConfig,
  settings: HostedUploadSettings,
  environment: NodeJS.ProcessEnv,
  runner: GitRunner = runGitHead,
): Promise<void> {
  const result = await runner(config.directory, environment);
  const head = result.stdout.trim();
  if (result.code !== 0 || !/^[a-f0-9]{40,64}$/u.test(head)) {
    throw new CliError(
      `Hosted upload requires an attested Git checkout HEAD: ${result.stderr.trim() || 'git rev-parse failed'}`,
    );
  }
  if (head !== settings.github.commit) {
    throw new CliError(
      `Git checkout HEAD ${head} does not match signed GitHub commit ${settings.github.commit}.`,
    );
  }
}

function safeRelativePath(value: string): string {
  if (
    !value ||
    value.length > 2_000 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new CliError(`Hosted evidence path is unsafe: ${value}`);
  }
  return value;
}

async function readSafeFile(root: string, path: string, maximumBytes: number): Promise<Uint8Array> {
  const relativePath = safeRelativePath(path);
  try {
    return (
      await readBoundedRegularFile(root, relativePath, {
        maximumBytes,
        minimumBytes: 1,
      })
    ).bytes;
  } catch (error) {
    if (error instanceof SafeFileReadError) {
      throw new CliError(`Hosted evidence file is unsafe (${error.reason}): ${relativePath}`);
    }
    throw error;
  }
}

function parseJson<T>(bytes: Uint8Array, path: string, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch (error) {
    throw new CliError(
      `Hosted evidence JSON is invalid at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function localBaseline(config: LoadedConfig, run: RunArtifact) {
  const root = resolve(config.directory, config.config.paths.baselines);
  const reference = join(run.sceneId, `${run.runTargetId}.json`);
  try {
    const value = await readBoundedRegularFile(root, reference, {
      maximumBytes: MAX_JSON_BYTES,
      minimumBytes: 1,
    });
    return parseJson(value.bytes, value.path, (input) => BaselineSchema.parse(input));
  } catch (error) {
    if (error instanceof SafeFileReadError && error.reason === 'missing') return undefined;
    if (error instanceof SafeFileReadError) {
      throw new CliError(`Hosted Baseline is unsafe (${error.reason}): ${reference}`);
    }
    throw error;
  }
}

function assertRepository(
  repository: BuildArtifact['repository'],
  github: GitHubProvenance,
  label: string,
): void {
  if (
    repository.provider !== 'github' ||
    repository.repository !== github.repository ||
    repository.commit !== github.commit ||
    repository.ref !== github.ref ||
    repository.branch !== github.refName ||
    repository.dirty !== false
  ) {
    throw new CliError(
      `${label} repository, commit, ref, or dirty state does not match the GitHub Actions provenance.`,
    );
  }
}

function withoutPrivacy(run: RunArtifact): unknown {
  const { privacy: _runPrivacy, ...root } = run;
  return {
    ...root,
    attempts: run.attempts.map((attempt) => {
      const { privacy: _attemptPrivacy, ...attemptRoot } = attempt;
      return {
        ...attemptRoot,
        states: attempt.states.map((state) => {
          const { privacy: _statePrivacy, ...stateRoot } = state;
          return stateRoot;
        }),
      };
    }),
  };
}

function privacySummary(result: PrivacyScanResult, provider: OcrProvider): PrivacySummary {
  return PrivacySummarySchema.parse({
    status: result.status,
    scannedAt: result.scannedAt,
    scannerVersion: `hosted:${PRIVACY_SCANNER_VERSION}:${provider.id}:${sha256(`${provider.id}\u0000${provider.version}`).slice(0, 16)}`,
    counts: result.counts,
    findings: result.findings,
  });
}

function requireClear(result: PrivacyScanResult, label: string): void {
  if (result.status !== 'clear') {
    throw new CliError(
      `${label} privacy is ${result.status}; hosted upload requires zero unresolved structured or OCR findings.`,
    );
  }
}

function mediaTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot < 0 ? '' : path.slice(dot).toLowerCase();
  const types: Readonly<Record<string, string>> = {
    '.avif': 'image/avif',
    '.css': 'text/css',
    '.gif': 'image/gif',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.mdx': 'text/mdx',
    '.mjs': 'text/javascript',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.zip': 'application/zip',
  };
  const type = types[extension];
  if (!type) throw new CliError(`Hosted upload does not recognize the media type for ${path}.`);
  return type;
}

function uploadBytes(path: string, bytes: Uint8Array, mediaType: string): UploadObject {
  return {
    path: safeRelativePath(path),
    spec: { sha256: sha256(bytes), byteLength: bytes.byteLength, mediaType },
    source: { kind: 'bytes', bytes },
  };
}

function envelopeObject(path: string, value: unknown): UploadObject {
  const bytes = Buffer.from(`${stableStringify(value)}\n`);
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new CliError(`Hosted JSON object exceeds ${MAX_JSON_BYTES} bytes: ${path}`);
  }
  return uploadBytes(path, bytes, 'application/json');
}

function addObject(objects: Map<string, UploadObject>, object: UploadObject): void {
  const key = `${object.spec.sha256}\u0000${object.spec.mediaType}`;
  const existing = objects.get(key);
  if (existing && existing.spec.byteLength !== object.spec.byteLength) {
    throw new CliError(`Hosted object identity collision for ${object.path}.`);
  }
  if (!existing) objects.set(key, object);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deterministicZipTime(): Date {
  // fflate writes DOS calendar fields with local Date getters. Constructing the
  // same local wall-clock date makes bytes stable across runner timezones.
  return new Date(1980, 0, 1, 0, 0, 0, 0);
}

async function publicationFiles(
  directory: string,
  parent = '',
  paths: string[] = [],
): Promise<string[]> {
  const current = resolve(directory, parent);
  const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
    compareStrings(left.name, right.name),
  );
  for (const entry of entries) {
    const path = safeRelativePath(parent ? `${parent}/${entry.name}` : entry.name);
    if (entry.isSymbolicLink()) {
      throw new CliError(`Compiled publication must not contain symbolic links: ${path}`);
    }
    if (entry.isDirectory()) await publicationFiles(directory, path, paths);
    else if (entry.isFile()) {
      paths.push(path);
      if (paths.length > MAX_PUBLICATION_FILES) {
        throw new CliError(
          `Compiled publication exceeds the ${MAX_PUBLICATION_FILES}-file hosted limit.`,
        );
      }
    } else throw new CliError(`Compiled publication contains an unsupported file type: ${path}`);
  }
  return paths;
}

interface PublicationFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

interface PreparedScreenshot {
  readonly sourcePath: string;
  readonly stagedPath: string;
  readonly spec: ObjectSpec;
}

function objectIdentity(spec: Pick<ObjectSpec, 'sha256' | 'mediaType'>): string {
  return `${spec.sha256}\u0000${spec.mediaType}`;
}

function validateCompiledManifest(
  manifest: unknown,
  formats: unknown,
  files: readonly PublicationFile[],
): void {
  const typedManifest = CompilerPublicationManifestSchema.safeParse(manifest);
  if (!typedManifest.success) {
    throw new CliError('Compiled publication manifest does not match the hosted release schema.');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new CliError('Compiled publication manifest is invalid.');
  }
  if (!formats || typeof formats !== 'object' || Array.isArray(formats)) {
    throw new CliError('Compiled publication formats.json is invalid.');
  }
  const formatValue = formats as Record<string, unknown>;
  if (
    !Array.isArray(formatValue.selected) ||
    formatValue.selected.length === 0 ||
    !formatValue.selected.every(
      (format) => typeof format === 'string' && format in FORMAT_POLICY,
    ) ||
    new Set(formatValue.selected).size !== formatValue.selected.length ||
    stableStringify(formatValue.policy) !== stableStringify(FORMAT_POLICY)
  ) {
    throw new CliError('Compiled publication format policy does not match this compiler.');
  }
  const selectedFormats = new Set(formatValue.selected as string[]);
  const value = manifest as Record<string, unknown>;
  if (
    value.format !== 'scenebook-catalog' ||
    value.version !== 1 ||
    !(value.privacy && typeof value.privacy === 'object') ||
    (value.privacy as { status?: unknown }).status !== 'passed'
  ) {
    throw new CliError(
      'Hosted upload requires a version 1 compiled publication with passed privacy and no override.',
    );
  }
  const assets = value.assets;
  if (!Array.isArray(assets))
    throw new CliError('Compiled publication manifest assets are invalid.');
  const byPath = new Map(files.map((file) => [file.path, file]));
  const ownedPaths = new Set(['manifest.json', 'formats.json']);
  const declaredPaths = new Set<string>();
  const declaredAssetHashes = new Set<string>();
  const declaredAssetMediaTypes = new Map<string, string>();
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') throw new CliError('Publication asset is invalid.');
    const declared = asset as Record<string, unknown>;
    const path = typeof declared.path === 'string' ? safeRelativePath(declared.path) : '';
    const file = byPath.get(path);
    const hash = typeof declared.hash === 'string' ? declared.hash : '';
    const mediaType = typeof declared.mediaType === 'string' ? declared.mediaType : '';
    // Compiler Scene asset references are digest-only. Preserve that unambiguous
    // contract by requiring one canonical media type and path for each digest.
    const canonicalMediaType = declaredAssetMediaTypes.get(hash);
    if (canonicalMediaType && canonicalMediaType !== mediaType) {
      throw new CliError(
        `Compiled publication asset ${hash} has conflicting canonical media types.`,
      );
    }
    if (
      !file ||
      declaredPaths.has(path) ||
      !hash ||
      declaredAssetHashes.has(hash) ||
      hash !== file.sha256 ||
      declared.bytes !== file.byteLength ||
      mediaType !== file.mediaType
    ) {
      throw new CliError(`Compiled publication asset does not match its bytes: ${String(path)}`);
    }
    declaredPaths.add(path);
    declaredAssetHashes.add(hash);
    declaredAssetMediaTypes.set(hash, mediaType);
    ownedPaths.add(path);
  }
  const scenes = value.scenes;
  if (!Array.isArray(scenes)) throw new CliError('Compiled publication Scene manifest is invalid.');
  const sceneIds = new Set<string>();
  const sceneSlugs = new Set<string>();
  for (const scene of scenes) {
    if (!scene || typeof scene !== 'object') throw new CliError('Compiled Scene entry is invalid.');
    const entry = scene as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      typeof entry.slug !== 'string' ||
      sceneIds.has(entry.id) ||
      sceneSlugs.has(entry.slug)
    ) {
      throw new CliError('Compiled Scene IDs and slugs must be unique.');
    }
    sceneIds.add(entry.id);
    sceneSlugs.add(entry.slug);
    if (
      !Array.isArray(entry.assets) ||
      !entry.assets.every((hash) => typeof hash === 'string' && declaredAssetHashes.has(hash)) ||
      new Set(entry.assets).size !== entry.assets.length
    ) {
      throw new CliError('Compiled Scene asset references are invalid.');
    }
    const references: unknown[] = [entry.evidence];
    if (entry.outputs && typeof entry.outputs === 'object' && !Array.isArray(entry.outputs)) {
      const outputEntries = Object.entries(entry.outputs);
      const outputFormats = outputEntries.map(([format]) => format).sort(compareStrings);
      if (
        stableStringify(outputFormats) !==
        stableStringify([...selectedFormats].sort(compareStrings))
      ) {
        throw new CliError('Compiled Scene outputs do not match formats.json.');
      }
      for (const [format, outputs] of outputEntries) {
        if (!(format in FORMAT_POLICY) || !Array.isArray(outputs) || outputs.length === 0) {
          throw new CliError('Compiled Scene outputs are invalid.');
        }
        references.push(...outputs);
      }
    } else throw new CliError('Compiled Scene outputs are invalid.');
    for (const reference of references) {
      const path = typeof reference === 'string' ? safeRelativePath(reference) : '';
      if (!path || !byPath.has(path) || ownedPaths.has(path)) {
        throw new CliError(`Compiled Scene references a missing output: ${String(reference)}`);
      }
      ownedPaths.add(path);
    }
  }
  if (selectedFormats.has('catalog')) {
    if (!byPath.has('index.html')) {
      throw new CliError('Compiled catalog is missing its global index.html.');
    }
    ownedPaths.add('index.html');
  }
  const unexpected = files.find((file) => !ownedPaths.has(file.path));
  if (unexpected) {
    throw new CliError(
      `Compiled publication contains a file not owned by its manifest: ${unexpected.path}`,
    );
  }
  const missing = [...ownedPaths].find((path) => !byPath.has(path));
  if (missing) throw new CliError(`Compiled publication is missing declared file: ${missing}`);
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new CliError('Unable to write the deterministic publication archive.');
    offset += written;
  }
}

async function compiledPublicationArchive(
  directory: string,
  stagingDirectory: string,
): Promise<{
  readonly objects: readonly UploadObject[];
  readonly files: readonly PublicationFile[];
  readonly archive: ObjectSpec;
  readonly inventory: ObjectSpec;
  readonly compilerManifest: ObjectSpec;
  readonly treeHash: string;
  readonly byteLength: number;
  readonly inventoryDocument: PublicationInventory;
}> {
  // Recursive traversal order is not globally lexical when a directory and a
  // sibling filename share a prefix (for example, components/ and
  // components.js). Sort the complete path set before hashing and archiving.
  const paths = (await publicationFiles(directory)).sort(compareStrings);
  if (!paths.includes('manifest.json') || !paths.includes('formats.json')) {
    throw new CliError('Compiled publication manifest.json or formats.json is missing.');
  }
  const archivePath = resolve(stagingDirectory, 'publication.zip');
  const archiveFile = await open(archivePath, 'wx', 0o600);
  const archiveDigest = createHash('sha256');
  const files: PublicationFile[] = [];
  let manifestBytes: Uint8Array | undefined;
  let formatsBytes: Uint8Array | undefined;
  let archiveBytes = 0;
  let sourceBytes = 0;
  let archiveError: unknown;
  let archiveFinal = false;
  const archive = new Zip((error, bytes, final) => {
    if (archiveError) return;
    if (error) {
      archiveError = error;
      return;
    }
    try {
      if (archiveBytes + bytes.byteLength > MAX_OBJECT_BYTES) {
        throw new CliError(`Deterministic publication archive exceeds ${MAX_OBJECT_BYTES} bytes.`);
      }
      writeAll(archiveFile.fd, bytes);
      archiveDigest.update(bytes);
      archiveBytes += bytes.byteLength;
      archiveFinal = final;
    } catch (caught) {
      archiveError = caught;
    }
  });
  try {
    for (const path of paths) {
      const bytes = await readSafeFile(directory, path, MAX_OBJECT_BYTES);
      sourceBytes += bytes.byteLength;
      if (sourceBytes > MAX_UPLOAD_BYTES) {
        throw new CliError(`Compiled publication exceeds ${MAX_UPLOAD_BYTES} bytes.`);
      }
      const mediaType = mediaTypeForPath(path);
      files.push({ path, sha256: sha256(bytes), byteLength: bytes.byteLength, mediaType });
      if (path === 'manifest.json') manifestBytes = bytes;
      if (path === 'formats.json') formatsBytes = bytes;
      const entry = new ZipDeflate(path, { level: 9 });
      entry.mtime = deterministicZipTime();
      entry.os = 3;
      entry.attrs = DETERMINISTIC_ZIP_ATTRIBUTES;
      archive.add(entry);
      entry.push(bytes, true);
      if (archiveError) throw archiveError;
    }
    archive.end();
    if (archiveError) throw archiveError;
    if (!archiveFinal || archiveBytes <= 0) {
      throw new CliError('Deterministic publication archive did not finish.');
    }
  } catch (error) {
    archive.terminate();
    throw error;
  } finally {
    await archiveFile.close();
  }
  if (!manifestBytes || !formatsBytes) {
    throw new CliError('Compiled publication manifest.json or formats.json is missing.');
  }
  validateCompiledManifest(
    parseJson(manifestBytes, 'manifest.json', (value) => value),
    parseJson(formatsBytes, 'formats.json', (value) => value),
    files,
  );
  const archiveSpec: ObjectSpec = {
    sha256: archiveDigest.digest('hex'),
    byteLength: archiveBytes,
    mediaType: 'application/zip',
  };
  const treeHash = canonicalJsonHash({ files });
  const compilerManifest = files.find((file) => file.path === 'manifest.json');
  if (!compilerManifest) throw new CliError('Compiled publication manifest metadata is missing.');
  const inventory = PublicationInventorySchema.parse({
    format: 'scenebook-publication-archive',
    version: 1,
    archive: archiveSpec,
    treeHash,
    byteLength: sourceBytes,
    compilerManifest,
    files,
  });
  const inventoryObject = envelopeObject('publication/inventory.json', inventory);
  const compilerManifestObject = uploadBytes(
    'publication/compiler-manifest.json',
    manifestBytes,
    'application/json',
  );
  if (
    compilerManifestObject.spec.sha256 !== compilerManifest.sha256 ||
    compilerManifestObject.spec.byteLength !== compilerManifest.byteLength
  ) {
    throw new CliError('Standalone compiler manifest does not match the publication inventory.');
  }
  const archiveObject: UploadObject = {
    path: 'publication/scenebook-publication.zip',
    spec: archiveSpec,
    source: { kind: 'file', path: archivePath },
  };
  return {
    objects: [archiveObject, inventoryObject, compilerManifestObject],
    files,
    archive: archiveSpec,
    inventory: inventoryObject.spec,
    compilerManifest: compilerManifestObject.spec,
    treeHash,
    byteLength: sourceBytes,
    inventoryDocument: inventory,
  };
}

export async function createCompiledPublicationArchive(
  directory: string,
  stagingDirectory: string,
): Promise<CompiledPublicationArchive> {
  const archived = await compiledPublicationArchive(directory, stagingDirectory);
  return {
    archivePath: resolve(stagingDirectory, 'publication.zip'),
    files: archived.files,
    inventory: archived.inventoryDocument,
    publication: ReleasePublicationSchema.parse({
      archive: archived.archive,
      inventory: archived.inventory,
      compilerManifest: archived.compilerManifest,
      treeHash: archived.treeHash,
    }),
    byteLength: archived.byteLength,
  };
}

async function prepareHostedEvidence(options: {
  readonly config: LoadedConfig;
  readonly settings: HostedUploadSettings;
  readonly buildPath: string;
  readonly build: BuildArtifact;
  readonly publicationDirectory: string;
  readonly provider: OcrProvider;
  readonly stagingDirectory: string;
}): Promise<PreparedHostedEvidence> {
  const { config, settings, provider } = options;
  let build = BuildArtifactSchema.parse(options.build);
  if (
    build.projectId !== settings.projectId ||
    build.completeness !== 'complete' ||
    build.shard ||
    !build.endedAt ||
    build.status === 'pending' ||
    build.status === 'running' ||
    build.status === 'cancelled'
  ) {
    throw new CliError(
      'Hosted upload requires one finalized complete Build for the configured Project.',
    );
  }
  assertRepository(build.repository, settings.github, 'Build');
  if (
    build.summary.total === 0 ||
    build.summary.broken !== 0 ||
    build.summary.blocked !== 0 ||
    build.summary.pending !== 0
  ) {
    throw new CliError(
      'Hosted upload requires functionally passed evidence with no broken, privacy-blocked, or pending Scene.',
    );
  }
  const runsRoot = dirname(options.buildPath);
  const loadedRuns: Array<{
    run: RunArtifact;
    scene: Scene;
    stateAssets: Map<string, PreparedScreenshot>;
  }> = [];
  const uniqueAssets = new Map<string, PreparedScreenshot>();
  const assetStagingDirectory = resolve(options.stagingDirectory, 'assets');
  await mkdir(assetStagingDirectory, { recursive: true, mode: 0o700 });
  for (const reference of build.runs) {
    if (
      !reference.run ||
      reference.status !== 'passed' ||
      (reference.changeState !== 'passed' && reference.changeState !== 'changed')
    ) {
      throw new CliError(
        `Hosted upload requires functionally passed, privacy-safe evidence for ${reference.sceneId}.`,
      );
    }
    const runPath = safeRelativePath(reference.run.path ?? `runs/${reference.run.id}.json`);
    const runBytes = await readSafeFile(runsRoot, runPath, MAX_JSON_BYTES);
    const run = parseJson(runBytes, runPath, (value) => RunArtifactSchema.parse(value));
    if (artifactHash(run) !== reference.run.sha256) {
      throw new CliError(`Run ${run.id} does not match the Build artifact hash.`);
    }
    if (
      run.projectId !== settings.projectId ||
      run.sceneId !== reference.sceneId ||
      run.runTargetId !== reference.runTargetId ||
      run.status !== reference.status ||
      run.changeState !== reference.changeState
    ) {
      throw new CliError(`Run ${run.id} does not match its passed Build plan.`);
    }
    assertRepository(run.repository, settings.github, `Run ${run.id}`);
    const selected = run.attempts.find((attempt) => attempt.id === run.selectedAttemptId);
    if (!selected || selected.status !== run.status) {
      throw new CliError(`Run ${run.id} selected attempt contradicts its execution status.`);
    }
    if (run.attempts.some((attempt) => attempt.attachments.length > 0 || attempt.trace)) {
      throw new CliError(
        `Run ${run.id} contains attachments or traces without a hosted privacy scanner.`,
      );
    }
    const scenePath = `scenes/${run.sceneId}/${run.sourceRevision}.json`;
    const sceneBytes = await readSafeFile(runsRoot, scenePath, MAX_JSON_BYTES);
    const scene = parseJson(sceneBytes, scenePath, (value) => SceneSchema.parse(value));
    if (sceneSourceRevision(scene) !== run.sourceRevision || scene.id !== run.sceneId) {
      throw new CliError(`Run ${run.id} Scene revision does not match its evidence.`);
    }
    const stateAssets = new Map<string, PreparedScreenshot>();
    for (const attempt of run.attempts) {
      for (const state of attempt.states) {
        const asset = state.screenshot;
        if (!['image/png', 'image/jpeg'].includes(asset.mediaType)) {
          throw new CliError(
            `Hosted OCR currently requires PNG or JPEG Run screenshots: ${asset.path}`,
          );
        }
        const bytes = await readSafeFile(runsRoot, asset.path, MAX_OBJECT_BYTES);
        if (sha256(bytes) !== asset.sha256 || bytes.byteLength !== asset.byteLength) {
          throw new CliError(`Run screenshot does not match its content address: ${asset.path}`);
        }
        const spec = {
          sha256: asset.sha256,
          byteLength: asset.byteLength,
          mediaType: asset.mediaType,
        };
        const key = objectIdentity(spec);
        let prepared = uniqueAssets.get(key);
        if (!prepared) {
          const extension = asset.mediaType === 'image/png' ? 'png' : 'jpg';
          const stagedPath = resolve(assetStagingDirectory, `${asset.sha256}.${extension}`);
          await writeFile(stagedPath, bytes, { flag: 'wx', mode: 0o600 });
          prepared = { sourcePath: asset.path, stagedPath, spec };
          uniqueAssets.set(key, prepared);
        } else if (prepared.spec.byteLength !== asset.byteLength) {
          throw new CliError(`Run screenshot identity collision: ${asset.path}`);
        }
        stateAssets.set(key, prepared);
      }
    }
    loadedRuns.push({ run, scene, stateAssets });
  }

  const scanOptions = projectPrivacyScanOptions(config);
  const scanNow = () => new Date(build.endedAt!);
  const assetScans = new Map<string, PrivacyScanResult>();
  for (const [key, asset] of [...uniqueAssets].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    let before: Uint8Array;
    try {
      before = (
        await readBoundedRegularFileAtPath(asset.stagedPath, {
          maximumBytes: asset.spec.byteLength,
          minimumBytes: asset.spec.byteLength,
        })
      ).bytes;
    } catch (error) {
      if (error instanceof SafeFileReadError) {
        throw new CliError(`Staged OCR input changed before scanning: ${asset.sourcePath}`);
      }
      throw error;
    }
    if (sha256(before) !== asset.spec.sha256 || before.byteLength !== asset.spec.byteLength) {
      throw new CliError(`Staged OCR input changed before scanning: ${asset.sourcePath}`);
    }
    const segments = await provider.scan({
      path: asset.stagedPath,
      assetHash: asset.spec.sha256,
    });
    let after: Uint8Array;
    try {
      after = (
        await readBoundedRegularFileAtPath(asset.stagedPath, {
          maximumBytes: asset.spec.byteLength,
          minimumBytes: asset.spec.byteLength,
        })
      ).bytes;
    } catch (error) {
      if (error instanceof SafeFileReadError) {
        throw new CliError(`OCR provider ${provider.id} changed its immutable staged input.`);
      }
      throw error;
    }
    if (sha256(after) !== asset.spec.sha256 || after.byteLength !== asset.spec.byteLength) {
      throw new CliError(`OCR provider ${provider.id} changed its immutable staged input.`);
    }
    if (segments.some((segment) => segment.assetHash !== asset.spec.sha256)) {
      throw new CliError(`OCR provider ${provider.id} returned evidence for the wrong asset.`);
    }
    const result = scanOcrSegments(segments, { ...scanOptions, now: scanNow });
    requireClear(result, `Run screenshot ${asset.spec.sha256}`);
    assetScans.set(key, result);
  }

  const sceneRequests = new Map<string, SceneRequest>();
  const runRequests: RunRequest[] = [];
  const reviewRequests: ReviewRequest[] = [];
  for (const loaded of loadedRuns) {
    const structuredRun = scanStructuredValue(withoutPrivacy(loaded.run), {
      ...scanOptions,
      path: `$run/${loaded.run.id}`,
      now: scanNow,
    });
    requireClear(structuredRun, `Run ${loaded.run.id}`);
    const stateResults = [...loaded.stateAssets.keys()].map((key) => assetScans.get(key)!);
    const runPrivacy = combinePrivacyScanResults([structuredRun, ...stateResults], {
      ...scanOptions,
      now: scanNow,
    });
    requireClear(runPrivacy, `Run ${loaded.run.id}`);
    const summary = privacySummary(runPrivacy, provider);
    let run = RunArtifactSchema.parse({
      ...loaded.run,
      privacy: summary,
      attempts: loaded.run.attempts.map((attempt) => {
        const states = attempt.states.map((state) => {
          const { privacy: _statePrivacy, ...stateWithoutPrivacy } = state;
          const stateResult = combinePrivacyScanResults(
            [
              scanStructuredValue(stateWithoutPrivacy, {
                ...scanOptions,
                path: `$state/${state.id}`,
                now: scanNow,
              }),
              assetScans.get(
                objectIdentity({
                  sha256: state.screenshot.sha256,
                  mediaType: state.screenshot.mediaType,
                }),
              )!,
            ],
            { ...scanOptions, now: scanNow },
          );
          requireClear(stateResult, `Run State ${state.id}`);
          return { ...state, privacy: privacySummary(stateResult, provider) };
        });
        const { privacy: _attemptPrivacy, ...attemptWithoutPrivacy } = attempt;
        const attemptResult = combinePrivacyScanResults(
          [
            scanStructuredValue(
              {
                ...attemptWithoutPrivacy,
                states: states.map(({ privacy: _statePrivacy, ...state }) => state),
              },
              { ...scanOptions, path: `$attempt/${attempt.id}`, now: scanNow },
            ),
            ...attempt.states.map((state) =>
              assetScans.get(
                objectIdentity({
                  sha256: state.screenshot.sha256,
                  mediaType: state.screenshot.mediaType,
                }),
              )!,
            ),
          ],
          { ...scanOptions, now: scanNow },
        );
        requireClear(attemptResult, `Run Attempt ${attempt.id}`);
        return { ...attempt, states, privacy: privacySummary(attemptResult, provider) };
      }),
    });
    const reviewed = reviewRunEvidence(run, await localBaseline(config, run));
    run = reviewed.run;
    runRequests.push({ run });
    reviewRequests.push({ review: ReviewSchema.parse(reviewed.review) });
    const sceneScan = combinePrivacyScanResults(
      [scanScenePrivacy(loaded.scene, { ...scanOptions, now: scanNow }), ...stateResults],
      { ...scanOptions, now: scanNow },
    );
    requireClear(sceneScan, `Scene ${loaded.scene.id}`);
    sceneRequests.set(`${loaded.scene.id}\u0000${run.sourceRevision}`, {
      scene: loaded.scene,
      privacy: privacySummary(sceneScan, provider),
    });
  }
  build = rebuildBuildEvidence(
    build,
    runRequests.map((request) => request.run),
  );
  const structuredBuild = scanStructuredValue(build, {
    ...scanOptions,
    path: `$build/${build.id}`,
    now: scanNow,
  });
  requireClear(structuredBuild, `Build ${build.id}`);

  const publication = await compiledPublicationArchive(
    options.publicationDirectory,
    options.stagingDirectory,
  );
  const objectMap = new Map<string, UploadObject>();
  const objectFiles: PreparedHostedEvidence['objectFiles'][number][] = [];
  const add = (object: UploadObject): void => {
    addObject(objectMap, object);
    objectFiles.push({ path: object.path, ...object.spec });
  };
  for (const object of publication.objects) add(object);
  for (const asset of uniqueAssets.values()) {
    add({
      path: `evidence/assets/${asset.spec.sha256}${asset.spec.mediaType === 'image/png' ? '.png' : '.jpg'}`,
      spec: asset.spec,
      source: { kind: 'file', path: asset.stagedPath },
    });
  }
  for (const request of sceneRequests.values()) {
    add(
      envelopeObject(
        `evidence/requests/scenes/${request.scene.id}/${sceneSourceRevision(request.scene)}.json`,
        request,
      ),
    );
  }
  for (const request of runRequests) {
    add(envelopeObject(`evidence/requests/runs/${request.run.id}.json`, request));
  }
  for (const request of reviewRequests) {
    add(envelopeObject(`evidence/requests/reviews/${request.review.id}.json`, request));
  }
  const buildRequest = { build };
  add(envelopeObject(`evidence/requests/builds/${build.id}.json`, buildRequest));
  const objects = [...objectMap.values()].sort(
    (left, right) =>
      compareStrings(left.spec.sha256, right.spec.sha256) ||
      compareStrings(left.spec.mediaType, right.spec.mediaType),
  );
  const totalBytes = objects.reduce((total, object) => total + object.spec.byteLength, 0);
  if (objects.length > MAX_OBJECTS || totalBytes > MAX_UPLOAD_BYTES) {
    throw new CliError('Hosted evidence exceeds the default server upload capacity.');
  }
  return {
    build,
    scenes: [...sceneRequests.values()],
    runs: runRequests,
    reviews: reviewRequests,
    buildRequest,
    objects,
    objectFiles: objectFiles.sort((left, right) => compareStrings(left.path, right.path)),
    publication: {
      ...ReleasePublicationSchema.parse({
        archive: publication.archive,
        inventory: publication.inventory,
        compilerManifest: publication.compilerManifest,
        treeHash: publication.treeHash,
      }),
      fileCount: publication.files.length,
      byteLength: publication.byteLength,
    },
  };
}

function apiUrl(settings: HostedUploadSettings, path: string): string {
  return new URL(path.replace(/^\//u, ''), settings.serverUrl).href;
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(`Hosted ${operation} returned an oversized response.`);
    }
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new CliError(`Hosted ${operation} returned an oversized response.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks, byteLength).toString('utf8');
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = {};
  }
  if (!response.ok) {
    const error = (value as { error?: { code?: unknown; message?: unknown } }).error;
    const code = typeof error?.code === 'string' ? error.code : `http_${response.status}`;
    const message =
      typeof error?.message === 'string' ? error.message.slice(0, 4_000) : 'request failed';
    throw new CliError(`Hosted ${operation} failed (${code}): ${message}`);
  }
  return value;
}

async function request(
  fetchImpl: Fetch,
  url: string,
  operation: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new CliError(
      `Hosted ${operation} could not reach the configured server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return responseJson(response, operation);
}

function jsonRequest(token: string, body: unknown, extra: HeadersInit = {}): RequestInit {
  const encoded = Buffer.from(`${stableStringify(body)}\n`);
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': String(encoded.byteLength),
      ...extra,
    },
    body: encoded,
  };
}

function tokenPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1])
    throw new CliError('Hosted server returned a malformed token.');
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new CliError('Hosted server returned a malformed token payload.');
  }
}

function assertTokenClaims(token: string, settings: HostedUploadSettings): number {
  // This is structural/scope validation, not cryptographic JWT verification.
  // HTTPS supplies the trusted response; the server verifies the token again on every request.
  const payload = tokenPayload(token);
  const permissions = payload.permissions;
  const current = Math.floor(Date.now() / 1_000);
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const notBefore = payload.nbf;
  if (
    payload.iss !== 'scenebook' ||
    payload.aud !== 'scenebook-artifact-upload' ||
    payload.sub !== `${settings.github.repository}@${settings.github.commit}` ||
    typeof payload.jti !== 'string' ||
    payload.jti.length === 0 ||
    payload.workspace_id !== settings.workspaceId ||
    payload.project_id !== settings.projectId ||
    payload.repository !== settings.github.repository ||
    payload.commit !== settings.github.commit ||
    payload.ref !== settings.github.ref ||
    payload.workflow_ref !== settings.github.workflowRef ||
    !Array.isArray(permissions) ||
    permissions.length !== 1 ||
    permissions[0] !== 'artifact:write' ||
    !Number.isInteger(issuedAt) ||
    !Number.isInteger(expiresAt) ||
    (notBefore !== undefined && !Number.isInteger(notBefore)) ||
    (issuedAt as number) < current - 60 ||
    (issuedAt as number) > current + 5 ||
    (expiresAt as number) <= current ||
    (expiresAt as number) - (issuedAt as number) < 60 ||
    (expiresAt as number) - (issuedAt as number) > 900 ||
    (notBefore !== undefined &&
      ((notBefore as number) > current + 5 || (notBefore as number) < (issuedAt as number) - 5))
  ) {
    throw new CliError('Hosted upload token scope does not match the active GitHub provenance.');
  }
  return expiresAt as number;
}

async function exchangeOidc(
  fetchImpl: Fetch,
  settings: HostedUploadSettings,
): Promise<HostedAccessToken> {
  const oidcUrl = new URL(settings.oidcRequestUrl);
  oidcUrl.searchParams.set('audience', settings.oidcAudience);
  const oidc = await request(fetchImpl, oidcUrl.href, 'GitHub OIDC request', {
    method: 'GET',
    headers: { authorization: `Bearer ${settings.oidcRequestToken}` },
  });
  const assertion = (oidc as { value?: unknown }).value;
  if (
    typeof assertion !== 'string' ||
    assertion.length < 100 ||
    assertion.length > 200_000 ||
    /[\u0000-\u0020\u007f]/u.test(assertion)
  ) {
    throw new CliError('GitHub OIDC endpoint did not return an assertion.');
  }
  const exchanged = await request(
    fetchImpl,
    apiUrl(settings, 'v1/oidc/exchange'),
    'OIDC exchange',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `${stableStringify({
        workspaceId: settings.workspaceId,
        projectId: settings.projectId,
        oidcToken: assertion,
      })}\n`,
    },
  );
  const token = (exchanged as { token?: unknown }).token;
  if (typeof token !== 'string' || token.length > 20_000) {
    throw new CliError('Hosted server did not return a valid upload token.');
  }
  return { token, expiresAt: assertTokenClaims(token, settings) };
}

function hostedAccessToken(
  fetchImpl: Fetch,
  settings: HostedUploadSettings,
): () => Promise<string> {
  let active: HostedAccessToken | undefined;
  let refreshing: Promise<HostedAccessToken> | undefined;
  return async () => {
    const current = Math.floor(Date.now() / 1_000);
    if (active && active.expiresAt > current + 30) return active.token;
    if (!refreshing) refreshing = exchangeOidc(fetchImpl, settings);
    const pending = refreshing;
    try {
      active = await pending;
      return active.token;
    } finally {
      if (refreshing === pending) refreshing = undefined;
    }
  };
}

async function uploadHostedCiEvidenceFromStaging(options: {
  readonly config: LoadedConfig;
  readonly settings: HostedUploadSettings;
  readonly buildPath: string;
  readonly build: BuildArtifact;
  readonly publicationDirectory: string;
  readonly provider: OcrProvider;
  readonly stagingDirectory: string;
  readonly fetch?: Fetch;
}): Promise<HostedUploadResult> {
  const prepared = await prepareHostedEvidence(options);
  const fetchImpl = options.fetch ?? fetch;
  const accessToken = hostedAccessToken(fetchImpl, options.settings);
  const manifest = {
    schemaVersion: 1 as const,
    objects: prepared.objects.map((object) => object.spec),
    metadata: {
      kind: 'scenebook-ci-evidence',
      projectId: options.settings.projectId,
      buildId: prepared.build.id,
      repository: options.settings.github.repository,
      commit: options.settings.github.commit,
      ref: options.settings.github.ref,
      workflowRef: options.settings.github.workflowRef,
      objects: prepared.objectFiles,
      publication: prepared.publication,
    },
  };
  const manifestHash = canonicalJsonHash(manifest);
  const uploadKey = `ci:${prepared.build.id}:${manifestHash}`;
  const begun = await request(
    fetchImpl,
    apiUrl(options.settings, 'v1/uploads'),
    'upload creation',
    jsonRequest(
      await accessToken(),
      { objects: manifest.objects },
      { 'idempotency-key': uploadKey },
    ),
  );
  const upload = (
    begun as {
      upload?: { id?: unknown; status?: unknown; manifestHash?: unknown; objects?: unknown };
    }
  ).upload;
  if (!upload || typeof upload.id !== 'string' || !Array.isArray(upload.objects)) {
    throw new CliError('Hosted server returned an invalid upload session.');
  }
  if (upload.status === 'finalized') {
    if (upload.manifestHash !== manifestHash) {
      throw new CliError('Hosted idempotency key already finalized another manifest.');
    }
  } else {
    const remoteObjects = upload.objects as Array<{
      sha256?: unknown;
      mediaType?: unknown;
      status?: unknown;
    }>;
    for (const object of prepared.objects) {
      const remote = remoteObjects.find(
        (candidate) =>
          candidate.sha256 === object.spec.sha256 && candidate.mediaType === object.spec.mediaType,
      );
      if (!remote) throw new CliError(`Hosted upload omitted declared object ${object.path}.`);
      if (remote.status === 'finalized' || remote.status === 'staged') continue;
      await request(
        fetchImpl,
        apiUrl(options.settings, `v1/uploads/${upload.id}/objects/${object.spec.sha256}`),
        `object upload ${object.path}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            'content-type': object.spec.mediaType,
            'content-length': String(object.spec.byteLength),
          },
          body:
            object.source.kind === 'bytes'
              ? (object.source.bytes as unknown as BodyInit)
              : (createReadStream(object.source.path) as unknown as BodyInit),
          ...(object.source.kind === 'file' ? ({ duplex: 'half' } as RequestInit) : {}),
        } as RequestInit,
      );
    }
    const finalized = await request(
      fetchImpl,
      apiUrl(options.settings, `v1/uploads/${upload.id}/finalize`),
      'upload finalization',
      jsonRequest(await accessToken(), { manifest }),
    );
    if ((finalized as { manifestHash?: unknown }).manifestHash !== manifestHash) {
      throw new CliError('Hosted server finalized a different upload manifest.');
    }
  }
  const ingestionHeaders = { 'x-scenebook-upload-id': upload.id };
  for (const requestBody of prepared.scenes) {
    const digest = sha256(`${stableStringify(requestBody)}\n`);
    await request(
      fetchImpl,
      apiUrl(
        options.settings,
        `v1/admin/workspaces/${options.settings.workspaceId}/projects/${options.settings.projectId}/scenes/revisions`,
      ),
      `Scene ${requestBody.scene.id} ingestion`,
      jsonRequest(await accessToken(), requestBody, {
        ...ingestionHeaders,
        'idempotency-key': `ci-scene:${digest}`,
      }),
    );
  }
  for (const requestBody of prepared.runs) {
    const digest = sha256(`${stableStringify(requestBody)}\n`);
    await request(
      fetchImpl,
      apiUrl(
        options.settings,
        `v1/admin/workspaces/${options.settings.workspaceId}/projects/${options.settings.projectId}/evidence/runs`,
      ),
      `Run ${requestBody.run.id} ingestion`,
      jsonRequest(await accessToken(), requestBody, {
        ...ingestionHeaders,
        'idempotency-key': `ci-run:${digest}`,
      }),
    );
  }
  for (const requestBody of prepared.reviews) {
    const digest = sha256(`${stableStringify(requestBody)}\n`);
    await request(
      fetchImpl,
      apiUrl(
        options.settings,
        `v1/admin/workspaces/${options.settings.workspaceId}/projects/${options.settings.projectId}/reviews`,
      ),
      `Review ${requestBody.review.id} ingestion`,
      jsonRequest(await accessToken(), requestBody, {
        ...ingestionHeaders,
        'idempotency-key': `ci-review:${digest}`,
      }),
    );
  }
  const buildDigest = sha256(`${stableStringify(prepared.buildRequest)}\n`);
  await request(
    fetchImpl,
    apiUrl(
      options.settings,
      `v1/admin/workspaces/${options.settings.workspaceId}/projects/${options.settings.projectId}/evidence/builds`,
    ),
    `Build ${prepared.build.id} ingestion`,
    jsonRequest(await accessToken(), prepared.buildRequest, {
      ...ingestionHeaders,
      'idempotency-key': `ci-build:${buildDigest}`,
    }),
  );
  return {
    uploadId: upload.id,
    manifestHash,
    objectCount: prepared.objects.length,
    byteLength: prepared.objects.reduce((total, object) => total + object.spec.byteLength, 0),
    sceneCount: prepared.scenes.length,
    runCount: prepared.runs.length,
    reviewCount: prepared.reviews.length,
    publication: {
      archive: prepared.publication.archive,
      inventory: prepared.publication.inventory,
      compilerManifest: prepared.publication.compilerManifest,
      treeHash: prepared.publication.treeHash,
    },
  };
}

export async function uploadHostedCiEvidence(options: {
  readonly config: LoadedConfig;
  readonly settings: HostedUploadSettings;
  readonly buildPath: string;
  readonly build: BuildArtifact;
  readonly publicationDirectory: string;
  readonly provider: OcrProvider;
  readonly fetch?: Fetch;
}): Promise<HostedUploadResult> {
  const stagingRoot = resolve(options.config.directory, '.scenebook/staging');
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(join(stagingRoot, 'hosted-upload-'));
  try {
    return await uploadHostedCiEvidenceFromStaging({ ...options, stagingDirectory });
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
