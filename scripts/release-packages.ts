import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const APACHE_LICENSE = 'Apache-2.0';
export const AGPL_LICENSE = 'AGPL-3.0-only';
export const SERVER_PACKAGE = '@scenebook/server';

const LICENSE_BY_PACKAGE = new Map<string, typeof APACHE_LICENSE | typeof AGPL_LICENSE>([
  ['@scenebook/adapters', APACHE_LICENSE],
  ['@scenebook/artifact', APACHE_LICENSE],
  ['@scenebook/cli', APACHE_LICENSE],
  ['@scenebook/compiler', APACHE_LICENSE],
  ['@scenebook/core', APACHE_LICENSE],
  ['@scenebook/diff', APACHE_LICENSE],
  ['@scenebook/playwright', APACHE_LICENSE],
  ['@scenebook/policy', APACHE_LICENSE],
  ['@scenebook/privacy', APACHE_LICENSE],
  ['@scenebook/schema', APACHE_LICENSE],
  [SERVER_PACKAGE, AGPL_LICENSE],
  ['@scenebook/viewer', APACHE_LICENSE],
]);

export interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  description?: string;
  source?: string;
  files?: string[];
  bin?: string | Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: { access?: string; provenance?: boolean };
  repository?: string | { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: string | { url?: string; email?: string };
  [key: string]: unknown;
}

export interface ReleasePackage {
  directory: string;
  relativeDirectory: string;
  manifestPath: string;
  manifest: PackageManifest;
}

export interface ReleaseMetadata {
  repository: { type: 'git'; url: string; directory: string };
  homepage: string;
  bugs: { url: string };
}

export async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
}

export async function discoverPublicPackages(root = workspaceRoot): Promise<ReleasePackage[]> {
  const packagesDirectory = join(root, 'packages');
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const packages: ReleasePackage[] = [];

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(packagesDirectory, entry.name);
    const manifestPath = join(directory, 'package.json');
    let manifest: PackageManifest;
    try {
      manifest = await readManifest(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.private === true) continue;
    packages.push({
      directory,
      relativeDirectory: relative(root, directory),
      manifestPath,
      manifest,
    });
  }

  return topologicalPackageOrder(packages);
}

export function topologicalPackageOrder(packages: ReleasePackage[]): ReleasePackage[] {
  const byName = new Map(packages.map((item) => [item.manifest.name, item]));
  if (byName.size !== packages.length) throw new Error('Public package names must be unique');

  const dependencies = new Map<string, Set<string>>();
  for (const item of packages) {
    const names = new Set<string>();
    for (const group of [item.manifest.dependencies, item.manifest.optionalDependencies]) {
      for (const name of Object.keys(group ?? {})) if (byName.has(name)) names.add(name);
    }
    dependencies.set(item.manifest.name, names);
  }

  const ordered: ReleasePackage[] = [];
  const remaining = new Set(byName.keys());
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) =>
        [...(dependencies.get(name) ?? [])].every((dependency) => !remaining.has(dependency)),
      )
      .sort((left, right) => left.localeCompare(right));
    if (ready.length === 0) {
      throw new Error(`Public package dependency cycle: ${[...remaining].sort().join(', ')}`);
    }
    for (const name of ready) {
      ordered.push(byName.get(name)!);
      remaining.delete(name);
    }
  }
  return ordered;
}

function checkedHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing`);
  if (/[<>{}]|example\.(?:com|org)|(?:todo|changeme|placeholder)/iu.test(value)) {
    throw new Error(`${label} contains a placeholder`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const hostname = url.hostname.toLowerCase();
  const reservedHostname =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.example') ||
    /^127\./u.test(hostname) ||
    /^10\./u.test(hostname) ||
    /^192\.168\./u.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname) ||
    hostname === '[::1]';
  if (url.protocol !== 'https:' || url.username || url.password || reservedHostname) {
    throw new Error(`${label} must be a credential-free public HTTPS URL`);
  }
  return value;
}

function checkedRepository(root: PackageManifest): { type: 'git'; url: string } {
  const repository = root.repository;
  const type = typeof repository === 'object' ? repository.type : 'git';
  const rawUrl = typeof repository === 'string' ? repository : repository?.url;
  if (type !== 'git') throw new Error('root package.json repository.type must be "git"');
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('root package.json repository is missing');
  }
  if (/[<>{}]|example\.(?:com|org)|(?:todo|changeme|placeholder)/iu.test(rawUrl)) {
    throw new Error('root package.json repository contains a placeholder');
  }
  const httpsUrl = rawUrl.startsWith('git+https:') ? rawUrl.slice(4) : rawUrl;
  checkedHttpsUrl(httpsUrl, 'root package.json repository.url');
  return { type: 'git', url: rawUrl };
}

export function deriveReleaseMetadata(
  root: PackageManifest,
  item: Pick<ReleasePackage, 'relativeDirectory'>,
): ReleaseMetadata {
  const repository = checkedRepository(root);
  const homepage = checkedHttpsUrl(root.homepage, 'root package.json homepage');
  const rootBugs = typeof root.bugs === 'string' ? root.bugs : root.bugs?.url;
  const bugs = checkedHttpsUrl(rootBugs, 'root package.json bugs.url');
  return {
    repository: { ...repository, directory: item.relativeDirectory },
    homepage,
    bugs: { url: bugs },
  };
}

export function expectedLicense(name: string): typeof APACHE_LICENSE | typeof AGPL_LICENSE {
  const license = LICENSE_BY_PACKAGE.get(name);
  if (!license) throw new Error(`No release license mapping is configured for ${name}`);
  return license;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function metadataMatches(manifest: PackageManifest, expected: ReleaseMetadata): boolean {
  return (
    stableJson(manifest.repository) === stableJson(expected.repository) &&
    manifest.homepage === expected.homepage &&
    stableJson(manifest.bugs) === stableJson(expected.bugs)
  );
}
