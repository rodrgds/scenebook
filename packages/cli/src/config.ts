import { constants as fsConstants } from 'node:fs';
import { access, lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import {
  ProjectSchema,
  ScenebookConfigSchema,
  parseConfigYaml,
  parseProjectYaml,
  type Project,
} from '@scenebook/schema';
import { CliError, type LoadedConfig } from './types.js';

const CONFIG_NAMES = [
  'scenebook.config.ts',
  'scenebook.config.mts',
  'scenebook.config.js',
  'scenebook.config.mjs',
  'scenebook.config.yaml',
  'scenebook.config.yml',
] as const;
const MAX_PROJECT_SIDECAR_BYTES = 2 * 1024 * 1024;

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function readProjectSidecar(
  directory: string,
  reference: string,
): Promise<{ readonly project: Project; readonly path: string }> {
  const candidate = resolve(directory, reference);
  if (!isInside(directory, candidate))
    throw new CliError(`Project sidecar escapes its project: ${reference}`);
  let status;
  try {
    status = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`Project sidecar not found: ${reference}`);
    }
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new CliError(
      `Project sidecar must be a regular file and not a symbolic link: ${reference}`,
    );
  }
  if (status.size > MAX_PROJECT_SIDECAR_BYTES) {
    throw new CliError(
      `Project sidecar exceeds the ${MAX_PROJECT_SIDECAR_BYTES}-byte input limit: ${reference}`,
    );
  }
  const canonical = await realpath(candidate);
  if (!isInside(directory, canonical))
    throw new CliError(`Project sidecar escapes its project: ${reference}`);
  const handle = await open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== status.size) {
      throw new CliError(`Project sidecar changed while it was being loaded: ${reference}`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new CliError(`Project sidecar changed while it was being loaded: ${reference}`);
      }
      offset += result.bytesRead;
    }
    const trailing = await handle.read(Buffer.allocUnsafe(1), 0, 1, bytes.byteLength);
    if (trailing.bytesRead > 0) {
      throw new CliError(`Project sidecar changed while it was being loaded: ${reference}`);
    }
    return { project: parseProjectYaml(bytes.toString('utf8')), path: canonical };
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findConfig(cwd: string, explicit?: string): Promise<string | undefined> {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!(await exists(path))) throw new CliError(`Configuration file not found: ${path}`);
    return path;
  }
  let directory = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = resolve(directory, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function loadConfig(cwd: string, explicit?: string): Promise<LoadedConfig> {
  const path = await findConfig(cwd, explicit);
  if (!path) throw new CliError('No Scenebook configuration found. Run `scenebook init` first.');
  let value: unknown;
  if (/\.ya?ml$/u.test(path)) {
    value = parseConfigYaml(await readFile(path, 'utf8'));
  } else {
    const jiti = createJiti(pathToFileURL(path).href, { interopDefault: true });
    value = await jiti.import(path, { default: true });
  }
  const directory = await realpath(dirname(path));
  const config = ScenebookConfigSchema.parse(value);
  const sidecar =
    typeof config.project === 'string'
      ? await readProjectSidecar(directory, config.project)
      : undefined;
  const project = sidecar?.project ?? ProjectSchema.parse(config.project);
  return {
    path,
    directory,
    config,
    project,
    ...(sidecar ? { projectPath: sidecar.path } : {}),
  };
}

