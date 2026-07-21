import { sha256, stableStringify } from '@scenebook/core';
import { readBoundedRegularFileAtPath } from '@scenebook/playwright';
import { scanStructuredValue } from '@scenebook/privacy';
import { parse } from '@babel/parser';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { writeFileAtomically } from './atomic-write.js';
import {
  MAX_RECORDING_SOURCE_BYTES,
  type RecorderPlaceholder,
  validateSanitizedPlaywrightRecording,
} from './record-capture.js';
import { recordedSceneDirectory } from './record-scaffold.js';
import { CliError } from './types.js';

export const RECORDER_REVIEW_SCHEMA_VERSION = 1 as const;
export const MAX_RECORDER_REVIEW_BYTES = 4 * 1024 * 1024;

const ASSERTION_METHODS = new Set([
  'toBeAttached',
  'toBeChecked',
  'toBeDisabled',
  'toBeEditable',
  'toBeEmpty',
  'toBeEnabled',
  'toBeFocused',
  'toBeHidden',
  'toBeInViewport',
  'toBeVisible',
  'toContainText',
  'toHaveAccessibleDescription',
  'toHaveAccessibleName',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCount',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveRole',
  'toHaveText',
  'toHaveTitle',
  'toHaveURL',
  'toHaveValue',
  'toHaveValues',
  'toMatchAriaSnapshot',
  'toPass',
]);
const DATA_ENTRY_METHODS = new Set([
  'check',
  'fill',
  'insertText',
  'pressSequentially',
  'selectOption',
  'setChecked',
  'setInputFiles',
  'type',
  'uncheck',
]);
const NAVIGATION_METHODS = new Set(['goBack', 'goForward', 'goto', 'reload']);
const PRIMARY_INTERACTION_METHODS = new Set(['click', 'dblclick', 'dragTo', 'press', 'tap']);
const SECONDARY_INTERACTION_METHODS = new Set(['blur', 'focus', 'hover']);
const WAIT_METHODS = new Set([
  'waitFor',
  'waitForEvent',
  'waitForFunction',
  'waitForLoadState',
  'waitForNavigation',
  'waitForRequest',
  'waitForResponse',
  'waitForSelector',
  'waitForTimeout',
  'waitForURL',
]);
const LOCATOR_METHODS = new Set([
  '$',
  '$$',
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByTestId',
  'getByText',
  'getByTitle',
  'locator',
  'waitForSelector',
]);
const POSITIONAL_METHODS = new Set(['first', 'last', 'nth']);
const CONTROL_FLOW_NODES = new Set([
  'ConditionalExpression',
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'IfStatement',
  'SwitchStatement',
  'TryStatement',
  'WhileStatement',
]);

interface AstLocationPoint {
  readonly line: number;
  readonly column: number;
}

interface AstLocation {
  readonly start: AstLocationPoint;
  readonly end: AstLocationPoint;
}

interface AstNode {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly loc?: AstLocation | null;
  readonly [key: string]: unknown;
}

export type RecorderFileOperation = 'create' | 'replace';
export type RecorderReviewSeverity = 'info' | 'warning';

export interface RecorderReviewFinding {
  readonly id: string;
  readonly code: string;
  readonly severity: RecorderReviewSeverity;
  readonly line: number;
  readonly column: number;
  readonly method?: string;
  readonly message: string;
  readonly recommendation: string;
}

export interface RecorderStepSuggestion {
  readonly id: string;
  readonly kind: 'setup' | 'beat';
  readonly startLine: number;
  readonly endLine: number;
  readonly actionCount: number;
  readonly rationale: 'navigation-setup' | 'interaction' | 'form-outcome';
  readonly label: string;
  readonly patchIncluded: boolean;
}

export interface RecorderPatchEdit {
  readonly kind: 'insert-before-line';
  readonly byteOffset: number;
  readonly line: number;
  readonly text: string;
}

export interface RecorderReviewArtifact {
  readonly schemaVersion: typeof RECORDER_REVIEW_SCHEMA_VERSION;
  readonly kind: 'scenebook-recorder-review';
  readonly source: {
    readonly path: string;
    readonly format: 'playwright-test-typescript';
    readonly sha256: string;
    readonly byteLength: number;
    readonly lineCount: number;
    readonly sanitized: true;
    readonly integrityVerifiedAfterPersistence: true;
  };
  readonly placeholderFixtures: readonly RecorderPlaceholder[];
  readonly summary: {
    readonly actionStatements: number;
    readonly assertions: number;
    readonly suggestedSteps: number;
    readonly warnings: number;
    readonly infos: number;
  };
  readonly suggestedSteps: readonly RecorderStepSuggestion[];
  readonly findings: readonly RecorderReviewFinding[];
  readonly proposedPatch: {
    readonly path: string;
    readonly format: 'git-unified-diff-zero-context';
    readonly targetPath: string;
    readonly preconditionSha256: string;
    readonly resultSha256: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly hunkCount: number;
    readonly edits: readonly RecorderPatchEdit[];
    readonly appliesAutomatically: false;
  };
  readonly fileImpact: {
    readonly files: readonly (
      | {
          readonly path: string;
          readonly operation: RecorderFileOperation | 'unchanged';
          readonly sha256: string;
          readonly byteLength: number;
        }
      | {
          readonly path: string;
          readonly operation: RecorderFileOperation;
          readonly identity: 'this-report';
        }
    )[];
  };
}

export interface RecorderArtifactPaths {
  readonly projectDirectory: string;
  readonly sceneDirectory: string;
  readonly replayPath: string;
  readonly manifestPath: string;
  readonly reviewPath: string;
  readonly patchPath: string;
  readonly projectReplayRelativePath: string;
  readonly replayRelativePath: string;
  readonly reviewRelativePath: string;
  readonly patchRelativePath: string;
  readonly replayOperation: RecorderFileOperation;
  readonly reviewOperation: RecorderFileOperation;
  readonly patchOperation: RecorderFileOperation;
}

interface StatementAnalysis {
  readonly node: AstNode;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly methods: readonly string[];
  readonly kind: 'assertion' | 'input' | 'interaction' | 'navigation' | 'other' | 'wait';
}

interface StepGroup {
  readonly kind: RecorderStepSuggestion['kind'];
  readonly rationale: RecorderStepSuggestion['rationale'];
  readonly statements: readonly StatementAnalysis[];
}

interface Insertion {
  readonly offset: number;
  readonly line: number;
  readonly text: string;
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

function identifierName(node: unknown): string | undefined {
  return isNode(node) && node.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : undefined;
}

function stringValue(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return node.value;
  if (node.type !== 'TemplateLiteral') return undefined;
  const expressions = Array.isArray(node.expressions) ? node.expressions : [];
  const quasis = Array.isArray(node.quasis) ? node.quasis : [];
  if (expressions.length !== 0 || quasis.length !== 1 || !isNode(quasis[0]?.value)) {
    return undefined;
  }
  const value = quasis[0].value;
  return typeof value.cooked === 'string'
    ? value.cooked
    : typeof value.raw === 'string'
      ? value.raw
      : undefined;
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

function methodName(expression: unknown): string | undefined {
  if (!isNode(expression)) return undefined;
  if (expression.type !== 'MemberExpression' && expression.type !== 'OptionalMemberExpression') {
    return undefined;
  }
  if (expression.computed === true) return stringValue(expression.property);
  return identifierName(expression.property);
}

function line(node: AstNode): number {
  return node.loc?.start.line ?? 1;
}

function column(node: AstNode): number {
  return (node.loc?.start.column ?? 0) + 1;
}

function range(node: AstNode): { readonly start: number; readonly end: number } {
  if (
    typeof node.start !== 'number' ||
    typeof node.end !== 'number' ||
    node.start < 0 ||
    node.end < node.start
  ) {
    throw new CliError('Sanitized recorder source contains an unbounded syntax node.');
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
    throw new CliError('Sanitized recorder source is not valid TypeScript.');
  }
}

function programBody(file: AstNode): readonly AstNode[] {
  const program = isNode(file.program) ? file.program : undefined;
  return program && Array.isArray(program.body) ? program.body.filter(isNode) : [];
}

function testCallback(file: AstNode): AstNode {
  for (const statement of programBody(file)) {
    if (statement.type !== 'ExpressionStatement' || !isNode(statement.expression)) continue;
    const expression = statement.expression;
    if (!isCall(expression) || identifierName(callCallee(expression)) !== 'test') continue;
    const callback = callArguments(expression).find(
      (argument) =>
        argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression',
    );
    if (callback && isNode(callback.body) && callback.body.type === 'BlockStatement') {
      return callback;
    }
  }
  throw new CliError('Sanitized recorder source has no analyzable Playwright test callback.');
}

function callbackStatements(callback: AstNode): readonly AstNode[] {
  const body = isNode(callback.body) ? callback.body : undefined;
  return body && Array.isArray(body.body) ? body.body.filter(isNode) : [];
}

function collectedMethods(statement: AstNode): string[] {
  const methods: string[] = [];
  visit(statement, (node) => {
    if (!isCall(node)) return;
    const method = methodName(callCallee(node));
    if (method) methods.push(method);
  });
  return methods;
}

function containsExpect(statement: AstNode): boolean {
  let result = false;
  visit(statement, (node) => {
    if (identifierName(node) === 'expect') result = true;
  });
  return result;
}

function statementKind(statement: AstNode, methods: readonly string[]): StatementAnalysis['kind'] {
  if (containsExpect(statement) || methods.some((method) => ASSERTION_METHODS.has(method))) {
    return 'assertion';
  }
  if (methods.some((method) => NAVIGATION_METHODS.has(method))) return 'navigation';
  if (methods.some((method) => DATA_ENTRY_METHODS.has(method))) return 'input';
  if (
    methods.some(
      (method) =>
        PRIMARY_INTERACTION_METHODS.has(method) || SECONDARY_INTERACTION_METHODS.has(method),
    )
  ) {
    return 'interaction';
  }
  if (methods.some((method) => WAIT_METHODS.has(method))) return 'wait';
  return 'other';
}

function analyzeStatements(callback: AstNode): StatementAnalysis[] {
  return callbackStatements(callback).map((node) => {
    const bounded = range(node);
    const methods = collectedMethods(node);
    return {
      node,
      ...bounded,
      startLine: line(node),
      endLine: node.loc?.end.line ?? line(node),
      methods,
      kind: statementKind(node, methods),
    };
  });
}

function meaningful(statement: StatementAnalysis): boolean {
  return statement.kind !== 'other' || statement.methods.length > 0;
}

function stepGroups(statements: readonly StatementAnalysis[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let pendingInputs: StatementAnalysis[] = [];

  const flushInputs = (): void => {
    if (pendingInputs.length === 0) return;
    groups.push({ kind: 'beat', rationale: 'interaction', statements: pendingInputs });
    pendingInputs = [];
  };

  for (const statement of statements) {
    if (statement.kind === 'navigation') {
      flushInputs();
      groups.push({ kind: 'setup', rationale: 'navigation-setup', statements: [statement] });
      continue;
    }
    if (statement.kind === 'input') {
      pendingInputs.push(statement);
      continue;
    }
    if (statement.kind === 'interaction') {
      const primary = statement.methods.some((method) => PRIMARY_INTERACTION_METHODS.has(method));
      if (pendingInputs.length > 0 && primary) {
        groups.push({
          kind: 'beat',
          rationale: 'form-outcome',
          statements: [...pendingInputs, statement],
        });
        pendingInputs = [];
      } else {
        flushInputs();
        groups.push({ kind: 'beat', rationale: 'interaction', statements: [statement] });
      }
      continue;
    }
    if (statement.kind === 'wait' && pendingInputs.length > 0) {
      pendingInputs.push(statement);
      continue;
    }
    flushInputs();
  }
  flushInputs();
  return groups;
}

function finding(
  findings: RecorderReviewFinding[],
  code: string,
  severity: RecorderReviewSeverity,
  node: AstNode,
  message: string,
  recommendation: string,
  method?: string,
): void {
  findings.push({
    id: `${code}-${String(line(node)).padStart(4, '0')}-${String(column(node)).padStart(3, '0')}`,
    code,
    severity,
    line: line(node),
    column: column(node),
    ...(method ? { method } : {}),
    message,
    recommendation,
  });
}

function locatorFindings(file: AstNode, findings: RecorderReviewFinding[]): void {
  visit(file, (node) => {
    if (!isCall(node)) return;
    const method = methodName(callCallee(node));
    if (!method) return;
    if (POSITIONAL_METHODS.has(method)) {
      finding(
        findings,
        'locator.positional',
        'warning',
        node,
        'A positional locator can silently select a different element after layout changes.',
        'Replace the positional hop with a unique role, label, test ID, or scoped semantic locator.',
        method,
      );
      return;
    }
    if (method === 'locator' || method === '$' || method === '$$' || method === 'waitForSelector') {
      finding(
        findings,
        'locator.implementation-coupled',
        'warning',
        node,
        'This locator is coupled to implementation structure rather than user-facing semantics.',
        'Prefer getByRole, getByLabel, or an intentional test ID, scoped to a stable container.',
        method,
      );
      return;
    }
    if (!LOCATOR_METHODS.has(method)) return;
    const first = callArguments(node)[0];
    if (!first || stringValue(first) === undefined) {
      if (method === 'getByRole') {
        finding(
          findings,
          'locator.dynamic-role',
          'warning',
          node,
          'The recorded role locator is computed dynamically.',
          'Replace it with a reviewed literal role and a stable accessible-name constraint.',
          method,
        );
      }
      return;
    }
    if (method === 'getByText') {
      finding(
        findings,
        'locator.visible-text',
        'info',
        node,
        'Visible-text locators can drift when product copy or locale changes.',
        'Keep it when copy is the contract; otherwise prefer a role, label, or intentional test ID.',
        method,
      );
    }
    if (method === 'getByRole') {
      const options = callArguments(node)[1];
      let hasName = false;
      if (options?.type === 'ObjectExpression' && Array.isArray(options.properties)) {
        hasName = options.properties.some(
          (property) =>
            isNode(property) &&
            property.type === 'ObjectProperty' &&
            (identifierName(property.key) ?? stringValue(property.key)) === 'name',
        );
      }
      if (!hasName) {
        finding(
          findings,
          'locator.unnamed-role',
          'warning',
          node,
          'The role locator has no accessible-name constraint and may match multiple controls.',
          'Add a reviewed accessible name or scope the role locator to a stable region.',
          method,
        );
      }
    }
  });
}

function waitAndDynamicFindings(file: AstNode, findings: RecorderReviewFinding[]): void {
  visit(file, (node) => {
    if (CONTROL_FLOW_NODES.has(node.type)) {
      finding(
        findings,
        'flow.dynamic-control',
        'warning',
        node,
        'Dynamic control flow can make one recording represent different journeys across runs.',
        'Split variants explicitly or make the condition a reviewed fixture with separate Scenes.',
      );
      return;
    }
    if (!isCall(node)) return;
    const callee = callCallee(node);
    const method = methodName(callee);
    if (method === 'waitForTimeout') {
      finding(
        findings,
        'wait.fixed-timeout',
        'warning',
        node,
        'A fixed timeout is timing-dependent and slows successful runs.',
        'Wait for the expected visible state, URL, response, or assertion instead.',
        method,
      );
    } else if (method === 'waitForFunction') {
      finding(
        findings,
        'wait.page-function',
        'warning',
        node,
        'A page-function wait couples replay to custom runtime state.',
        'Prefer a locator assertion or a bounded public Playwright event.',
        method,
      );
    } else if (method === 'waitForLoadState') {
      const state = stringValue(callArguments(node)[0]);
      if (state === 'networkidle') {
        finding(
          findings,
          'wait.network-idle',
          'warning',
          node,
          'Network-idle waits are unstable in applications with polling or background requests.',
          'Assert the product state that proves this journey can continue.',
          method,
        );
      }
    } else if (method === 'random' && isNode(callee?.object)) {
      if (identifierName(callee.object) === 'Math') {
        finding(
          findings,
          'flow.randomness',
          'warning',
          node,
          'Runtime randomness makes recorded behavior and evidence non-deterministic.',
          'Bind the value through a deterministic fixture controlled by the Run Target.',
          method,
        );
      }
    } else if (method === 'now' && isNode(callee?.object)) {
      if (identifierName(callee.object) === 'Date') {
        finding(
          findings,
          'flow.clock',
          'warning',
          node,
          'The wall clock can change the journey and its captured evidence.',
          'Inject or freeze time through a deterministic fixture.',
          method,
        );
      }
    }
  });
}

function assertionFindings(
  statements: readonly StatementAnalysis[],
  findings: RecorderReviewFinding[],
  callback: AstNode,
): number {
  const assertions = statements.filter((statement) => statement.kind === 'assertion');
  const mutating = statements.filter(
    (statement) => statement.kind === 'input' || statement.kind === 'interaction',
  );
  if (assertions.length === 0) {
    finding(
      findings,
      'check.missing-outcome',
      'warning',
      callback,
      'The recorded happy path has no explicit Playwright outcome assertion.',
      'Add an expect assertion for the user-visible result before treating this Scene as verified.',
    );
  } else {
    const finalMutation = mutating.at(-1);
    const finalAssertion = assertions.at(-1);
    if (finalMutation && finalAssertion && finalAssertion.start < finalMutation.end) {
      finding(
        findings,
        'check.no-terminal-outcome',
        'warning',
        finalMutation.node,
        'The final mutating interaction is not followed by an outcome assertion.',
        'Assert the terminal user-visible result after the last interaction.',
      );
    }
  }
  return assertions.length;
}

function lineStart(source: string, offset: number): number {
  const previous = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return previous < 0 ? 0 : previous + 1;
}

function nextLineStart(source: string, offset: number): number {
  const newline = source.indexOf('\n', offset);
  return newline < 0 ? source.length : newline + 1;
}

function indentation(source: string, offset: number): string {
  const start = lineStart(source, offset);
  const prefix = source.slice(start, offset);
  return /^\s*$/u.test(prefix) ? prefix : '  ';
}

function patchInsertions(
  source: string,
  groups: readonly StepGroup[],
): {
  readonly insertions: readonly Insertion[];
  readonly suggestions: readonly RecorderStepSuggestion[];
} {
  const insertions: Insertion[] = [];
  const suggestions: RecorderStepSuggestion[] = [];
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  let beatIndex = 0;
  for (const [index, group] of groups.entries()) {
    const first = group.statements[0];
    const last = group.statements.at(-1);
    if (!first || !last) continue;
    const patchIncluded = group.kind === 'beat';
    const label =
      group.kind === 'setup'
        ? 'Review navigation setup'
        : group.rationale === 'form-outcome'
          ? `Suggested beat ${beatIndex + 1}: submit entered data`
          : `Suggested beat ${beatIndex + 1}: review interaction`;
    suggestions.push({
      id: `suggested-step-${String(index + 1).padStart(3, '0')}`,
      kind: group.kind,
      startLine: first.startLine,
      endLine: last.endLine,
      actionCount: group.statements.length,
      rationale: group.rationale,
      label,
      patchIncluded,
    });
    if (!patchIncluded) continue;
    beatIndex += 1;
    const indent = indentation(source, first.start);
    insertions.push({
      offset: lineStart(source, first.start),
      line: first.startLine,
      text: `${indent}await test.step(${JSON.stringify(label)}, async () => {${lineEnding}`,
    });
    insertions.push({
      offset: nextLineStart(source, last.end),
      line: last.endLine + 1,
      text: `${indent}});${lineEnding}`,
    });
  }
  return { insertions, suggestions };
}

function applyInsertions(source: string, insertions: readonly Insertion[]): string {
  let result = source;
  for (const insertion of [...insertions].sort((left, right) => right.offset - left.offset)) {
    result = result.slice(0, insertion.offset) + insertion.text + result.slice(insertion.offset);
  }
  return result;
}

function coalesceInsertions(insertions: readonly Insertion[]): Insertion[] {
  const result: Insertion[] = [];
  for (const insertion of [...insertions].sort((left, right) => left.offset - right.offset)) {
    const previous = result.at(-1);
    if (previous && previous.offset === insertion.offset) {
      result[result.length - 1] = {
        offset: previous.offset,
        line: previous.line,
        text: previous.text + insertion.text,
      };
    } else {
      result.push(insertion);
    }
  }
  return result;
}

function quotedGitPath(prefix: 'a' | 'b', path: string): string {
  const value = `${prefix}/${path}`;
  return /^[A-Za-z0-9._/-]+$/u.test(value) ? value : JSON.stringify(value);
}

function unifiedInsertionPatch(sourcePath: string, insertions: readonly Insertion[]): string {
  if (insertions.length === 0) return '';
  const ordered = [...insertions].sort(
    (left, right) => left.offset - right.offset || left.text.localeCompare(right.text),
  );
  let added = 0;
  const lines = [
    `diff --git ${quotedGitPath('a', sourcePath)} ${quotedGitPath('b', sourcePath)}`,
    `--- ${quotedGitPath('a', sourcePath)}`,
    `+++ ${quotedGitPath('b', sourcePath)}`,
  ];
  for (const insertion of ordered) {
    const insertedLines = insertion.text.endsWith('\n')
      ? insertion.text.slice(0, -1).split('\n')
      : insertion.text.split('\n');
    const oldAnchor = Math.max(0, insertion.line - 1);
    const newStart = oldAnchor + added + 1;
    lines.push(`@@ -${oldAnchor},0 +${newStart},${insertedLines.length} @@`);
    lines.push(...insertedLines.map((value) => `+${value}`));
    added += insertedLines.length;
  }
  return `${lines.join('\n')}\n`;
}

function compareFindings(left: RecorderReviewFinding, right: RecorderReviewFinding): number {
  return (
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code) ||
    left.id.localeCompare(right.id)
  );
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function portableRelative(parent: string, child: string): string {
  return relative(parent, child).replaceAll('\\', '/');
}

async function pathOperation(path: string): Promise<RecorderFileOperation> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink()) {
      throw new CliError(`Recorder artifact path cannot be a symlink: ${path}`);
    }
    if (!status.isFile()) {
      throw new CliError(`Recorder artifact path must be a regular file: ${path}`);
    }
    return 'replace';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'create';
    throw error;
  }
}

async function assertSafeAncestors(projectDirectory: string, path: string): Promise<void> {
  const parent = resolve(path, '..');
  const relativeParent = relative(projectDirectory, parent);
  if (!inside(projectDirectory, parent)) {
    throw new CliError('Recorder output must stay inside the current project directory.');
  }
  let cursor = projectDirectory;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    try {
      const status = await lstat(cursor);
      if (status.isSymbolicLink()) {
        throw new CliError(`Recorder output cannot traverse a symlink: ${cursor}`);
      }
      if (!status.isDirectory()) {
        throw new CliError(`Recorder output parent must be a directory: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  const physicalParent = await realpath(parent);
  if (physicalParent !== parent || !inside(projectDirectory, physicalParent)) {
    throw new CliError(`Recorder output parent is not a direct project directory: ${parent}`);
  }
}

/** Resolve every recorder-owned artifact and reject path escape or existing symlink targets. */
export async function prepareRecorderArtifactPaths(
  cwd: string,
  replayPath: string,
): Promise<RecorderArtifactPaths> {
  const logicalProjectDirectory = resolve(cwd);
  const logicalReplayPath = resolve(replayPath);
  if (!inside(logicalProjectDirectory, logicalReplayPath)) {
    throw new CliError('Recorder output must stay inside the current project directory.');
  }
  const projectDirectory = await realpath(cwd);
  const replay = resolve(projectDirectory, relative(logicalProjectDirectory, logicalReplayPath));
  const sceneDirectory = recordedSceneDirectory(replay);
  if (!inside(projectDirectory, replay) || !inside(projectDirectory, sceneDirectory)) {
    throw new CliError('Recorder output must stay inside the current project directory.');
  }
  const manifestPath = resolve(sceneDirectory, 'scene.yaml');
  const reviewPath = resolve(replay, '../recording-review.json');
  const patchPath = resolve(replay, '../recording-review.patch');
  const replayRelativePath = portableRelative(sceneDirectory, replay);
  if (!replayRelativePath.startsWith('automation/') || !replayRelativePath.endsWith('.ts')) {
    throw new CliError(
      'Recorder replay output must be a TypeScript file inside the Scene automation directory.',
    );
  }
  if (new Set([replay, manifestPath, reviewPath, patchPath]).size !== 4) {
    throw new CliError('Recorder replay and review artifact paths must be distinct.');
  }
  for (const path of [replay, manifestPath, reviewPath, patchPath]) {
    await assertSafeAncestors(projectDirectory, path);
  }
  const reviewRelativePath = portableRelative(sceneDirectory, reviewPath);
  const patchRelativePath = portableRelative(sceneDirectory, patchPath);
  const projectReplayRelativePath = portableRelative(projectDirectory, replay);
  const privacy = scanStructuredValue(
    {
      projectReplayRelativePath,
      replayRelativePath,
      reviewRelativePath,
      patchRelativePath,
    },
    { blockAt: 'medium', path: '$recorderPaths' },
  );
  if (privacy.status === 'blocked') {
    throw new CliError('Recorder artifact paths appear to contain private data.');
  }
  const [replayOperation, reviewOperation, patchOperation] = await Promise.all([
    pathOperation(replay),
    pathOperation(reviewPath),
    pathOperation(patchPath),
  ]);
  await pathOperation(manifestPath);
  return {
    projectDirectory,
    sceneDirectory,
    replayPath: replay,
    manifestPath,
    reviewPath,
    patchPath,
    projectReplayRelativePath,
    replayRelativePath,
    reviewRelativePath,
    patchRelativePath,
    replayOperation,
    reviewOperation,
    patchOperation,
  };
}

export interface WriteRecorderReviewOptions {
  readonly paths: RecorderArtifactPaths;
  readonly source: string;
  readonly placeholders: readonly RecorderPlaceholder[];
  readonly manifestCreated: boolean;
}

/**
 * Derive and atomically persist a deterministic, value-free review report plus a zero-context Git
 * patch. The patch is a proposal only: its exact source-hash precondition is recorded and the CLI
 * never applies it to executable truth.
 */
export async function writeRecorderReviewArtifacts(
  options: WriteRecorderReviewOptions,
): Promise<RecorderReviewArtifact> {
  validateSanitizedPlaywrightRecording(options.source, options.placeholders);
  await assertSafeAncestors(options.paths.projectDirectory, options.paths.replayPath);
  const persisted = await readBoundedRegularFileAtPath(options.paths.replayPath, {
    minimumBytes: 1,
    maximumBytes: MAX_RECORDING_SOURCE_BYTES,
  });
  const sourceBytes = Buffer.from(options.source, 'utf8');
  if (!Buffer.from(persisted.bytes).equals(sourceBytes)) {
    throw new CliError(
      'Recorder source changed before diagnostics; no review artifact was written.',
    );
  }

  const file = parseSource(options.source);
  const callback = testCallback(file);
  const statements = analyzeStatements(callback);
  const groups = stepGroups(statements);
  const findings: RecorderReviewFinding[] = [];
  locatorFindings(callback, findings);
  waitAndDynamicFindings(callback, findings);
  const assertionCount = assertionFindings(statements, findings, callback);
  findings.sort(compareFindings);

  const planned = patchInsertions(options.source, groups);
  const insertions = coalesceInsertions(planned.insertions);
  const proposedSource = applyInsertions(options.source, insertions);
  validateSanitizedPlaywrightRecording(proposedSource, options.placeholders);
  const sourceHash = sha256(sourceBytes);
  const proposedHash = sha256(proposedSource);
  const patch = unifiedInsertionPatch(options.paths.projectReplayRelativePath, insertions);
  const patchBytes = Buffer.from(patch, 'utf8');
  if (patchBytes.byteLength > MAX_RECORDER_REVIEW_BYTES) {
    throw new CliError('Recorder review patch exceeds its safe size limit.');
  }

  const manifest = await readBoundedRegularFileAtPath(options.paths.manifestPath, {
    minimumBytes: 1,
    maximumBytes: MAX_RECORDER_REVIEW_BYTES,
  });
  const patchEdits: RecorderPatchEdit[] = insertions.map((insertion) => ({
    kind: 'insert-before-line',
    byteOffset: Buffer.byteLength(options.source.slice(0, insertion.offset), 'utf8'),
    line: insertion.line,
    text: insertion.text,
  }));
  const warningCount = findings.filter((entry) => entry.severity === 'warning').length;
  const infoCount = findings.length - warningCount;
  const report: RecorderReviewArtifact = {
    schemaVersion: RECORDER_REVIEW_SCHEMA_VERSION,
    kind: 'scenebook-recorder-review',
    source: {
      path: options.paths.replayRelativePath,
      format: 'playwright-test-typescript',
      sha256: sourceHash,
      byteLength: sourceBytes.byteLength,
      lineCount: options.source.split('\n').length - (options.source.endsWith('\n') ? 1 : 0),
      sanitized: true,
      integrityVerifiedAfterPersistence: true,
    },
    placeholderFixtures: [...options.placeholders],
    summary: {
      actionStatements: statements.filter(meaningful).length,
      assertions: assertionCount,
      suggestedSteps: planned.suggestions.length,
      warnings: warningCount,
      infos: infoCount,
    },
    suggestedSteps: planned.suggestions,
    findings,
    proposedPatch: {
      path: options.paths.patchRelativePath,
      format: 'git-unified-diff-zero-context',
      targetPath: options.paths.projectReplayRelativePath,
      preconditionSha256: sourceHash,
      resultSha256: proposedHash,
      sha256: sha256(patchBytes),
      byteLength: patchBytes.byteLength,
      hunkCount: insertions.length,
      edits: patchEdits,
      appliesAutomatically: false,
    },
    fileImpact: {
      files: [
        {
          path: options.paths.replayRelativePath,
          operation: options.paths.replayOperation,
          sha256: sourceHash,
          byteLength: sourceBytes.byteLength,
        },
        {
          path: 'scene.yaml',
          operation: options.manifestCreated ? 'create' : 'unchanged',
          sha256: sha256(manifest.bytes),
          byteLength: manifest.bytes.byteLength,
        },
        {
          path: options.paths.patchRelativePath,
          operation: options.paths.patchOperation,
          sha256: sha256(patchBytes),
          byteLength: patchBytes.byteLength,
        },
        {
          path: options.paths.reviewRelativePath,
          operation: options.paths.reviewOperation,
          identity: 'this-report',
        },
      ],
    },
  };

  const privacy = scanStructuredValue(report, {
    blockAt: 'medium',
    path: '$recorderReview',
  });
  const patchPrivacy = scanStructuredValue(
    { patch },
    { blockAt: 'medium', path: '$recorderReviewPatch' },
  );
  if (
    privacy.status === 'blocked' ||
    patchPrivacy.status === 'blocked' ||
    /(?:https?|file):\/\//iu.test(patch)
  ) {
    throw new CliError(
      'Recorder diagnostics contain private data; no review artifact was written.',
    );
  }

  const reportBytes = Buffer.from(`${stableStringify(report, 2)}\n`);
  if (reportBytes.byteLength > MAX_RECORDER_REVIEW_BYTES) {
    throw new CliError('Recorder review report exceeds its safe size limit.');
  }
  for (const path of [options.paths.patchPath, options.paths.reviewPath]) {
    await assertSafeAncestors(options.paths.projectDirectory, path);
    const expectedOperation =
      path === options.paths.patchPath
        ? options.paths.patchOperation
        : options.paths.reviewOperation;
    if ((await pathOperation(path)) !== expectedOperation) {
      throw new CliError('Recorder review artifact path changed before persistence.');
    }
  }
  await writeFileAtomically(options.paths.patchPath, patchBytes, {
    mode: 0o600,
    directoryMode: 0o700,
  });
  const persistedPatch = await readBoundedRegularFileAtPath(options.paths.patchPath, {
    minimumBytes: 0,
    maximumBytes: MAX_RECORDER_REVIEW_BYTES,
  });
  if (!Buffer.from(persistedPatch.bytes).equals(patchBytes)) {
    throw new CliError('Recorder review patch changed during persistence.');
  }
  await writeFileAtomically(options.paths.reviewPath, reportBytes, {
    mode: 0o600,
    directoryMode: 0o700,
  });
  const persistedReport = await readBoundedRegularFileAtPath(options.paths.reviewPath, {
    minimumBytes: 1,
    maximumBytes: MAX_RECORDER_REVIEW_BYTES,
  });
  if (!Buffer.from(persistedReport.bytes).equals(reportBytes)) {
    throw new CliError('Recorder review report changed during persistence.');
  }
  await assertSafeAncestors(options.paths.projectDirectory, options.paths.reviewPath);
  await assertSafeAncestors(options.paths.projectDirectory, options.paths.patchPath);
  return report;
}
