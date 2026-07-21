import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import { slugify } from '@scenebook/core';
import { SCHEMA_VERSION, SceneSchema, serializeSceneYaml, type Scene } from '@scenebook/schema';
import type { ImportedPlaywrightScene, ImportedPlaywrightStep } from './types.js';

interface AstNode {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number; readonly column: number } } | null;
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function calleeName(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === 'Identifier') return typeof value.name === 'string' ? value.name : undefined;
  if (value.type === 'MemberExpression' || value.type === 'OptionalMemberExpression') {
    const owner = calleeName(value.object);
    const property =
      isNode(value.property) && typeof value.property.name === 'string'
        ? value.property.name
        : undefined;
    return owner && property ? `${owner}.${property}` : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === 'StringLiteral' && typeof value.value === 'string') return value.value;
  if (
    value.type === 'TemplateLiteral' &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 0
  ) {
    const quasi = Array.isArray(value.quasis) ? value.quasis[0] : undefined;
    if (isNode(quasi) && isNode(quasi.value) && typeof quasi.value.cooked === 'string')
      return quasi.value.cooked;
    const record = quasi as { value?: { cooked?: unknown } } | undefined;
    return typeof record?.value?.cooked === 'string' ? record.value.cooked : undefined;
  }
  return undefined;
}

function children(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    if (isNode(value)) result.push(value);
    else if (Array.isArray(value)) result.push(...value.filter(isNode));
  }
  return result;
}

function visit(node: AstNode, callback: (node: AstNode) => void): void {
  callback(node);
  for (const child of children(node)) visit(child, callback);
}

function callArguments(node: AstNode): readonly unknown[] {
  return Array.isArray(node.arguments) ? node.arguments : [];
}

function importedSteps(testCall: AstNode): ImportedPlaywrightStep[] {
  const steps: ImportedPlaywrightStep[] = [];
  const callback = callArguments(testCall).find(
    (argument) =>
      isNode(argument) && ['ArrowFunctionExpression', 'FunctionExpression'].includes(argument.type),
  );
  if (!isNode(callback)) return steps;
  visit(callback, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    if (calleeName(node.callee) !== 'test.step') return;
    const title = stringValue(callArguments(node)[0]);
    if (!title) return;
    steps.push({
      id: slugify(title),
      title,
      line: node.loc?.start.line ?? 1,
      column: (node.loc?.start.column ?? 0) + 1,
    });
  });
  return steps;
}

export async function importPlaywrightFile(path: string): Promise<ImportedPlaywrightScene[]> {
  const absolute = resolve(path);
  const source = await readFile(absolute, 'utf8');
  const file = parse(source, {
    sourceType: 'unambiguous',
    plugins: ['typescript', 'jsx', 'decorators-legacy'],
    errorRecovery: false,
  }) as unknown as AstNode;
  const scenes: ImportedPlaywrightScene[] = [];
  visit(file, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    const name = calleeName(node.callee);
    if (!['test', 'it', 'test.only', 'test.skip', 'it.only', 'it.skip'].includes(name ?? ''))
      return;
    const title = stringValue(callArguments(node)[0]);
    if (!title) return;
    scenes.push({
      id: slugify(title),
      title,
      file: absolute,
      line: node.loc?.start.line ?? 1,
      steps: importedSteps(node),
    });
  });
  return scenes;
}

export function importedSceneDraft(imported: ImportedPlaywrightScene, projectRoot: string): Scene {
  const linkedPath = relative(resolve(projectRoot), imported.file).replaceAll('\\', '/');
  if (linkedPath.startsWith('../'))
    throw new Error(`Imported Playwright file is outside the project: ${imported.file}`);
  const steps =
    imported.steps.length > 0
      ? imported.steps
      : [{ id: 'outcome', title: 'Verify the outcome', line: imported.line, column: 1 }];
  return SceneSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: imported.id,
    slug: slugify(imported.id),
    title: imported.title,
    status: 'draft',
    capability: 'monitored',
    steps: steps.map((step) => ({
      id: step.id,
      kind: 'explanation',
      title: step.title,
      source: { path: linkedPath, line: step.line, column: step.column },
    })),
    automation: {
      level: 'monitored',
      framework: 'playwright',
      linkedTest: { path: linkedPath, title: imported.title },
    },
  });
}

export async function writeImportedScene(
  imported: ImportedPlaywrightScene,
  outputRoot: string,
  projectRoot = process.cwd(),
): Promise<string> {
  const scene = importedSceneDraft(imported, projectRoot);
  const directory = join(resolve(outputRoot), `${scene.slug}.scene`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'scene.yaml');
  await writeFile(path, serializeSceneYaml(scene), { flag: 'wx' }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing imported Scene: ${path}`);
    }
    throw error;
  });
  return path;
}
