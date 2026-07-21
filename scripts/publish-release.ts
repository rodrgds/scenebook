import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  deriveReleaseMetadata,
  discoverPublicPackages,
  metadataMatches,
  readManifest,
  workspaceRoot,
} from './release-packages';

interface PackedPackage {
  name: string;
  version: string;
  relativeDirectory: string;
  filename: string;
  bytes: number;
  sha256: string;
  integrity: string;
}

interface ReleaseManifest {
  schemaVersion: 1;
  bunVersion: string;
  packages: PackedPackage[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function command(name: string, args: string[], quiet = false): Promise<CommandResult> {
  const child = Bun.spawn([name, ...args], {
    cwd: workspaceRoot,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!quiet) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  return { stdout, stderr, exitCode };
}

function requireCommand(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) throw new Error(`${label} exited ${result.exitCode}`);
}

export function assertPublishEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true') {
    throw new Error('Publishing is allowed only inside the protected GitHub Actions workflow');
  }
  if (env.GITHUB_REF !== 'refs/heads/main' || !/^[0-9a-f]{40}$/u.test(env.GITHUB_SHA ?? '')) {
    throw new Error('Publishing requires an exact main-branch GitHub commit');
  }
  if (env.SCENEBOOK_RELEASE_CONFIRM !== 'PUBLISH') {
    throw new Error('Publishing requires the exact manual confirmation PUBLISH');
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('Publishing requires GitHub OIDC id-token: write permission');
  }
  if (env.NODE_AUTH_TOKEN || env.NPM_TOKEN) {
    throw new Error(
      'Long-lived npm tokens are rejected; configure npm trusted publishing with GitHub OIDC',
    );
  }
  if (env.NPM_CONFIG_PROVENANCE !== 'true') {
    throw new Error('NPM_CONFIG_PROVENANCE=true is required');
  }
}

async function publishedIntegrity(name: string, version: string): Promise<string | undefined> {
  const result = await command(
    'npm',
    ['view', `${name}@${version}`, 'dist.integrity', '--json'],
    true,
  );
  if (result.exitCode === 0) {
    const value = JSON.parse(result.stdout) as unknown;
    if (typeof value !== 'string' || !value.startsWith('sha512-')) {
      throw new Error(`npm returned invalid integrity metadata for ${name}@${version}`);
    }
    return value;
  }
  if (/E404|404 Not Found|is not in this registry/iu.test(`${result.stdout}\n${result.stderr}`)) {
    return undefined;
  }
  throw new Error(
    `Unable to check npm publication state for ${name}@${version}: ${result.stderr.trim()}`,
  );
}

async function tarManifest(tarball: string): Promise<string> {
  const result = await command('tar', ['-xOzf', tarball, 'package/package.json'], true);
  requireCommand(result, `read ${basename(tarball)} package.json`);
  return result.stdout;
}

export async function publishRelease(manifestPath: string): Promise<void> {
  assertPublishEnvironment(process.env);
  if (Bun.version !== '1.3.3') {
    throw new Error(`Publishing requires Bun 1.3.3 exactly; found ${Bun.version}`);
  }
  const absoluteManifest = isAbsolute(manifestPath)
    ? resolve(manifestPath)
    : resolve(workspaceRoot, manifestPath);
  const releaseRoot = resolve(workspaceRoot, '.release');
  if (!absoluteManifest.startsWith(`${releaseRoot}${sep}`)) {
    throw new Error('Release manifest must be inside .release');
  }
  const manifest = JSON.parse(await readFile(absoluteManifest, 'utf8')) as ReleaseManifest;
  if (manifest.schemaVersion !== 1 || manifest.bunVersion !== '1.3.3') {
    throw new Error('Unsupported or incorrectly packed release manifest');
  }

  const root = await readManifest(join(workspaceRoot, 'package.json'));
  const packages = await discoverPublicPackages();
  if (manifest.packages.length !== packages.length) {
    throw new Error('Release manifest does not contain the complete public package set');
  }
  const tarballDirectory = dirname(absoluteManifest);
  for (let index = 0; index < packages.length; index += 1) {
    const source = packages[index]!;
    const packed = manifest.packages[index]!;
    if (packed.name !== source.manifest.name || packed.version !== source.manifest.version) {
      throw new Error(`Release manifest package order or identity differs at position ${index}`);
    }
    const expectedMetadata = deriveReleaseMetadata(root, source);
    if (!metadataMatches(source.manifest, expectedMetadata)) {
      throw new Error(`${source.manifest.name} release metadata is not synchronized`);
    }
    if (packed.filename !== basename(packed.filename) || !packed.filename.endsWith('.tgz')) {
      throw new Error(`${source.manifest.name} has an unsafe tarball filename`);
    }
    const tarball = join(tarballDirectory, packed.filename);
    const bytes = await readFile(tarball);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (
      bytes.byteLength !== packed.bytes ||
      sha256 !== packed.sha256 ||
      integrity !== packed.integrity
    ) {
      throw new Error(`${source.manifest.name} tarball changed after verification`);
    }
    const packedManifestText = await tarManifest(tarball);
    if (packedManifestText.includes('workspace:')) {
      throw new Error(`${source.manifest.name} tarball contains a workspace: dependency`);
    }
    const packedManifest = JSON.parse(packedManifestText) as typeof source.manifest;
    if (
      packedManifest.name !== source.manifest.name ||
      packedManifest.version !== source.manifest.version ||
      !metadataMatches(packedManifest, expectedMetadata)
    ) {
      throw new Error(`${source.manifest.name} tarball metadata changed after verification`);
    }
  }

  const states = new Map<string, string | undefined>();
  for (const packed of manifest.packages) {
    states.set(packed.name, await publishedIntegrity(packed.name, packed.version));
  }
  for (const packed of manifest.packages) {
    const current = states.get(packed.name);
    if (current && current !== packed.integrity) {
      throw new Error(
        `${packed.name}@${packed.version} already exists on npm with different integrity`,
      );
    }
  }

  for (const packed of manifest.packages) {
    if (states.get(packed.name) === packed.integrity) {
      console.log(`already published with matching integrity: ${packed.name}@${packed.version}`);
      continue;
    }
    const tarball = join(tarballDirectory, packed.filename);
    const result = await command('npm', ['publish', tarball, '--access', 'public', '--provenance']);
    requireCommand(result, `publish ${packed.name}@${packed.version}`);
  }
}

if (import.meta.main) {
  const manifestIndex = process.argv.indexOf('--manifest');
  const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
  if (!manifestPath || manifestPath.startsWith('--')) {
    throw new Error(
      'Usage: bun scripts/publish-release.ts --manifest .release/tarballs/release-manifest.json',
    );
  }
  await publishRelease(manifestPath);
}
