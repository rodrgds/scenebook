import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { TextDecoder } from 'node:util';
import { parse } from '@babel/parser';
import { playwrightCliPath } from '@scenebook/playwright';
import { scanStructuredValue } from '@scenebook/privacy';
import { prepareRecordingTarget } from './recording-url.js';
import { CliError } from './types.js';

export const MAX_RECORDING_SOURCE_BYTES = 16 * 1024 * 1024;

const PLAYWRIGHT_TEST_HEADERS = [
  `import { test, expect } from '@playwright/test';`,
  `import { test, expect, devices } from '@playwright/test';`,
] as const;
const HEADER_BUFFERS = PLAYWRIGHT_TEST_HEADERS.map((value) => Buffer.from(value));
const MAX_HEADER_BYTES = Math.max(...HEADER_BUFFERS.map((value) => value.byteLength));
const DATA_ENTRY_METHODS = new Set([
  'accept',
  'fill',
  'insertText',
  'pressSequentially',
  'routeFromHAR',
  'selectOption',
  'setInputFiles',
  'toHaveValue',
  'toHaveValues',
  'type',
]);
const OPTIONAL_DATA_ENTRY_METHODS = new Set(['accept']);
const URL_METHODS = new Set(['goto', 'toHaveURL', 'waitForURL']);
const HELPER_NAMES = new Set([
  'scenebookRecordingBoolean',
  'scenebookRecordingNumber',
  'scenebookRecordingValue',
]);
const execFileAsync = promisify(execFile);

interface AstNode {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly [key: string]: unknown;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export interface RecorderPlaceholder {
  readonly name: string;
  readonly kind: 'input' | 'url';
  readonly valueType: 'boolean' | 'number' | 'string';
  readonly method: string;
}

export interface SanitizedPlaywrightRecording {
  readonly source: string;
  readonly placeholders: readonly RecorderPlaceholder[];
}

export interface RecorderCaptureOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly targetHref: string;
  /** Internal/test override. The default launches this package's pinned Playwright CLI. */
  readonly command?: string;
  /** Internal/test injection for deterministic process regressions. */
  readonly spawnProcess?: typeof spawn;
  /** Internal/test override for named-pipe coverage. */
  readonly platform?: NodeJS.Platform;
}

interface ActiveCaptureOptions extends RecorderCaptureOptions {
  readonly childCwd: string;
  readonly childEnv: NodeJS.ProcessEnv;
  readonly profileDirectory: string;
}

interface SanitizationState {
  inputIndex: number;
  urlIndex: number;
  readonly placeholders: RecorderPlaceholder[];
  readonly replacements: Replacement[];
  readonly originalInputStrings: Set<string>;
}

function isNode(value: unknown): value is AstNode {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { readonly type?: unknown }).type === 'string'
  );
}

function childNodes(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'comments' ||
      key === 'end' ||
      key === 'errors' ||
      key === 'extra' ||
      key === 'loc' ||
      key === 'start' ||
      key === 'tokens'
    ) {
      continue;
    }
    if (isNode(value)) result.push(value);
    else if (Array.isArray(value)) result.push(...value.filter(isNode));
  }
  return result;
}

function visit(node: AstNode, callback: (candidate: AstNode) => void): void {
  callback(node);
  for (const child of childNodes(node)) visit(child, callback);
}

function nodeRange(node: AstNode): { readonly start: number; readonly end: number } {
  if (
    typeof node.start !== 'number' ||
    typeof node.end !== 'number' ||
    node.start < 0 ||
    node.end < node.start
  ) {
    throw new CliError(
      'Playwright recording contains an unbounded syntax node; no replay was written.',
    );
  }
  return { start: node.start, end: node.end };
}

function parseSource(source: string): AstNode {
  try {
    return parse(source, {
      sourceType: 'module',
      plugins: ['typescript'],
      errorRecovery: false,
    }) as unknown as AstNode;
  } catch {
    throw new CliError(
      'Playwright produced an invalid TypeScript recording; no replay was written.',
    );
  }
}

function programBody(file: AstNode): readonly AstNode[] {
  const program = isNode(file.program) ? file.program : undefined;
  if (!program || !Array.isArray(program.body)) {
    throw new CliError('Playwright recording has no TypeScript program; no replay was written.');
  }
  return program.body.filter(isNode);
}

function stringValue(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return node.value;
  if (node.type !== 'TemplateLiteral') return undefined;
  const expressions = Array.isArray(node.expressions) ? node.expressions : [];
  const quasis = Array.isArray(node.quasis) ? node.quasis : [];
  if (expressions.length !== 0 || quasis.length !== 1 || !isNode(quasis[0]?.value))
    return undefined;
  const value = quasis[0].value;
  return typeof value.cooked === 'string'
    ? value.cooked
    : typeof value.raw === 'string'
      ? value.raw
      : undefined;
}

function identifierName(node: unknown): string | undefined {
  return isNode(node) && node.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : undefined;
}

function methodName(expression: unknown): string | undefined {
  if (!isNode(expression)) return undefined;
  if (expression.type !== 'MemberExpression' && expression.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  if (expression.computed === true) return stringValue(expression.property);
  return identifierName(expression.property);
}

function callArguments(node: AstNode): readonly AstNode[] {
  return Array.isArray(node.arguments) ? node.arguments.filter(isNode) : [];
}

function callCallee(node: AstNode): AstNode | undefined {
  return isNode(node.callee) ? node.callee : undefined;
}

function isCall(node: AstNode): boolean {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}

function directTestCall(statement: AstNode): AstNode | undefined {
  if (statement.type !== 'ExpressionStatement' || !isNode(statement.expression)) return undefined;
  const expression = statement.expression;
  if (!isCall(expression) || identifierName(callCallee(expression)) !== 'test') return undefined;
  return expression;
}

function testUseCall(statement: AstNode): boolean {
  if (statement.type !== 'ExpressionStatement' || !isNode(statement.expression)) return false;
  const expression = statement.expression;
  if (!isCall(expression) || methodName(callCallee(expression)) !== 'use') return false;
  const callee = callCallee(expression);
  return isNode(callee?.object) && identifierName(callee.object) === 'test';
}

function validatePlaywrightImport(node: AstNode): void {
  if (node.type !== 'ImportDeclaration' || stringValue(node.source) !== '@playwright/test') {
    throw new CliError('Only Playwright Test TypeScript recordings are accepted.');
  }
  const specifiers = Array.isArray(node.specifiers) ? node.specifiers.filter(isNode) : [];
  const names = new Set<string>();
  for (const specifier of specifiers) {
    if (specifier.type !== 'ImportSpecifier') {
      throw new CliError(
        'Playwright recording import shape is not supported; no replay was written.',
      );
    }
    const imported = identifierName(specifier.imported) ?? stringValue(specifier.imported);
    const local = identifierName(specifier.local);
    if (!imported || imported !== local || !['devices', 'expect', 'test'].includes(imported)) {
      throw new CliError(
        'Playwright recording import shape is not supported; no replay was written.',
      );
    }
    names.add(imported);
  }
  if (
    names.size !== specifiers.length ||
    !names.has('test') ||
    !names.has('expect') ||
    (names.size !== 2 && !(names.size === 3 && names.has('devices')))
  ) {
    throw new CliError(
      'Playwright recording import shape is not supported; no replay was written.',
    );
  }
}

function validatePlaywrightProgram(
  file: AstNode,
  options: { readonly allowSanitizerHelpers?: boolean } = {},
): AstNode {
  const body = programBody(file);
  const importDeclarations = body.filter((node) => node.type === 'ImportDeclaration');
  if (importDeclarations.length !== 1 || body[0] !== importDeclarations[0]) {
    throw new CliError('Only one complete Playwright Test recording is accepted.');
  }
  const playwrightImport = importDeclarations[0];
  if (!playwrightImport) throw new CliError('Playwright recording import is missing.');
  validatePlaywrightImport(playwrightImport);

  let testCalls = 0;
  for (const statement of body.slice(1)) {
    const testCall = directTestCall(statement);
    if (testCall) {
      testCalls += 1;
      const callback = callArguments(testCall).find(
        (argument) =>
          argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression',
      );
      if (!callback || callback.async !== true) {
        throw new CliError(
          'Playwright recording test callback is incomplete; no replay was written.',
        );
      }
      continue;
    }
    if (testUseCall(statement)) continue;
    if (
      options.allowSanitizerHelpers &&
      statement.type === 'FunctionDeclaration' &&
      HELPER_NAMES.has(identifierName(statement.id) ?? '')
    ) {
      continue;
    }
    throw new CliError(
      'Playwright recording contains unsupported top-level source; no replay was written.',
    );
  }
  if (testCalls !== 1) {
    throw new CliError('Playwright recording must contain exactly one generated test.');
  }
  return playwrightImport;
}

function helperSource(): string {
  return `

function scenebookRecordingValue(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(\`Missing required sanitized recording fixture \${name}.\`);
  return value;
}

function scenebookRecordingNumber(name: string): number {
  const value = Number(scenebookRecordingValue(name));
  if (!Number.isFinite(value)) throw new Error(\`Sanitized recording fixture \${name} must be a finite number.\`);
  return value;
}

function scenebookRecordingBoolean(name: string): boolean {
  const value = scenebookRecordingValue(name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(\`Sanitized recording fixture \${name} must be true or false.\`);
}`;
}

function placeholderCall(name: string, valueType: RecorderPlaceholder['valueType']): string {
  const helper =
    valueType === 'number'
      ? 'scenebookRecordingNumber'
      : valueType === 'boolean'
        ? 'scenebookRecordingBoolean'
        : 'scenebookRecordingValue';
  return `${helper}('${name}')`;
}

function addPlaceholder(
  state: SanitizationState,
  node: AstNode,
  kind: RecorderPlaceholder['kind'],
  valueType: RecorderPlaceholder['valueType'],
  method: string,
): void {
  const index = kind === 'input' ? (state.inputIndex += 1) : (state.urlIndex += 1);
  const name = `SCENEBOOK_${kind === 'input' ? 'INPUT' : 'URL'}_${String(index).padStart(3, '0')}`;
  const range = nodeRange(node);
  state.placeholders.push({ name, kind, valueType, method });
  state.replacements.push({ ...range, value: placeholderCall(name, valueType) });
}

function rememberStrings(node: AstNode, values: Set<string>): void {
  visit(node, (candidate) => {
    const value = stringValue(candidate);
    if (value !== undefined && value.length > 0) values.add(value);
  });
}

function supportedStructuredData(node: AstNode): boolean {
  if (
    node.type === 'StringLiteral' ||
    node.type === 'NumericLiteral' ||
    node.type === 'BooleanLiteral'
  ) {
    return true;
  }
  if (node.type === 'TemplateLiteral') return true;
  if (
    [
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    return isNode(node.expression) && supportedStructuredData(node.expression);
  }
  if (node.type === 'UnaryExpression') {
    return (
      (node.operator === '+' || node.operator === '-') &&
      isNode(node.argument) &&
      node.argument.type === 'NumericLiteral'
    );
  }
  if (node.type === 'ArrayExpression') {
    return (
      Array.isArray(node.elements) &&
      node.elements.every((element) => isNode(element) && supportedStructuredData(element))
    );
  }
  if (node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) return false;
  return node.properties.every((property) => {
    if (
      !isNode(property) ||
      property.type !== 'ObjectProperty' ||
      property.computed === true ||
      property.shorthand === true ||
      !isNode(property.value)
    ) {
      return false;
    }
    const key = identifierName(property.key) ?? stringValue(property.key);
    return key !== undefined && supportedStructuredData(property.value);
  });
}

function sanitizeStructuredData(node: AstNode, method: string, state: SanitizationState): void {
  if (!supportedStructuredData(node)) {
    rememberStrings(node, state.originalInputStrings);
    addPlaceholder(state, node, 'input', 'string', method);
    return;
  }
  const value = stringValue(node);
  if (value !== undefined) {
    if (value.length > 0) state.originalInputStrings.add(value);
    addPlaceholder(state, node, 'input', 'string', method);
    return;
  }
  if (node.type === 'NumericLiteral') {
    addPlaceholder(state, node, 'input', 'number', method);
    return;
  }
  if (node.type === 'BooleanLiteral') {
    addPlaceholder(state, node, 'input', 'boolean', method);
    return;
  }
  if (node.type === 'UnaryExpression') {
    addPlaceholder(state, node, 'input', 'number', method);
    return;
  }
  if (
    [
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
    ].includes(node.type) &&
    isNode(node.expression)
  ) {
    sanitizeStructuredData(node.expression, method, state);
    return;
  }
  if (node.type === 'ArrayExpression' && Array.isArray(node.elements)) {
    for (const element of node.elements) {
      if (isNode(element)) sanitizeStructuredData(element, method, state);
    }
    return;
  }
  if (node.type === 'ObjectExpression' && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      if (isNode(property) && isNode(property.value)) {
        sanitizeStructuredData(property.value, method, state);
      }
    }
  }
}

function collectReplacements(file: AstNode, state: SanitizationState): void {
  const walk = (node: AstNode): void => {
    if (isCall(node)) {
      const method = methodName(callCallee(node));
      const arguments_ = callArguments(node);
      const first = arguments_[0];
      if (method && URL_METHODS.has(method)) {
        if (!first) {
          throw new CliError(`Recorded ${method} call has no URL; no replay was written.`);
        }
        addPlaceholder(state, first, 'url', 'string', method);
        const callee = callCallee(node);
        if (callee) walk(callee);
        for (const argument of arguments_.slice(1)) walk(argument);
        return;
      }
      if (method && DATA_ENTRY_METHODS.has(method)) {
        if (!first) {
          if (!OPTIONAL_DATA_ENTRY_METHODS.has(method)) {
            throw new CliError(
              `Recorded ${method} call has no fixture value; no replay was written.`,
            );
          }
        } else {
          sanitizeStructuredData(first, method, state);
        }
        const callee = callCallee(node);
        if (callee) walk(callee);
        for (const argument of arguments_.slice(1)) walk(argument);
        return;
      }
    }
    for (const child of childNodes(node)) walk(child);
  };
  walk(file);
}

function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  const ordered = [...replacements].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous && current && previous.end > current.start) {
      throw new CliError(
        'Playwright recording produced overlapping private values; no replay was written.',
      );
    }
  }
  let result = source;
  for (const replacement of ordered.reverse()) {
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  return result;
}

function fixtureCall(node: AstNode, kind?: RecorderPlaceholder['kind']): boolean {
  if (!isCall(node)) return false;
  const helper = identifierName(callCallee(node));
  if (!helper || !HELPER_NAMES.has(helper)) return false;
  const name = stringValue(callArguments(node)[0]);
  if (!name) return false;
  return kind === undefined || name.startsWith(`SCENEBOOK_${kind === 'input' ? 'INPUT' : 'URL'}_`);
}

function fixtureDataTree(node: AstNode): boolean {
  if (fixtureCall(node, 'input')) return true;
  if (
    [
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    return isNode(node.expression) && fixtureDataTree(node.expression);
  }
  if (node.type === 'ArrayExpression') {
    return (
      Array.isArray(node.elements) &&
      node.elements.every((value) => isNode(value) && fixtureDataTree(value))
    );
  }
  if (node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) return false;
  return node.properties.every(
    (property) =>
      isNode(property) &&
      property.type === 'ObjectProperty' &&
      property.computed !== true &&
      property.shorthand !== true &&
      isNode(property.value) &&
      fixtureDataTree(property.value),
  );
}

function assertSanitizedCalls(file: AstNode, placeholders: readonly RecorderPlaceholder[]): void {
  const used = new Map<string, number>();
  visit(file, (node) => {
    if (fixtureCall(node)) {
      const name = stringValue(callArguments(node)[0]);
      if (name) used.set(name, (used.get(name) ?? 0) + 1);
    }
    if (!isCall(node)) return;
    const method = methodName(callCallee(node));
    const first = callArguments(node)[0];
    if (method && URL_METHODS.has(method) && (!first || !fixtureCall(first, 'url'))) {
      throw new CliError(`Recorded ${method} URL was not sanitized; no replay was written.`);
    }
    if (method && DATA_ENTRY_METHODS.has(method) && first && !fixtureDataTree(first)) {
      throw new CliError(`Recorded ${method} value was not sanitized; no replay was written.`);
    }
  });
  if (
    used.size !== placeholders.length ||
    placeholders.some((placeholder) => used.get(placeholder.name) !== 1)
  ) {
    throw new CliError(
      'Sanitized recording fixture binding is inconsistent; no replay was written.',
    );
  }
}

function assertNoOriginalInputStrings(file: AstNode, originalValues: ReadonlySet<string>): void {
  let leaked = false;
  for (const statement of programBody(file)) {
    const testCall = directTestCall(statement);
    if (!testCall) continue;
    visit(testCall, (node) => {
      const value = stringValue(node);
      if (
        value !== undefined &&
        [...originalValues].some(
          (original) => value === original || (original.length >= 4 && value.includes(original)),
        )
      ) {
        leaked = true;
      }
    });
  }
  if (leaked) {
    throw new CliError(
      'A recorded data-entry value was repeated elsewhere in the generated source; no replay was written.',
    );
  }
}

function assertSourcePrivacy(source: string): void {
  const decodedSlashes = source.replaceAll('\\/', '/');
  if (/(?:https?|file):\/\/|data:/iu.test(decodedSlashes)) {
    throw new CliError(
      'The sanitized recording still contains a literal URL; no replay was written.',
    );
  }
  const privacy = scanStructuredValue(
    { replay: decodedSlashes },
    { blockAt: 'medium', path: '$recording.replay' },
  );
  if (privacy.findings.length > 0) {
    throw new CliError(
      'The sanitized recording still contains private data; no replay was written.',
    );
  }
}

/**
 * Playwright rewrites its output after every recorded action. Pipe writes are concatenated on
 * POSIX, so the exact generated import header frames each complete snapshot. The final frame is
 * parsed and structurally validated before it can reach the sanitizer.
 */
export function extractLatestPlaywrightProgram(captured: string): string {
  let start = -1;
  for (const header of PLAYWRIGHT_TEST_HEADERS) {
    let cursor = captured.indexOf(header);
    while (cursor >= 0) {
      start = Math.max(start, cursor);
      cursor = captured.indexOf(header, cursor + header.length);
    }
  }
  if (start < 0) {
    throw new CliError('Playwright did not produce a complete TypeScript test recording.');
  }
  const program = captured.slice(start).trim();
  const parsed = parseSource(program);
  validatePlaywrightProgram(parsed);
  return `${program}\n`;
}

/**
 * Replace every recorded input value and every navigation target before any caller is allowed to
 * persist source. Structured arrays/objects retain their shape, but every scalar leaf becomes an
 * explicit environment fixture. A low-severity privacy postflight and literal-URL audit fail closed.
 */
export function sanitizePlaywrightRecording(source: string): SanitizedPlaywrightRecording {
  const parsed = parseSource(source);
  const playwrightImport = validatePlaywrightProgram(parsed);
  let helperCollision = false;
  visit(parsed, (node) => {
    if (node.type === 'Identifier' && HELPER_NAMES.has(identifierName(node) ?? '')) {
      helperCollision = true;
    }
  });
  if (helperCollision) {
    throw new CliError("Recorded source collides with Scenebook's fixture helper identifier.");
  }

  const state: SanitizationState = {
    inputIndex: 0,
    urlIndex: 0,
    placeholders: [],
    replacements: [],
    originalInputStrings: new Set(),
  };
  collectReplacements(parsed, state);
  let sanitized = applyReplacements(source, state.replacements);
  const importRange = nodeRange(playwrightImport);
  sanitized =
    sanitized.slice(0, importRange.end) + helperSource() + sanitized.slice(importRange.end);
  if (!sanitized.endsWith('\n')) sanitized += '\n';

  const postflight = parseSource(sanitized);
  validatePlaywrightProgram(postflight, { allowSanitizerHelpers: true });
  assertSanitizedCalls(postflight, state.placeholders);
  assertNoOriginalInputStrings(postflight, state.originalInputStrings);
  assertSourcePrivacy(sanitized);
  return { source: sanitized, placeholders: Object.freeze([...state.placeholders]) };
}

/**
 * Revalidate the exact recorder bytes immediately before deriving secondary artifacts. This is
 * deliberately separate from sanitization: review reports must never accept arbitrary source and
 * merely assume that another caller removed URLs and entered values first.
 */
export function validateSanitizedPlaywrightRecording(
  source: string,
  placeholders: readonly RecorderPlaceholder[],
): void {
  const parsed = parseSource(source);
  validatePlaywrightProgram(parsed, { allowSanitizerHelpers: true });
  assertSanitizedCalls(parsed, placeholders);
  assertSourcePrivacy(source);
}

class SnapshotFramer {
  readonly #chunks: Buffer[] = [];
  #preamble = Buffer.alloc(0);
  #unframedByteLength = 0;
  #byteLength = 0;
  #seenHeader = false;

  push(value: Buffer): void {
    const incoming = Buffer.from(value);
    const tail = this.#tail();
    const combined = Buffer.concat([tail, incoming]);
    let latest = -1;
    for (const header of HEADER_BUFFERS) {
      let cursor = combined.indexOf(header);
      while (cursor >= 0) {
        if (cursor + header.byteLength > tail.byteLength) latest = Math.max(latest, cursor);
        cursor = combined.indexOf(header, cursor + header.byteLength);
      }
    }

    tail.fill(0);
    if (latest >= 0) {
      const next = Buffer.from(combined.subarray(latest));
      this.clear();
      this.#seenHeader = true;
      this.#chunks.push(next);
      this.#byteLength = next.byteLength;
      incoming.fill(0);
    } else if (this.#seenHeader) {
      this.#chunks.push(incoming);
      this.#byteLength += incoming.byteLength;
    } else {
      this.#unframedByteLength += incoming.byteLength;
      this.#preamble.fill(0);
      this.#preamble = Buffer.from(
        combined.subarray(Math.max(0, combined.byteLength - MAX_HEADER_BYTES + 1)),
      );
      incoming.fill(0);
    }
    combined.fill(0);
    if (
      this.#byteLength > MAX_RECORDING_SOURCE_BYTES ||
      this.#unframedByteLength > MAX_RECORDING_SOURCE_BYTES
    ) {
      throw new CliError(`Playwright recording exceeds ${MAX_RECORDING_SOURCE_BYTES} bytes.`);
    }
  }

  finish(): string {
    if (!this.#seenHeader) {
      throw new CliError('Playwright did not return a TypeScript recording.');
    }
    const bytes = Buffer.concat(this.#chunks, this.#byteLength);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new CliError('Playwright recording is not valid UTF-8; no replay was written.');
    } finally {
      bytes.fill(0);
    }
  }

  clear(): void {
    for (const chunk of this.#chunks.splice(0)) chunk.fill(0);
    this.#preamble.fill(0);
    this.#preamble = Buffer.alloc(0);
    this.#unframedByteLength = 0;
    this.#byteLength = 0;
    this.#seenHeader = false;
  }

  #tail(): Buffer {
    const source = this.#seenHeader ? this.#chunks : [this.#preamble];
    const length = Math.min(
      MAX_HEADER_BYTES - 1,
      source.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    const result = Buffer.alloc(length);
    let remaining = length;
    for (let index = source.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = source[index];
      if (!chunk) continue;
      const take = Math.min(remaining, chunk.byteLength);
      chunk.copy(result, remaining - take, chunk.byteLength - take);
      remaining -= take;
    }
    return result;
  }
}

function closeResult(child: ChildProcess, command: string): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', (error) =>
      reject(new CliError(`Could not start Playwright recorder (${command}): ${error.message}`)),
    );
    child.once('close', (code, signal) => {
      if (signal) reject(new CliError(`Playwright recorder was terminated by ${signal}.`, 130));
      else resolve(code ?? 1);
    });
  });
}

function recorderInvocation(options: RecorderCaptureOptions): {
  readonly command: string;
  readonly prefix: readonly string[];
} {
  return options.command
    ? { command: options.command, prefix: [] }
    : { command: process.execPath, prefix: [playwrightCliPath()] };
}

function recorderArguments(
  options: ActiveCaptureOptions,
  output: string,
): { readonly command: string; readonly arguments: readonly string[] } {
  const invocation = recorderInvocation(options);
  return {
    command: invocation.command,
    arguments: [
      ...invocation.prefix,
      'codegen',
      '--target',
      'playwright-test',
      '--user-data-dir',
      options.profileDirectory,
      '--output',
      output,
      options.targetHref,
    ],
  };
}

async function capturePosix(options: ActiveCaptureOptions): Promise<string> {
  const fifoPath = join(options.childCwd, `.scenebook-codegen-${randomUUID()}.pipe`);
  const mkfifoCandidates = ['/usr/bin/mkfifo', '/bin/mkfifo', '/run/current-system/sw/bin/mkfifo'];
  const mkfifo = (
    await Promise.all(
      mkfifoCandidates.map(async (candidate) =>
        access(candidate, constants.X_OK).then(
          () => candidate,
          () => undefined,
        ),
      ),
    )
  ).find((candidate) => candidate !== undefined);
  if (!mkfifo) {
    throw new CliError('This platform cannot create the private Playwright source pipe.');
  }
  try {
    await execFileAsync(mkfifo, ['-m', '600', fifoPath], {
      cwd: options.childCwd,
      env: options.childEnv,
      windowsHide: true,
    });
  } catch {
    throw new CliError('Could not create the private Playwright source pipe.');
  }

  const state: { stopping: boolean; readerDone: boolean; error?: unknown } = {
    stopping: false,
    readerDone: false,
  };
  const framer = new SnapshotFramer();
  let child: ChildProcess | undefined;
  const reader = (async () => {
    try {
      while (true) {
        const handle = await open(fifoPath, constants.O_RDONLY);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let received = false;
        try {
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
            if (bytesRead === 0) break;
            received = true;
            framer.push(buffer.subarray(0, bytesRead));
          }
        } finally {
          buffer.fill(0);
          await handle.close();
        }
        if (state.stopping && !received) break;
        if (state.stopping) break;
      }
    } catch (error) {
      state.error = error;
      child?.kill('SIGTERM');
    } finally {
      state.readerDone = true;
    }
  })();

  const spawnProcess = options.spawnProcess ?? spawn;
  const invocation = recorderArguments(options, fifoPath);
  child = spawnProcess(invocation.command, [...invocation.arguments], {
    cwd: options.childCwd,
    env: options.childEnv,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });

  try {
    let code: number;
    try {
      code = await closeResult(child, invocation.command);
    } catch (error) {
      if (state.error) throw state.error;
      throw error;
    }
    state.stopping = true;
    if (!state.readerDone) {
      const sentinel = await open(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK).catch(
        () => undefined,
      );
      await sentinel?.close();
    }
    await reader;
    if (state.error) {
      throw state.error instanceof CliError
        ? state.error
        : new CliError('The private Playwright source pipe failed; no replay was written.');
    }
    if (code !== 0) throw new CliError(`Playwright recorder exited with code ${code}.`, code);
    return framer.finish();
  } finally {
    state.stopping = true;
    child.kill('SIGTERM');
    if (!state.readerDone) {
      const sentinel = await open(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK).catch(
        () => undefined,
      );
      await sentinel?.close();
    }
    await reader;
    framer.clear();
    await rm(fifoPath, { force: true }).catch(() => undefined);
  }
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function captureWindows(options: ActiveCaptureOptions): Promise<string> {
  const pipePath = `\\\\.\\pipe\\scenebook-codegen-${randomUUID()}`;
  const drainMarker = Buffer.from(`SCENEBOOK_PIPE_DRAIN_${randomUUID()}`);
  let resolveDrain: (() => void) | undefined;
  const drained = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  let child: ChildProcess | undefined;
  let latestSnapshot: Buffer | undefined;
  let streamError: unknown;
  const active = new Set<Promise<void>>();
  const server = createServer((socket: Socket) => {
    const complete = new Promise<void>((resolve) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (error !== undefined && streamError === undefined) streamError = error;
        if (error === undefined) {
          const snapshot = Buffer.concat(chunks, byteLength);
          if (snapshot.equals(drainMarker)) {
            snapshot.fill(0);
            resolveDrain?.();
          } else {
            latestSnapshot?.fill(0);
            latestSnapshot = snapshot;
          }
        }
        for (const chunk of chunks) chunk.fill(0);
        resolve();
      };
      socket.on('data', (value: Buffer) => {
        if (streamError) {
          value.fill(0);
          return;
        }
        const copy = Buffer.from(value);
        byteLength += copy.byteLength;
        if (byteLength > MAX_RECORDING_SOURCE_BYTES) {
          copy.fill(0);
          const error = new CliError(
            `Playwright recording exceeds ${MAX_RECORDING_SOURCE_BYTES} bytes.`,
          );
          streamError = error;
          child?.kill('SIGTERM');
          socket.destroy();
          finish(error);
          return;
        }
        chunks.push(copy);
      });
      socket.once('error', (error) => finish(error));
      socket.once('end', () => finish());
      socket.once('close', () => finish(streamError));
    });
    active.add(complete);
    void complete.then(() => active.delete(complete));
  });
  await listen(server, pipePath);
  const spawnProcess = options.spawnProcess ?? spawn;
  const invocation = recorderArguments(options, pipePath);
  child = spawnProcess(invocation.command, [...invocation.arguments], {
    cwd: options.childCwd,
    env: options.childEnv,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  try {
    let code: number;
    try {
      code = await closeResult(child, invocation.command);
    } catch (error) {
      if (streamError) throw streamError;
      throw error;
    }
    if (!streamError) {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(pipePath, () => socket.end(drainMarker));
        socket.once('error', reject);
        socket.once('close', resolve);
      });
      await drained;
    }
    await Promise.all([...active]);
    if (streamError) {
      throw streamError instanceof CliError
        ? streamError
        : new CliError('The private Playwright source pipe failed; no replay was written.');
    }
    if (code !== 0) throw new CliError(`Playwright recorder exited with code ${code}.`, code);
    if (!latestSnapshot) throw new CliError('Playwright did not return a TypeScript recording.');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(latestSnapshot);
    } catch {
      throw new CliError('Playwright recording is not valid UTF-8; no replay was written.');
    }
  } finally {
    drainMarker.fill(0);
    latestSnapshot?.fill(0);
    await closeServer(server).catch(() => undefined);
  }
}

function inheritedEnvironment(
  source: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const entries = Object.entries(source);
  for (const name of names) {
    const entry = entries.find(([key]) => key.toUpperCase() === name.toUpperCase());
    if (entry?.[1] !== undefined) result[entry[0]] = entry[1];
  }
  return result;
}

function browserRegistry(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
): string {
  if (source.PLAYWRIGHT_BROWSERS_PATH) {
    const configured = source.PLAYWRIGHT_BROWSERS_PATH;
    return configured === '0' || isAbsolute(configured) ? configured : resolve(cwd, configured);
  }
  const home = source.HOME ?? source.USERPROFILE ?? homedir();
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') {
    return join(source.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright');
  }
  return join(source.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright');
}

function isolatedRecorderEnvironment(
  source: NodeJS.ProcessEnv,
  sessionDirectory: string,
  platform: NodeJS.Platform,
  cwd: string,
): NodeJS.ProcessEnv {
  const env = inheritedEnvironment(source, [
    'ComSpec',
    'DBUS_SESSION_BUS_ADDRESS',
    'DISPLAY',
    'FONTCONFIG_FILE',
    'FONTCONFIG_PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LD_LIBRARY_PATH',
    'NIX_LD',
    'NIX_LD_LIBRARY_PATH',
    'PATH',
    'PATHEXT',
    'PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'SystemRoot',
    'TZ',
    'WAYLAND_DISPLAY',
    'WINDIR',
    'XAUTHORITY',
    'XDG_RUNTIME_DIR',
  ]);
  const privateHome = join(sessionDirectory, 'home');
  const privateTemp = join(sessionDirectory, 'tmp');
  const privateCache = join(sessionDirectory, 'cache');
  const privateConfig = join(sessionDirectory, 'config');
  const privateData = join(sessionDirectory, 'data');
  const privateState = join(sessionDirectory, 'state');
  return {
    ...env,
    APPDATA: join(privateHome, 'AppData', 'Roaming'),
    HOME: privateHome,
    LOCALAPPDATA: join(privateHome, 'AppData', 'Local'),
    LOGNAME: 'scenebook',
    NO_COLOR: '1',
    PLAYWRIGHT_BROWSERS_PATH: browserRegistry(source, platform, cwd),
    TEMP: privateTemp,
    TMP: privateTemp,
    TMPDIR: privateTemp,
    USER: 'scenebook',
    USERNAME: 'scenebook',
    USERPROFILE: privateHome,
    XDG_CACHE_HOME: privateCache,
    XDG_CONFIG_HOME: privateConfig,
    XDG_DATA_HOME: privateData,
    XDG_STATE_HOME: privateState,
  };
}

async function privateSessionDirectories(sessionDirectory: string): Promise<void> {
  await Promise.all(
    [
      'cache',
      'config',
      'data',
      'home',
      'home/AppData/Local',
      'home/AppData/Roaming',
      'profile',
      'state',
      'tmp',
    ].map((path) => mkdir(join(sessionDirectory, path), { recursive: true, mode: 0o700 })),
  );
}

/**
 * Capture into private pipes, with an isolated browser profile and temp/home directories. The raw
 * program and child output never touch a regular file; only the returned sanitized source may be
 * persisted. Cleanup failure is fatal because browser state can contain entered values.
 */
export async function captureSanitizedPlaywrightRecording(
  options: RecorderCaptureOptions,
): Promise<SanitizedPlaywrightRecording> {
  const target = prepareRecordingTarget(options.targetHref);
  const platform = options.platform ?? process.platform;
  const sessionDirectory = await mkdtemp(join(tmpdir(), 'scenebook-recorder-'));
  await chmod(sessionDirectory, 0o700);
  let cleanupError: unknown;
  try {
    await privateSessionDirectories(sessionDirectory);
    const active: ActiveCaptureOptions = {
      ...options,
      targetHref: target.href,
      childCwd: sessionDirectory,
      childEnv: isolatedRecorderEnvironment(options.env, sessionDirectory, platform, options.cwd),
      profileDirectory: join(sessionDirectory, 'profile'),
    };
    const raw = platform === 'win32' ? await captureWindows(active) : await capturePosix(active);
    return sanitizePlaywrightRecording(extractLatestPlaywrightProgram(raw));
  } finally {
    try {
      await rm(sessionDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new CliError(
        'Could not remove the private Playwright recording session; no replay was written.',
      );
    }
  }
}
