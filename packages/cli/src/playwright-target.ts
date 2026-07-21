import { randomUUID } from 'node:crypto';
import { lstat, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Environment, RunTarget } from '@scenebook/schema';

import { CliError, type LoadedConfig } from './types.js';

export interface ResolvedPlaywrightTarget {
  readonly target: RunTarget;
  readonly environment: Environment;
  readonly baseUrl: string;
}

function canonicalBaseUrl(value: string, environmentId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(
      `Environment ${environmentId} requires an absolute HTTP(S) baseUrl for Playwright execution.`,
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new CliError(
      `Environment ${environmentId} has an unsafe Playwright baseUrl; use HTTP(S) without credentials or a fragment.`,
    );
  }
  return url.href;
}

export function resolvePlaywrightTarget(
  config: LoadedConfig,
  requestedTarget?: string,
): ResolvedPlaywrightTarget {
  let target: RunTarget | undefined;
  if (requestedTarget) {
    target = config.project.runTargets.find((candidate) => candidate.id === requestedTarget);
    if (!target) {
      const available = config.project.runTargets.map((candidate) => candidate.id).join(', ');
      throw new CliError(
        `Unknown Run Target ${requestedTarget}.${available ? ` Available: ${available}.` : ''}`,
      );
    }
    if (!target.enabled) throw new CliError(`Run Target ${target.id} is disabled.`);
  } else {
    const enabled = config.project.runTargets.filter((candidate) => candidate.enabled);
    if (enabled.length === 0) {
      throw new CliError(
        'No enabled Run Target is configured. Add one to the Project or choose an enabled --target.',
      );
    }
    if (enabled.length > 1) {
      throw new CliError(
        `Run Target selection is ambiguous (${enabled.map((candidate) => candidate.id).join(', ')}). Choose one with --target <id>.`,
      );
    }
    target = enabled[0];
  }
  if (!target) throw new CliError('Run Target selection failed closed.');

  const environment = config.project.environments.find(
    (candidate) => candidate.id === target.environmentId,
  );
  if (!environment) {
    throw new CliError(
      `Run Target ${target.id} references unknown Environment ${target.environmentId}.`,
    );
  }
  if (environment.kind === 'production' && config.config.playwright.forbidProductionMutations) {
    throw new CliError(
      `Run Target ${target.id} uses production Environment ${environment.id}, but playwright.forbidProductionMutations is enabled.`,
    );
  }
  if (!environment.allowMutations) {
    throw new CliError(
      `Environment ${environment.id} does not allow mutations; Scenebook Playwright execution is blocked.`,
    );
  }
  const baseUrl = canonicalBaseUrl(environment.baseUrl, environment.id);
  if (environment.kind === 'production' && new URL(baseUrl).protocol !== 'https:') {
    throw new CliError(`Production Environment ${environment.id} must use an HTTPS baseUrl.`);
  }
  return { target, environment, baseUrl };
}

export function playwrightTargetEnvironment(
  config: LoadedConfig,
  selection: ResolvedPlaywrightTarget,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    SCENEBOOK_PROJECT_ID: config.project.id,
    SCENEBOOK_RUN_TARGET_ID: selection.target.id,
    SCENEBOOK_ENVIRONMENT_ID: selection.environment.id,
    SCENEBOOK_ENVIRONMENT_KIND: selection.environment.kind,
    SCENEBOOK_BASE_URL: selection.baseUrl,
    SCENEBOOK_PRODUCT_VARIANT_ID: selection.target.productVariantId,
    SCENEBOOK_CAPTURE_PROFILE_ID: selection.target.captureProfileId,
    SCENEBOOK_MUTATIONS_ALLOWED: '1',
  };
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

async function configuredPlaywrightPath(config: LoadedConfig): Promise<string | undefined> {
  const reference = config.config.playwright.config;
  if (!reference) return undefined;
  const candidate = resolve(config.directory, reference);
  const status = await lstat(candidate).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`Playwright configuration file not found: ${candidate}`);
    }
    throw error;
  });
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new CliError(`Playwright configuration must be a regular non-symlink file: ${candidate}`);
  }
  const canonicalDirectory = await realpath(config.directory);
  const canonical = await realpath(candidate);
  if (!inside(canonicalDirectory, canonical)) {
    throw new CliError(`Playwright configuration escapes the Scenebook project: ${reference}`);
  }
  return canonical;
}

function wrapperSource(configPath: string | undefined): string {
  const imported = configPath
    ? `import originalConfig from ${JSON.stringify(pathToFileURL(configPath).href)};`
    : 'const originalConfig = {};';
  return `${imported}
const config = originalConfig;
if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('Scenebook requires the Playwright configuration to export an object.');
}
const expected = process.env.SCENEBOOK_BASE_URL;
const environmentKind = process.env.SCENEBOOK_ENVIRONMENT_KIND;
if (!expected) throw new Error('Scenebook target preflight did not bind SCENEBOOK_BASE_URL.');
const canonical = (value, label) => {
  if (typeof value !== 'string') throw new Error(label + ' baseURL must be a string.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(label + ' baseURL must be absolute.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(label + ' baseURL must use HTTP(S).');
  }
  return parsed.href;
};
const expectedCanonical = canonical(expected, 'Selected Environment');
const evidenceUse = (use) => ({
  ...(use ?? {}),
  baseURL: expectedCanonical,
  screenshot: 'on',
  trace: 'retain-on-failure',
});
const validateUse = (label, use) => {
  if (use?.baseURL !== undefined && canonical(use.baseURL, label) !== expectedCanonical) {
    throw new Error(label + ' baseURL ' + use.baseURL + ' disagrees with selected Scenebook Environment ' + expectedCanonical);
  }
};
validateUse('Playwright config', config.use);
for (const project of config.projects ?? []) validateUse('Playwright project ' + project.name, project.use);
const servers = config.webServer ? (Array.isArray(config.webServer) ? config.webServer : [config.webServer]) : [];
for (const server of servers) {
  if (server.url && new URL(server.url).origin !== new URL(expectedCanonical).origin) {
    throw new Error('Playwright webServer URL ' + server.url + ' disagrees with selected Scenebook Environment ' + expectedCanonical);
  }
  if (environmentKind !== 'local' && server.command) {
    throw new Error('A non-local Scenebook Environment cannot start a configured Playwright webServer command.');
  }
}
export default {
  ...config,
  use: evidenceUse(config.use),
  ...(config.projects ? {
    projects: config.projects.map((project) => ({
      ...project,
      use: evidenceUse(project.use),
    })),
  } : {}),
};
`;
}

export async function createPlaywrightSafetyConfig(config: LoadedConfig): Promise<{
  readonly path: string;
  cleanup(): Promise<void>;
}> {
  const configured = await configuredPlaywrightPath(config);
  const directory = configured ? dirname(configured) : config.directory;
  const path = resolve(directory, `.scenebook-${randomUUID()}.config.ts`);
  await writeFile(path, wrapperSource(configured), { flag: 'wx', mode: 0o600 });
  return {
    path,
    cleanup: () => rm(path, { force: true }),
  };
}
