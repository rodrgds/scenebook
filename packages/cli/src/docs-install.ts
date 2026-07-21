import { open, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  buildDocsAdapter,
  DOCS_ADAPTERS,
  type DocsAdapterId,
  type GeneratedAdapterFile,
} from '@scenebook/adapters';
import { sha256 } from '@scenebook/core';
import { readBoundedRegularFileAtPath } from '@scenebook/playwright';
import { CliError } from './types.js';

const MAX_ADAPTER_FILES = 32;
const MAX_ADAPTER_FILE_BYTES = 256 * 1024;
const MAX_ADAPTER_TOTAL_BYTES = 1024 * 1024;

export interface DocsInstallResult {
  readonly adapter: DocsAdapterId;
  readonly destination: string;
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
  readonly dryRun: boolean;
}

function inside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  );
}

async function pathStatus(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function safeDirectory(
  canonicalRoot: string,
  directory: string,
  create: boolean,
): Promise<boolean> {
  if (!inside(canonicalRoot, directory)) {
    throw new CliError('Documentation adapter destination escapes the Scenebook project.');
  }
  const relation = relative(canonicalRoot, directory);
  let current = canonicalRoot;
  for (const segment of relation.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    let status = await pathStatus(current);
    if (!status) {
      if (!create) return false;
      await mkdir(current, { mode: 0o755 });
      status = await lstat(current);
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new CliError(`Documentation adapter path contains a non-directory or link: ${current}`);
    }
    const canonical = await realpath(current);
    if (!inside(canonicalRoot, canonical)) {
      throw new CliError('Documentation adapter path resolves outside the Scenebook project.');
    }
  }
  return true;
}

function validateGeneratedFiles(files: readonly GeneratedAdapterFile[]): void {
  if (files.length === 0 || files.length > MAX_ADAPTER_FILES) {
    throw new CliError(`Documentation adapter emitted an invalid file count (${files.length}).`);
  }
  let total = 0;
  const paths = new Set<string>();
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content);
    total += bytes;
    if (bytes > MAX_ADAPTER_FILE_BYTES || total > MAX_ADAPTER_TOTAL_BYTES) {
      throw new CliError('Documentation adapter output exceeds the bounded source-file limit.');
    }
    if (
      !file.path ||
      isAbsolute(file.path) ||
      file.path.includes('\\') ||
      file.path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
      /[\u0000-\u001f\u007f]/u.test(file.path)
    ) {
      throw new CliError(`Documentation adapter emitted an unsafe path: ${file.path}`);
    }
    if (paths.has(file.path)) {
      throw new CliError(`Documentation adapter emitted a duplicate path: ${file.path}`);
    }
    paths.add(file.path);
  }
}

async function existingDisposition(
  canonicalRoot: string,
  destination: string,
  file: GeneratedAdapterFile,
): Promise<'create' | 'unchanged'> {
  const target = resolve(destination, ...file.path.split('/'));
  if (!inside(destination, target) || !inside(canonicalRoot, target)) {
    throw new CliError(`Documentation adapter target escapes its destination: ${file.path}`);
  }
  if (!(await safeDirectory(canonicalRoot, resolve(target, '..'), false))) return 'create';
  const status = await pathStatus(target);
  if (!status) return 'create';
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new CliError(`Documentation adapter target is not a regular file: ${file.path}`);
  }
  if (status.size > MAX_ADAPTER_FILE_BYTES) {
    throw new CliError(`Documentation adapter target is too large to compare safely: ${file.path}`);
  }
  const current = await readBoundedRegularFileAtPath(target, {
    maximumBytes: MAX_ADAPTER_FILE_BYTES,
  });
  if (sha256(current.bytes) !== sha256(file.content)) {
    throw new CliError(
      `Refusing to overwrite ${file.path}; preserve the existing file and merge the generated integration manually.`,
    );
  }
  return 'unchanged';
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o644);
  try {
    await handle.writeFile(content);
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function installDocsAdapter(options: {
  readonly projectDirectory: string;
  readonly adapter: string;
  readonly basePath?: string;
  readonly destination?: string;
  readonly dryRun?: boolean;
}): Promise<DocsInstallResult> {
  if (!DOCS_ADAPTERS.includes(options.adapter as DocsAdapterId)) {
    throw new CliError(
      `Unsupported docs adapter ${options.adapter}. Expected one of: ${DOCS_ADAPTERS.join(', ')}.`,
    );
  }
  const adapter = options.adapter as DocsAdapterId;
  const canonicalRoot = await realpath(options.projectDirectory);
  const lexicalDestination = resolve(options.projectDirectory, options.destination ?? '.');
  const destinationRelation = relative(resolve(options.projectDirectory), lexicalDestination);
  if (
    destinationRelation === '..' ||
    destinationRelation.startsWith(`..${sep}`) ||
    isAbsolute(destinationRelation)
  ) {
    throw new CliError('Documentation adapter destination must stay inside the project.');
  }
  const destination = resolve(canonicalRoot, destinationRelation);
  await safeDirectory(canonicalRoot, destination, false);
  const files = buildDocsAdapter({
    adapter,
    ...(options.basePath ? { basePath: options.basePath } : {}),
  });
  validateGeneratedFiles(files);
  const planned = await Promise.all(
    files.map(async (file) => ({
      file,
      disposition: await existingDisposition(canonicalRoot, destination, file),
    })),
  );
  const created = planned
    .filter((entry) => entry.disposition === 'create')
    .map((entry) => entry.file.path);
  const unchanged = planned
    .filter((entry) => entry.disposition === 'unchanged')
    .map((entry) => entry.file.path);
  if (options.dryRun) {
    return { adapter, destination, created, unchanged, dryRun: true };
  }

  const written: Array<{ readonly path: string; readonly content: string }> = [];
  try {
    for (const entry of planned) {
      if (entry.disposition === 'unchanged') continue;
      const target = resolve(destination, ...entry.file.path.split('/'));
      await safeDirectory(canonicalRoot, resolve(target, '..'), true);
      await writeExclusive(target, entry.file.content);
      written.push({ path: target, content: entry.file.content });
    }
  } catch (error) {
    for (const file of written.reverse()) {
      const status = await pathStatus(file.path);
      if (!status?.isFile() || status.isSymbolicLink() || status.size > MAX_ADAPTER_FILE_BYTES)
        continue;
      const current = await readBoundedRegularFileAtPath(file.path, {
        maximumBytes: MAX_ADAPTER_FILE_BYTES,
      }).catch(() => undefined);
      if (current && sha256(current.bytes) === sha256(file.content)) {
        await rm(file.path, { force: true });
      }
    }
    throw error;
  }
  return { adapter, destination, created, unchanged, dryRun: false };
}
