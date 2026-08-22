import { createHash, createPrivateKey } from 'node:crypto';
import type { JsonObject, JsonValue } from '@scenebook/schema';

import { isJsonObject } from './json-document.js';

import { importPKCS8, SignJWT } from 'jose';
import { transformSync } from 'esbuild';
import { compileSync } from '@mdx-js/mdx';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { z } from 'zod';
import {
  JsonValueSchema,
  SceneSchema,
  SceneTranslationSchema,
  migrateSceneDocument,
  parseSceneYaml,
  parseYamlWithSchema,
} from '@scenebook/schema';

const SHA1 = /^[a-f0-9]{40}$/u;
const INSTALLATION_ID = /^[1-9][0-9]{0,19}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_GITHUB_SOURCE_BYTES = 512 * 1024;

export type GitHubPatchOperation =
  | {
      readonly kind: 'locator';
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: 'narrative';
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: 'presentation';
      readonly before: string;
      readonly after: string;
    };

export type GitHubCheckConclusion = 'success' | 'failure' | 'cancelled';

export interface GitHubCheckRunState {
  readonly externalId: string;
  readonly commitSha: string;
  readonly status: 'in_progress' | 'completed';
  readonly conclusion?: GitHubCheckConclusion;
  readonly title: string;
  readonly summary: string;
  readonly detailsUrl: string;
}

export interface GitHubCheckRunResult {
  readonly id: number;
  readonly commitSha: string;
  readonly status: 'in_progress' | 'completed';
  readonly conclusion?: GitHubCheckConclusion;
  readonly url?: string;
}

export interface GitHubSourceBindingInfo {
  readonly repositoryId: string;
  readonly repository: string;
  readonly defaultBranch: string;
}

export interface GitHubSourceFile {
  readonly commitSha: string;
  readonly blobSha: string;
  readonly byteLength: number;
  readonly content: string;
}

export interface GitHubChangeEvidenceBinding {
  readonly runId?: string;
  readonly runArtifactHash?: string;
  readonly buildId?: string;
  readonly buildArtifactHash?: string;
  readonly reviewId?: string;
  readonly reviewHash?: string;
}

export interface GitHubAppliedChange {
  readonly baseCommitSha: string;
  readonly baseBlobSha: string;
  readonly headCommitSha: string;
  readonly headBlobSha: string;
  readonly branch: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly issueNumber?: number;
  readonly issueUrl?: string;
}

export interface GitHubSourceClient {
  inspectInstallation(input: {
    installationId: string;
    repository: string;
  }): Promise<GitHubSourceBindingInfo>;
  readSource(input: {
    installationId: string;
    repository: string;
    commitSha: string;
    path: string;
  }): Promise<GitHubSourceFile>;
  applyChange(input: {
    changeId: string;
    installationId: string;
    repository: string;
    defaultBranch: string;
    baseCommitSha: string;
    expectedBlobSha: string;
    path: string;
    operations: readonly GitHubPatchOperation[];
    title: string;
    createReviewIssue: boolean;
    evidence?: GitHubChangeEvidenceBinding;
    signal?: AbortSignal;
    assertLease?: () => Promise<void>;
  }): Promise<GitHubAppliedChange>;
  ensureCheckRun(input: {
    installationId: string;
    repository: string;
    state: GitHubCheckRunState;
    signal?: AbortSignal;
  }): Promise<GitHubCheckRunResult>;
}

export class GitHubSourceError extends Error {
  constructor(
    readonly code:
      | 'github_app_disabled'
      | 'github_auth_failed'
      | 'github_not_found'
      | 'github_rate_limited'
      | 'github_unavailable'
      | 'github_invalid_response'
      | 'github_repository_mismatch'
      | 'github_commit_mismatch'
      | 'github_blob_mismatch'
      | 'github_branch_collision'
      | 'github_patch_conflict'
      | 'github_source_too_large'
      | 'github_lease_lost',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'GitHubSourceError';
  }
}

function githubAbortError(signal: AbortSignal): GitHubSourceError {
  return signal.reason instanceof GitHubSourceError
    ? signal.reason
    : new GitHubSourceError('github_lease_lost', 'GitHub operation ownership was lost');
}

export type GitHubSourceKind =
  | 'scene-yaml'
  | 'scene-json'
  | 'narrative-mdx'
  | 'theme-yaml'
  | 'locale-yaml'
  | 'replay-typescript';

export function classifySafeGitHubSourcePath(path: string): GitHubSourceKind {
  if (
    path.length < 1 ||
    path.length > 512 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Source path is not a safe repository path',
    );
  }
  const segments = path.split('/');
  if (
    segments.length > 32 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 120 ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git',
    )
  ) {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Source path is not a safe repository path',
    );
  }
  const lower = segments.map((segment) => segment.toLowerCase());
  const scenesIndex = lower.lastIndexOf('scenes');
  const tail = scenesIndex < 0 ? [] : lower.slice(scenesIndex + 1);
  const filename = tail.at(-1);
  const parent = tail.at(-2);
  if (tail.length >= 2 && !lower.includes('assets')) {
    if (filename === 'scene.yaml' || filename === 'scene.yml') return 'scene-yaml';
    if (filename === 'scene.json') return 'scene-json';
    if (filename === 'narrative.mdx') return 'narrative-mdx';
    if (filename === 'theme.yaml' || filename === 'theme.yml') return 'theme-yaml';
    if (
      tail.length >= 3 &&
      parent === 'locales' &&
      filename !== undefined &&
      /^[a-z0-9][a-z0-9-]{0,34}\.(?:yaml|yml)$/iu.test(filename)
    )
      return 'locale-yaml';
    if (tail.length >= 3 && parent === 'automation' && filename === 'replay.ts')
      return 'replay-typescript';
  }
  throw new GitHubSourceError(
    'github_patch_conflict',
    'Source edits are limited to authored Scene manifests, narrative, theme, locale, or replay files below a scenes directory',
  );
}

export function assertSafeGitHubSourcePath(path: string): void {
  classifySafeGitHubSourcePath(path);
}

function decodeUtf8(bytes: Uint8Array): string {
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubSourceError('github_patch_conflict', 'Scene source must be valid UTF-8 text');
  }
  if (value.includes('\0'))
    throw new GitHubSourceError('github_patch_conflict', 'Scene source cannot contain NUL bytes');
  return value;
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= value.length - needle.length) {
    const found = value.indexOf(needle, cursor);
    if (found < 0) break;
    count += 1;
    cursor = found + needle.length;
  }
  return count;
}

function sourceLine(source: string, matchIndex: number, matchLength: number): string {
  const lineStart = source.lastIndexOf('\n', matchIndex - 1) + 1;
  const nextLine = source.indexOf('\n', matchIndex + matchLength);
  return source.slice(lineStart, nextLine < 0 ? source.length : nextLine);
}

function assertMdxSyntax(source: string): void {
  try {
    compileSync({ value: source, path: 'narrative.mdx' }, { outputFormat: 'program' });
  } catch {
    throw new GitHubSourceError('github_patch_conflict', 'Narrative source is not valid MDX');
  }
}

function assertTypeScriptSyntax(source: string): void {
  try {
    transformSync(source, {
      loader: 'ts',
      format: 'esm',
      target: 'es2022',
      sourcefile: 'automation/replay.ts',
      sourcemap: false,
    });
  } catch {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Playwright replay contains invalid TypeScript syntax',
    );
  }
}

function assertTypeScriptStringEdit(
  source: string,
  matchIndex: number,
  operation: GitHubPatchOperation,
): void {
  let delimiter: "'" | '"' | undefined;
  let literalStart = -1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (!quote) {
      if (character === '/' && next === '/') {
        lineComment = true;
        index += 1;
      } else if (character === '/' && next === '*') {
        blockComment = true;
        index += 1;
      } else if (character === "'" || character === '"') {
        quote = character;
        literalStart = index;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === quote) {
      if (literalStart < matchIndex && index >= matchIndex + operation.before.length) {
        delimiter = quote;
        break;
      }
      quote = undefined;
      literalStart = -1;
    }
  }
  if (!delimiter)
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Replay locator edits must remain inside one static string literal',
    );
  if (
    operation.before.includes(delimiter) ||
    operation.after.includes(delimiter) ||
    /[\\\r\n]/u.test(operation.before) ||
    /[\\\r\n]/u.test(operation.after)
  ) {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Replay locator edits cannot alter string-literal syntax',
    );
  }
}

interface StructuredPatchAnchor {
  readonly path: readonly string[];
  readonly normalizedStructure: string;
}

function structuredScalarAt(
  source: string,
  matchIndex: number,
  matchLength: number,
): StructuredPatchAnchor {
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Authored structured source is ambiguous or invalid',
    );
  }
  const matches: string[][] = [];
  const matchEnd = matchIndex + matchLength;
  const walk = <N>(node: N, path: readonly string[]): void => {
    if (!node) return;
    if (isScalar(node)) {
      if (node.range && matchIndex >= node.range[0] && matchEnd <= node.range[1]) {
        matches.push([...path]);
      }
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || pair.value === null) continue;
        walk(pair.value, [...path, String(pair.key.value)]);
      }
      return;
    }
    if (isSeq(node)) {
      node.items.forEach((item, index) => walk(item, [...path, String(index)]));
    }
  };
  walk(document.contents, []);
  if (matches.length !== 1 || matches[0]!.length === 0) {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Structured edits must be contained by exactly one authored scalar field',
    );
  }
  const path = matches[0]!;
  // SAFETY: document.toJS of a parsed YAML document only yields JSON-compatible values.
  let value = structuredClone(document.toJS({ maxAliasCount: 0 })) as JsonValue;
  let cursor: JsonValue | undefined = value;
  const isIndexKey = (segment: string): boolean => /^\d+$/u.test(segment);
  for (const segment of path.slice(0, -1)) {
    const next: JsonValue | undefined = isJsonObject(cursor)
      ? cursor[segment]
      : Array.isArray(cursor) && isIndexKey(segment)
        ? cursor[Number(segment)]
        : undefined;
    if (next === undefined) {
      cursor = undefined;
      break;
    }
    cursor = next;
  }
  if (cursor === undefined) {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Structured patch field could not be resolved',
    );
  }
  const final = path.at(-1)!;
  if (isJsonObject(cursor)) {
    cursor[final] = '__SCENEBOOK_PATCH__';
  } else if (Array.isArray(cursor) && isIndexKey(final)) {
    cursor[Number(final)] = '__SCENEBOOK_PATCH__';
  } else {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Structured patch field could not be resolved',
    );
  }
  return { path, normalizedStructure: JSON.stringify(value) };
}

const indexSegment = (value: string | undefined): boolean =>
  value !== undefined && /^\d+$/u.test(value);

function isTranslationNarrativePath(path: readonly string[]): boolean {
  if (path.length === 1) return path[0] === 'title' || path[0] === 'description';
  if (path[0] !== 'steps' || path.length < 3) return false;
  const field = path.at(-1);
  if (path.length === 3)
    return ['title', 'instruction', 'caption', 'altText'].includes(field ?? '');
  if (path.length === 5 && path[3] === 'choices')
    return field === 'label' || field === 'description';
  if (path.length === 5 && path[3] === 'ctas') return field === 'label';
  return path.length === 7 && path[3] === 'ctas' && path[5] === 'fields' && field === 'label';
}

function isManifestNarrativePath(path: readonly string[]): boolean {
  const field = path.at(-1);
  if (path.length === 1) return field === 'title' || field === 'description';
  if (path[0] === 'locales' && path.length === 3 && indexSegment(path[1])) return field === 'label';
  if (path[0] === 'translations' && path.length >= 3)
    return isTranslationNarrativePath(path.slice(2));
  if (path[0] !== 'steps' || !indexSegment(path[1])) return false;
  if (path.length === 3)
    return ['title', 'instruction', 'caption', 'notes', 'altText'].includes(field ?? '');
  if (path.length === 5 && path[2] === 'states' && (path[3] === 'before' || path[3] === 'after'))
    return field === 'title';
  if (path.length === 5 && path[2] === 'checks' && indexSegment(path[3]))
    return field === 'description';
  if (path.length === 5 && path[2] === 'masks' && indexSegment(path[3])) return field === 'reason';
  if (path.length === 5 && path[2] === 'choices' && indexSegment(path[3]))
    return field === 'label' || field === 'description';
  if (path.length === 5 && path[2] === 'ctas' && indexSegment(path[3])) return field === 'label';
  if (path.length === 4 && path[2] === 'cta') return field === 'label';
  if (path.length === 6 && (path[2] === 'ctas' || path[2] === 'cta') && path[4] === 'fields')
    return field === 'label';
  return (
    path.length === 6 &&
    path[2] === 'presentation' &&
    path[3] === 'annotations' &&
    indexSegment(path[4]) &&
    (field === 'text' || field === 'label')
  );
}

function isManifestLocatorPath(path: readonly string[]): boolean {
  if (path[0] !== 'steps' || !indexSegment(path[1])) return false;
  if (path.length === 5 && path[2] === 'masks' && indexSegment(path[3]) && path[4] === 'locator')
    return true;
  const targetIndex = path.lastIndexOf('target');
  if (targetIndex < 0) return false;
  const prefix = path.slice(0, targetIndex);
  const knownTarget =
    (prefix.length === 2 && prefix[0] === 'steps' && indexSegment(prefix[1])) ||
    (prefix.length === 4 &&
      prefix[0] === 'steps' &&
      indexSegment(prefix[1]) &&
      (prefix[2] === 'actions' || prefix[2] === 'checks') &&
      indexSegment(prefix[3]));
  if (!knownTarget) return false;
  const relative = path.slice(targetIndex + 1);
  if (relative.length === 1)
    return ['role', 'accessibleName', 'nearbyText'].includes(relative[0] ?? '');
  return (
    relative.length === 3 &&
    relative[0] === 'selectors' &&
    indexSegment(relative[1]) &&
    (relative[2] === 'engine' || relative[2] === 'value')
  );
}

function isManifestPresentationPath(path: readonly string[]): boolean {
  if (path[0] === 'theme' && path[1] === 'variables' && path.length === 3) return true;
  if (
    path[0] !== 'steps' ||
    !indexSegment(path[1]) ||
    path[2] !== 'presentation' ||
    path.length < 4
  )
    return false;
  const field = path.at(-1) ?? '';
  return [
    'durationMs',
    'x',
    'y',
    'width',
    'height',
    'zoom',
    'kind',
    'preset',
    'title',
    'showAddressBar',
    'visible',
    'atMs',
    'clickAtMs',
    'style',
    'autoAdvance',
    'transition',
    'state',
    'practiceMode',
    'interactive',
    'guide',
    'motion',
    'launchMedia',
    'color',
  ].includes(field);
}

function assertStructuredOperationPath(
  kind: GitHubSourceKind,
  operation: GitHubPatchOperation,
  path: readonly string[],
): void {
  const allowed =
    kind === 'theme-yaml'
      ? operation.kind === 'presentation'
      : kind === 'locale-yaml'
        ? operation.kind === 'narrative' && isTranslationNarrativePath(path)
        : operation.kind === 'locator'
          ? isManifestLocatorPath(path)
          : operation.kind === 'narrative'
            ? isManifestNarrativePath(path)
            : isManifestPresentationPath(path);
  if (!allowed) {
    throw new GitHubSourceError(
      'github_patch_conflict',
      `The ${operation.kind} patch anchor is outside an allowed authored field`,
    );
  }
}

function assertSemanticPatchAnchor(
  kind: GitHubSourceKind,
  source: string,
  operation: GitHubPatchOperation,
  matchIndex: number,
): StructuredPatchAnchor | undefined {
  const context = sourceLine(source, matchIndex, operation.before.length);
  if (kind === 'narrative-mdx') {
    if (
      operation.kind !== 'narrative' ||
      /[<>{}`\r\n]/u.test(operation.before) ||
      /[<>{}`\r\n]/u.test(operation.after) ||
      /[<>{}`]/u.test(context)
    ) {
      throw new GitHubSourceError(
        'github_patch_conflict',
        'MDX edits are limited to plain editorial text outside MDX expressions, JSX, and code',
      );
    }
    return undefined;
  }
  if (kind === 'replay-typescript') {
    if (
      operation.kind !== 'locator' ||
      !/(?:\.locator|\.getByRole|\.getByText|\.getByLabel|\.getByTestId|\.getByPlaceholder|\.getByAltText|\.getByTitle|selector)\s*\(?/u.test(
        context,
      )
    ) {
      throw new GitHubSourceError(
        'github_patch_conflict',
        'Replay edits are limited to static Playwright locator strings',
      );
    }
    assertTypeScriptSyntax(source);
    assertTypeScriptStringEdit(source, matchIndex, operation);
    return undefined;
  }
  const anchor = structuredScalarAt(source, matchIndex, operation.before.length);
  assertStructuredOperationPath(kind, operation, anchor.path);
  return anchor;
}

function assertStructuredPatchPreserved(
  kind: GitHubSourceKind,
  operation: GitHubPatchOperation,
  source: string,
  matchIndex: number,
  original: StructuredPatchAnchor,
): void {
  const patched = structuredScalarAt(source, matchIndex, operation.after.length);
  assertStructuredOperationPath(kind, operation, patched.path);
  if (
    JSON.stringify(patched.path) !== JSON.stringify(original.path) ||
    patched.normalizedStructure !== original.normalizedStructure
  ) {
    throw new GitHubSourceError(
      'github_patch_conflict',
      'Structured patches may change exactly one scalar value without altering document shape',
    );
  }
}

function validateSource(kind: GitHubSourceKind, source: string): void {
  try {
    if (kind === 'scene-yaml') parseSceneYaml(source);
    else if (kind === 'scene-json') {
      let value: JsonValue;
      try {
        // SAFETY: JSON.parse of the source text only yields JSON-compatible values.
        value = JSON.parse(source) as JsonValue;
      } catch {
        throw new GitHubSourceError(
          'github_patch_conflict',
          'Scene JSON must use strict JSON syntax',
        );
      }
      // YAML's strict parser accepts the JSON subset and additionally rejects duplicate keys,
      // which JSON.parse intentionally does not report.
      parseYamlWithSchema(source, z.unknown());
      SceneSchema.parse(migrateSceneDocument(value));
    } else if (kind === 'theme-yaml') {
      parseYamlWithSchema(source, z.record(z.string(), JsonValueSchema));
    } else if (kind === 'locale-yaml') {
      parseYamlWithSchema(source, SceneTranslationSchema);
    } else if (kind === 'narrative-mdx') assertMdxSyntax(source);
    else assertTypeScriptSyntax(source);
  } catch (error) {
    if (error instanceof GitHubSourceError) throw error;
    throw new GitHubSourceError(
      'github_patch_conflict',
      `Patched ${kind} source is not valid authored Scene content`,
    );
  }
}

export function applyGitHubPatch(
  source: Uint8Array,
  operations: readonly GitHubPatchOperation[],
  path: string,
): Uint8Array {
  if (source.byteLength > MAX_GITHUB_SOURCE_BYTES)
    throw new GitHubSourceError('github_source_too_large', 'Scene source exceeds the edit limit');
  if (operations.length < 1 || operations.length > 50)
    throw new GitHubSourceError('github_patch_conflict', 'A patch must contain 1 to 50 operations');
  const kind = classifySafeGitHubSourcePath(path);
  let value = decodeUtf8(source);
  validateSource(kind, value);
  for (const operation of operations) {
    const limit = operation.kind === 'narrative' ? 10_000 : 2_000;
    if (
      operation.before.length < 1 ||
      operation.before.length > limit ||
      operation.after.length > limit ||
      operation.before === operation.after ||
      operation.before.includes('\0') ||
      operation.after.includes('\0') ||
      (operation.kind !== 'narrative' && /[\r\n]/u.test(operation.after))
    ) {
      throw new GitHubSourceError('github_patch_conflict', 'Patch operation is invalid');
    }
    if (occurrences(value, operation.before) !== 1) {
      throw new GitHubSourceError(
        'github_patch_conflict',
        'Patch anchors must match exactly once at the requested base blob',
      );
    }
    const matchIndex = value.indexOf(operation.before);
    const structuredAnchor = assertSemanticPatchAnchor(kind, value, operation, matchIndex);
    const patched = value.replace(operation.before, operation.after);
    const bytes = Buffer.byteLength(patched);
    if (bytes > MAX_GITHUB_SOURCE_BYTES)
      throw new GitHubSourceError(
        'github_source_too_large',
        'Patched Scene source exceeds the edit limit',
      );
    validateSource(kind, patched);
    if (structuredAnchor)
      assertStructuredPatchPreserved(kind, operation, patched, matchIndex, structuredAnchor);
    value = patched;
  }
  return new TextEncoder().encode(value);
}

function gitBlobSha(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function encodeRepository(repository: string): string {
  const parts = repository.split('/');
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !name ||
    !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(name)
  ) {
    throw new GitHubSourceError('github_repository_mismatch', 'Repository binding is invalid');
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function encodeSourcePath(path: string): string {
  assertSafeGitHubSourcePath(path);
  return path.split('/').map(encodeURIComponent).join('/');
}

function isSafeGitBranch(value: string): boolean {
  const forbidden = new Set(['~', '^', ':', '?', '*', '[', ']']);
  return (
    !value.startsWith('-') &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.includes('\\') &&
    !value.includes('//') &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x20 || code === 0x7f || forbidden.has(character);
    }) &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock')
  );
}

const RepositoryResponseSchema = z
  .object({
    id: z.number().int().positive(),
    full_name: z.string().min(3).max(300),
    default_branch: z.string().min(1).max(255).refine(isSafeGitBranch),
  })
  .passthrough();
const CommitResponseSchema = z.object({ sha: z.string().regex(SHA1) }).passthrough();
const ContentResponseSchema = z
  .object({
    type: z.literal('file'),
    sha: z.string().regex(SHA1),
    size: z.number().int().min(0).max(MAX_GITHUB_SOURCE_BYTES),
    encoding: z.literal('base64'),
    content: z.string().max(Math.ceil((MAX_GITHUB_SOURCE_BYTES * 4) / 3) + 16_384),
  })
  .passthrough();
const RefResponseSchema = z
  .object({ object: z.object({ type: z.literal('commit'), sha: z.string().regex(SHA1) }) })
  .passthrough();
const UpdateContentResponseSchema = z
  .object({
    content: z.object({ sha: z.string().regex(SHA1) }),
    commit: z.object({ sha: z.string().regex(SHA1) }),
  })
  .passthrough();
const PullResponseSchema = z
  .object({ number: z.number().int().positive(), html_url: z.string().url() })
  .passthrough();
const IssueResponseSchema = z
  .object({ number: z.number().int().positive(), html_url: z.string().url() })
  .passthrough();
const CheckRunResponseSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(100),
    head_sha: z.string().regex(SHA1),
    external_id: z.string().min(1).max(1_000).nullable(),
    status: z.enum(['queued', 'in_progress', 'completed']),
    conclusion: z
      .enum([
        'action_required',
        'cancelled',
        'failure',
        'neutral',
        'success',
        'skipped',
        'stale',
        'timed_out',
      ])
      .nullable(),
    html_url: z.string().url().optional(),
  })
  .passthrough();
const CheckRunListResponseSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    check_runs: z.array(CheckRunResponseSchema).max(100),
  })
  .passthrough();

interface GitHubAppClientOptions {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly apiBaseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

interface CachedInstallationToken {
  readonly token: string;
  readonly usableUntil: number;
}

export class RemoteGitHubAppSourceClient implements GitHubSourceClient {
  private readonly origin: string;
  private readonly webOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<string, CachedInstallationToken>();
  private signingKey?: ReturnType<typeof importPKCS8>;

  constructor(private readonly options: GitHubAppClientOptions) {
    const base = new URL(options.apiBaseUrl);
    if (
      base.protocol !== 'https:' ||
      base.pathname !== '/' ||
      base.search ||
      base.hash ||
      base.username ||
      base.password
    ) {
      throw new Error('GitHub App API URL must be a credential-free HTTPS origin');
    }
    if (!/^[1-9][0-9]{0,19}$/u.test(options.appId)) throw new Error('GitHub App ID is invalid');
    this.origin = base.origin;
    this.webOrigin =
      base.hostname === 'api.github.com' ? 'https://github.com' : `${base.protocol}//${base.host}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async appJwt(): Promise<string> {
    if (!this.signingKey) {
      let normalized: string;
      try {
        normalized = createPrivateKey(this.options.privateKeyPem)
          .export({ type: 'pkcs8', format: 'pem' })
          .toString();
      } catch {
        throw new GitHubSourceError('github_auth_failed', 'GitHub App private key is invalid');
      }
      this.signingKey = importPKCS8(normalized, 'RS256');
    }
    const now = Math.floor(this.now().getTime() / 1_000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.options.appId)
      .setIssuedAt(now - 30)
      .setExpirationTime(now + 540)
      .sign(await this.signingKey);
  }

  private async request(
    path: string,
    input: {
      readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
      readonly token?: string;
      readonly body?: JsonObject;
      readonly allowNotFound?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<JsonValue | undefined> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Unsafe GitHub API path');
    if (input.signal?.aborted) throw githubAbortError(input.signal);
    const controller = new AbortController();
    const requestSignal = input.signal
      ? AbortSignal.any([controller.signal, input.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      const headers = new Headers({
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token ?? (await this.appJwt())}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'scenebook-control-plane',
      });
      if (input.body) headers.set('content-type', 'application/json; charset=UTF-8');
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method: input.method ?? 'GET',
        redirect: 'error',
        signal: requestSignal,
        headers,
        body: input.body ? JSON.stringify(input.body) : undefined,
      });
    } catch (error) {
      if (input.signal?.aborted) throw githubAbortError(input.signal);
      throw new GitHubSourceError(
        'github_unavailable',
        error instanceof DOMException && error.name === 'AbortError'
          ? 'GitHub API request timed out'
          : 'GitHub API request failed',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (input.allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
          throw new GitHubSourceError(
            'github_rate_limited',
            'GitHub API rate limit was exhausted',
            true,
          );
        }
        throw new GitHubSourceError('github_auth_failed', 'GitHub App authorization was rejected');
      }
      if (response.status === 404)
        throw new GitHubSourceError('github_not_found', 'GitHub resource was not found');
      if (response.status === 409 || response.status === 422)
        throw new GitHubSourceError('github_patch_conflict', 'GitHub rejected the source change');
      if (response.status >= 500)
        throw new GitHubSourceError(
          'github_unavailable',
          'GitHub API is temporarily unavailable',
          true,
        );
      throw new GitHubSourceError('github_invalid_response', 'GitHub API rejected the request');
    }
    if (response.status === 204) return {};
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub API returned a non-JSON response',
      );
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_RESPONSE_BYTES)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub API response exceeds the limit',
      );
    const reader = response.body?.getReader();
    if (!reader)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub API returned an empty response',
      );
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const bodyTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        byteLength += chunk.value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new GitHubSourceError(
            'github_invalid_response',
            'GitHub API response exceeds the limit',
          );
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof GitHubSourceError) throw error;
      if (input.signal?.aborted) throw githubAbortError(input.signal);
      throw new GitHubSourceError('github_unavailable', 'GitHub API response timed out', true);
    } finally {
      clearTimeout(bodyTimer);
    }
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      byteLength,
    );
    try {
      // SAFETY: JSON.parse of the capped response body only yields JSON-compatible values.
      return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
    } catch {
      throw new GitHubSourceError('github_invalid_response', 'GitHub API returned invalid JSON');
    }
  }

  private async installationToken(installationId: string): Promise<string> {
    if (!INSTALLATION_ID.test(installationId))
      throw new GitHubSourceError('github_auth_failed', 'GitHub installation binding is invalid');
    const cached = this.tokens.get(installationId);
    if (cached && cached.usableUntil > this.now().getTime()) return cached.token;
    const schema = z
      .object({
        token: z.string().min(20).max(1_000),
        expires_at: z.string().datetime({ offset: true }),
      })
      .passthrough();
    const response = schema.safeParse(
      await this.request(`/app/installations/${installationId}/access_tokens`, { method: 'POST' }),
    );
    if (!response.success)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned an invalid installation token',
      );
    const expiresAt = new Date(response.data.expires_at).getTime();
    const usableUntil = Math.min(expiresAt - 60_000, this.now().getTime() + 50 * 60_000);
    if (usableUntil <= this.now().getTime())
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned an expired installation token',
      );
    for (const [id, value] of this.tokens) {
      if (value.usableUntil <= this.now().getTime()) this.tokens.delete(id);
    }
    if (this.tokens.size >= 1_000) {
      const oldest = this.tokens.keys().next().value;
      if (oldest) this.tokens.delete(oldest);
    }
    this.tokens.set(installationId, { token: response.data.token, usableUntil });
    return response.data.token;
  }

  private async installationRequest(
    installationId: string,
    path: string,
    input: Omit<Parameters<RemoteGitHubAppSourceClient['request']>[1], 'token'> = {},
  ): Promise<JsonValue | undefined> {
    return this.request(path, { ...input, token: await this.installationToken(installationId) });
  }

  async inspectInstallation(input: {
    installationId: string;
    repository: string;
  }): Promise<GitHubSourceBindingInfo> {
    const response = RepositoryResponseSchema.safeParse(
      await this.installationRequest(
        input.installationId,
        `/repos/${encodeRepository(input.repository)}`,
      ),
    );
    if (!response.success)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned invalid repository metadata',
      );
    if (response.data.full_name.toLowerCase() !== input.repository.toLowerCase())
      throw new GitHubSourceError(
        'github_repository_mismatch',
        'Installation repository does not match the binding',
      );
    return {
      repositoryId: String(response.data.id),
      repository: response.data.full_name,
      defaultBranch: response.data.default_branch,
    };
  }

  private async assertCommit(input: {
    installationId: string;
    repository: string;
    commitSha: string;
    signal?: AbortSignal;
  }): Promise<void> {
    if (!SHA1.test(input.commitSha))
      throw new GitHubSourceError('github_commit_mismatch', 'Base commit SHA is invalid');
    const response = CommitResponseSchema.safeParse(
      await this.installationRequest(
        input.installationId,
        `/repos/${encodeRepository(input.repository)}/git/commits/${input.commitSha}`,
        input.signal ? { signal: input.signal } : {},
      ),
    );
    if (!response.success || response.data.sha !== input.commitSha)
      throw new GitHubSourceError(
        'github_commit_mismatch',
        'GitHub did not resolve the exact base commit',
      );
  }

  private async readAtRef(input: {
    installationId: string;
    repository: string;
    ref: string;
    path: string;
    signal?: AbortSignal;
  }): Promise<{ readonly blobSha: string; readonly content: Uint8Array }> {
    const response = ContentResponseSchema.safeParse(
      await this.installationRequest(
        input.installationId,
        `/repos/${encodeRepository(input.repository)}/contents/${encodeSourcePath(input.path)}?ref=${encodeURIComponent(input.ref)}`,
        input.signal ? { signal: input.signal } : {},
      ),
    );
    if (!response.success)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned invalid Scene source metadata',
      );
    if (!/^[A-Za-z0-9+/=\r\n]*$/u.test(response.data.content))
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned invalid base64 source content',
      );
    const content = Buffer.from(response.data.content.replace(/[\r\n]/gu, ''), 'base64');
    if (content.byteLength !== response.data.size || content.byteLength > MAX_GITHUB_SOURCE_BYTES)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub source size did not match its metadata',
      );
    if (gitBlobSha(content) !== response.data.sha)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub source bytes did not match the returned blob SHA',
      );
    decodeUtf8(content);
    return { blobSha: response.data.sha, content };
  }

  async readSource(input: {
    installationId: string;
    repository: string;
    commitSha: string;
    path: string;
  }): Promise<GitHubSourceFile> {
    await this.assertCommit({
      installationId: input.installationId,
      repository: input.repository,
      commitSha: input.commitSha,
    });
    const source = await this.readAtRef({ ...input, ref: input.commitSha });
    return {
      commitSha: input.commitSha,
      blobSha: source.blobSha,
      byteLength: source.content.byteLength,
      content: decodeUtf8(source.content),
    };
  }

  private async ensureBranch(input: {
    installationId: string;
    repository: string;
    branch: string;
    baseCommitSha: string;
    signal?: AbortSignal;
    assertLease?: () => Promise<void>;
  }): Promise<string> {
    const repository = encodeRepository(input.repository);
    const refPath = `/repos/${repository}/git/ref/heads/${input.branch
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const existing = await this.installationRequest(input.installationId, refPath, {
      allowNotFound: true,
      signal: input.signal,
    });
    if (existing !== undefined) {
      const parsed = RefResponseSchema.safeParse(existing);
      if (!parsed.success)
        throw new GitHubSourceError(
          'github_invalid_response',
          'GitHub returned an invalid branch ref',
        );
      return parsed.data.object.sha;
    }
    await input.assertLease?.();
    if (input.signal?.aborted) throw githubAbortError(input.signal);
    const created = RefResponseSchema.safeParse(
      await this.installationRequest(input.installationId, `/repos/${repository}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${input.branch}`, sha: input.baseCommitSha },
        signal: input.signal,
      }),
    );
    if (!created.success)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned an invalid created branch ref',
      );
    return created.data.object.sha;
  }

  private async ensurePullRequest(input: {
    installationId: string;
    repository: string;
    branch: string;
    base: string;
    title: string;
    body: string;
    signal?: AbortSignal;
    assertLease?: () => Promise<void>;
  }): Promise<{ number: number; url: string }> {
    const [owner] = input.repository.split('/');
    const repo = encodeRepository(input.repository);
    const query = new URLSearchParams({
      state: 'open',
      head: `${owner}:${input.branch}`,
      base: input.base,
      per_page: '10',
    });
    const existing = z
      .array(PullResponseSchema)
      .max(10)
      .safeParse(
        await this.installationRequest(input.installationId, `/repos/${repo}/pulls?${query}`, {
          signal: input.signal,
        }),
      );
    if (!existing.success)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned an invalid pull request list',
      );
    const found = existing.data[0];
    if (found) return { number: found.number, url: this.safeWebUrl(found.html_url) };
    await input.assertLease?.();
    if (input.signal?.aborted) throw githubAbortError(input.signal);
    const created = PullResponseSchema.safeParse(
      await this.installationRequest(input.installationId, `/repos/${repo}/pulls`, {
        method: 'POST',
        body: { title: input.title, head: input.branch, base: input.base, body: input.body },
        signal: input.signal,
      }),
    );
    if (!created.success)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned an invalid pull request',
      );
    return { number: created.data.number, url: this.safeWebUrl(created.data.html_url) };
  }

  private async ensureIssue(input: {
    installationId: string;
    repository: string;
    changeId: string;
    title: string;
    body: string;
    signal?: AbortSignal;
    assertLease?: () => Promise<void>;
  }): Promise<{ number: number; url: string }> {
    const repo = encodeRepository(input.repository);
    const marker = `<!-- scenebook-change:${input.changeId} -->`;
    const query = new URLSearchParams({
      state: 'all',
      per_page: '100',
      sort: 'created',
      direction: 'desc',
    });
    const schema = z
      .array(
        IssueResponseSchema.extend({
          body: z.string().nullable(),
          pull_request: z.unknown().optional(),
        }),
      )
      .max(100);
    const existing = schema.safeParse(
      await this.installationRequest(input.installationId, `/repos/${repo}/issues?${query}`, {
        signal: input.signal,
      }),
    );
    if (!existing.success)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned an invalid issue list',
      );
    const found = existing.data.find(
      (issue) => !issue.pull_request && issue.body?.includes(marker),
    );
    if (found) return { number: found.number, url: this.safeWebUrl(found.html_url) };
    await input.assertLease?.();
    if (input.signal?.aborted) throw githubAbortError(input.signal);
    const created = IssueResponseSchema.safeParse(
      await this.installationRequest(input.installationId, `/repos/${repo}/issues`, {
        method: 'POST',
        body: { title: input.title, body: `${marker}\n${input.body}` },
        signal: input.signal,
      }),
    );
    if (!created.success)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned an invalid review issue',
      );
    return { number: created.data.number, url: this.safeWebUrl(created.data.html_url) };
  }

  private safeWebUrl(raw: string): string {
    const value = new URL(raw);
    if (
      value.origin !== this.webOrigin ||
      value.protocol !== 'https:' ||
      value.username ||
      value.password ||
      value.hash
    ) {
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned a link outside the configured GitHub host',
      );
    }
    return value.toString();
  }

  async ensureCheckRun(input: {
    installationId: string;
    repository: string;
    state: GitHubCheckRunState;
    signal?: AbortSignal;
  }): Promise<GitHubCheckRunResult> {
    const { state } = input;
    if (
      !SHA1.test(state.commitSha) ||
      state.externalId.length < 1 ||
      state.externalId.length > 1_000 ||
      /[\u0000-\u001f\u007f]/u.test(state.externalId) ||
      state.title.length < 1 ||
      state.title.length > 255 ||
      state.summary.length < 1 ||
      state.summary.length > 65_535 ||
      (state.status === 'completed') !== (state.conclusion !== undefined)
    ) {
      throw new GitHubSourceError('github_patch_conflict', 'GitHub Check state is invalid');
    }
    const detailsUrl = new URL(state.detailsUrl);
    if (
      detailsUrl.protocol !== 'https:' ||
      detailsUrl.username ||
      detailsUrl.password ||
      detailsUrl.hash
    ) {
      throw new GitHubSourceError('github_patch_conflict', 'GitHub Check details URL is invalid');
    }
    await this.assertCommit({
      installationId: input.installationId,
      repository: input.repository,
      commitSha: state.commitSha,
      signal: input.signal,
    });
    const repository = encodeRepository(input.repository);
    const matching: z.infer<typeof CheckRunResponseSchema>[] = [];
    let exhausted = false;
    const maxPages = 20;
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({
        check_name: 'Scenebook',
        filter: 'all',
        per_page: '100',
        page: String(page),
      });
      const listed = CheckRunListResponseSchema.safeParse(
        await this.installationRequest(
          input.installationId,
          `/repos/${repository}/commits/${state.commitSha}/check-runs?${query}`,
          input.signal ? { signal: input.signal } : {},
        ),
      );
      if (!listed.success)
        throw new GitHubSourceError(
          'github_invalid_response',
          'GitHub returned an invalid Check Run list',
        );
      matching.push(
        ...listed.data.check_runs.filter(
          (check) =>
            check.name === 'Scenebook' &&
            check.head_sha === state.commitSha &&
            check.external_id === state.externalId,
        ),
      );
      if (listed.data.check_runs.length < 100 || page * 100 >= listed.data.total_count) {
        exhausted = true;
        break;
      }
    }
    if (!exhausted)
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub Check Run pagination exceeded the safe reconciliation bound',
      );
    const existing = matching.sort((left, right) => left.id - right.id)[0];
    if (existing?.status === 'completed') {
      if (
        existing.conclusion !== 'success' &&
        existing.conclusion !== 'failure' &&
        existing.conclusion !== 'cancelled'
      ) {
        throw new GitHubSourceError(
          'github_invalid_response',
          'The reconciled terminal GitHub Check has an unsupported conclusion',
        );
      }
      if (state.status !== 'completed' || state.conclusion !== existing.conclusion) {
        throw new GitHubSourceError(
          'github_patch_conflict',
          'A terminal GitHub Check cannot be regressed or rewritten with a different conclusion',
        );
      }
      return {
        id: existing.id,
        commitSha: existing.head_sha,
        status: 'completed',
        conclusion: existing.conclusion,
        url: existing.html_url ? this.safeWebUrl(existing.html_url) : undefined,
      };
    }
    const body = {
      name: 'Scenebook',
      external_id: state.externalId,
      details_url: detailsUrl.toString(),
      status: state.status,
      ...(state.status === 'completed'
        ? { conclusion: state.conclusion, completed_at: this.now().toISOString() }
        : existing
          ? {}
          : { started_at: this.now().toISOString() }),
      output: { title: state.title, summary: state.summary },
    } as const;
    const mutationBody = existing ? body : { ...body, head_sha: state.commitSha };
    const response = CheckRunResponseSchema.safeParse(
      await this.installationRequest(
        input.installationId,
        existing
          ? `/repos/${repository}/check-runs/${existing.id}`
          : `/repos/${repository}/check-runs`,
        {
          method: existing ? 'PATCH' : 'POST',
          body: mutationBody,
          signal: input.signal,
        },
      ),
    );
    if (
      !response.success ||
      response.data.name !== 'Scenebook' ||
      response.data.head_sha !== state.commitSha ||
      response.data.external_id !== state.externalId ||
      response.data.status !== state.status ||
      (state.status === 'completed' && response.data.conclusion !== state.conclusion)
    ) {
      throw new GitHubSourceError(
        'github_invalid_response',
        'GitHub returned an invalid Check Run state',
      );
    }
    return {
      id: response.data.id,
      commitSha: response.data.head_sha,
      status: state.status,
      conclusion: state.conclusion,
      url: response.data.html_url ? this.safeWebUrl(response.data.html_url) : undefined,
    };
  }

  async applyChange(input: {
    changeId: string;
    installationId: string;
    repository: string;
    defaultBranch: string;
    baseCommitSha: string;
    expectedBlobSha: string;
    path: string;
    operations: readonly GitHubPatchOperation[];
    title: string;
    createReviewIssue: boolean;
    evidence?: GitHubChangeEvidenceBinding;
    signal?: AbortSignal;
    assertLease?: () => Promise<void>;
  }): Promise<GitHubAppliedChange> {
    await this.assertCommit({
      installationId: input.installationId,
      repository: input.repository,
      commitSha: input.baseCommitSha,
      signal: input.signal,
    });
    const base = await this.readAtRef({ ...input, ref: input.baseCommitSha });
    if (base.blobSha !== input.expectedBlobSha)
      throw new GitHubSourceError(
        'github_blob_mismatch',
        'Scene source no longer matches the expected base blob',
      );
    const desired = applyGitHubPatch(base.content, input.operations, input.path);
    const desiredBlobSha = gitBlobSha(desired);
    const branch = `scenebook/${input.changeId}`;
    const branchHead = await this.ensureBranch({ ...input, branch });
    let headCommitSha: string;
    let headBlobSha: string;
    if (branchHead !== input.baseCommitSha) {
      const recovered = await this.readAtRef({ ...input, ref: branch });
      if (recovered.blobSha !== desiredBlobSha)
        throw new GitHubSourceError(
          'github_branch_collision',
          'The deterministic change branch contains different work',
        );
      headCommitSha = branchHead;
      headBlobSha = recovered.blobSha;
    } else {
      await input.assertLease?.();
      if (input.signal?.aborted) throw githubAbortError(input.signal);
      const updated = UpdateContentResponseSchema.safeParse(
        await this.installationRequest(
          input.installationId,
          `/repos/${encodeRepository(input.repository)}/contents/${encodeSourcePath(input.path)}`,
          {
            method: 'PUT',
            body: {
              message: `scenebook: ${input.title}`,
              content: Buffer.from(desired).toString('base64'),
              sha: input.expectedBlobSha,
              branch,
            },
            signal: input.signal,
          },
        ),
      );
      if (!updated.success)
        throw new GitHubSourceError(
          'github_invalid_response',
          'GitHub returned an invalid source commit',
        );
      if (updated.data.content.sha !== desiredBlobSha)
        throw new GitHubSourceError(
          'github_blob_mismatch',
          'GitHub committed unexpected Scene source bytes',
        );
      headCommitSha = updated.data.commit.sha;
      headBlobSha = updated.data.content.sha;
    }
    const evidenceLines = input.evidence
      ? Object.entries(input.evidence)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([key, value]) => `- ${key}: \`${value}\``)
          .join('\n')
      : '- none';
    const marker = `<!-- scenebook-change:${input.changeId} -->`;
    const body = `${marker}\nThis source patch was explicitly requested in Scenebook.\n\n- change: \`${input.changeId}\`\n- base commit: \`${input.baseCommitSha}\`\n- base blob: \`${input.expectedBlobSha}\`\n- head blob: \`${headBlobSha}\`\n- operation kinds: ${input.operations.map((operation) => operation.kind).join(', ')}\n\nEvidence bindings:\n${evidenceLines}`;
    const pull = await this.ensurePullRequest({
      ...input,
      branch,
      base: input.defaultBranch,
      body,
    });
    const issue = input.createReviewIssue
      ? await this.ensureIssue({
          ...input,
          title: `Review: ${input.title}`,
          body: `${body}\n- pull request: ${pull.url}`,
        })
      : undefined;
    return {
      baseCommitSha: input.baseCommitSha,
      baseBlobSha: input.expectedBlobSha,
      headCommitSha,
      headBlobSha,
      branch,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.url,
      issueNumber: issue?.number,
      issueUrl: issue?.url,
    };
  }
}

export class DisabledGitHubSourceClient implements GitHubSourceClient {
  private disabled(): never {
    throw new GitHubSourceError('github_app_disabled', 'GitHub App source integration is disabled');
  }
  async inspectInstallation(): Promise<GitHubSourceBindingInfo> {
    return this.disabled();
  }
  async readSource(): Promise<GitHubSourceFile> {
    return this.disabled();
  }
  async applyChange(): Promise<GitHubAppliedChange> {
    return this.disabled();
  }
  async ensureCheckRun(): Promise<GitHubCheckRunResult> {
    return this.disabled();
  }
}
