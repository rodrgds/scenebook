import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  APACHE_LICENSE,
  AGPL_LICENSE,
  SERVER_PACKAGE,
  deriveReleaseMetadata,
  discoverPublicPackages,
  expectedLicense,
  metadataMatches,
  readManifest,
  stableJson,
  workspaceRoot,
  type PackageManifest,
  type ReleasePackage,
} from './release-packages';

interface PackedPackage {
  name: string;
  version: string;
  relativeDirectory: string;
  tarball: string;
  filename: string;
  bytes: number;
  sha256: string;
  integrity: string;
}

interface ReleaseManifest {
  schemaVersion: 1;
  bunVersion: string;
  packages: Array<Omit<PackedPackage, 'tarball'>>;
}

const args = new Set(process.argv.slice(2));
const strictMetadata = args.has('--strict-metadata');
const keep = args.has('--keep');
const outputFlagIndex = process.argv.indexOf('--output');
const outputValue = outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : undefined;
const REQUIRED_SERVER_MIGRATION = '0009_custom_domains.sql';
if (outputFlagIndex >= 0 && (!outputValue || outputValue.startsWith('--'))) {
  throw new Error('--output requires a directory');
}
for (const arg of args) {
  if (arg.startsWith('--') && !['--strict-metadata', '--keep', '--output'].includes(arg)) {
    throw new Error(`Unknown option ${arg}`);
  }
}

function hash(
  bytes: Uint8Array,
  algorithm: 'sha256' | 'sha512',
  encoding: 'hex' | 'base64',
): string {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function run(
  command: string,
  commandArgs: string[],
  options: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([command, ...commandArgs], {
    cwd: options.cwd ?? workspaceRoot,
    env: { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!options.quiet) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  if (exitCode !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited ${exitCode}`);
  }
  return { stdout, stderr };
}

async function runTarText(tarball: string, member?: string): Promise<string> {
  const args = member ? ['-xOzf', tarball, member] : ['-tzf', tarball];
  return (await run('tar', args, { quiet: true })).stdout;
}

function assertSafeMembers(entries: string[], item: ReleasePackage): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !entry.startsWith('package/') ||
      entry.includes('\\') ||
      entry.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new Error(`${item.manifest.name} tarball contains unsafe member ${entry}`);
    }
    if (seen.has(entry)) throw new Error(`${item.manifest.name} tarball repeats member ${entry}`);
    seen.add(entry);
  }
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  throw new Error(`Package exports contain an unsupported ${typeof value} target`);
}

function publicEntryPoints(manifest: PackageManifest): string[] {
  const exports = manifest.exports;
  if (typeof exports === 'string' || Array.isArray(exports)) return [manifest.name];
  if (!exports || typeof exports !== 'object') {
    throw new Error(`${manifest.name} must declare package exports`);
  }
  const keys = Object.keys(exports);
  const subpaths = keys.filter((key) => key.startsWith('.'));
  if (subpaths.length === 0) return [manifest.name];
  if (subpaths.length !== keys.length) {
    throw new Error(`${manifest.name} mixes subpath exports with root export conditions`);
  }
  return subpaths.map((key) => {
    if (key !== '.' && !key.startsWith('./')) {
      throw new Error(`${manifest.name} has an invalid export key ${key}`);
    }
    if (key.includes('*')) {
      throw new Error(`${manifest.name} export patterns require explicit release smoke fixtures`);
    }
    return key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`;
  });
}

async function serverMigrationFiles(item: ReleasePackage): Promise<string[]> {
  const entries = await readdir(join(item.directory, 'migrations'), { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  if (migrations.length === 0) throw new Error(`${SERVER_PACKAGE} has no SQL migrations`);
  if (!migrations.includes(REQUIRED_SERVER_MIGRATION)) {
    throw new Error(`${SERVER_PACKAGE} is missing ${REQUIRED_SERVER_MIGRATION}`);
  }
  return migrations;
}

async function validateSourcePackage(
  item: ReleasePackage,
  root: PackageManifest,
  metadataConfigured: boolean,
): Promise<void> {
  const { manifest } = item;
  if (!/^@scenebook\/[a-z0-9-]+$/u.test(manifest.name)) {
    throw new Error(`${item.relativeDirectory} has an invalid public package name`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error(`${manifest.name} has an invalid release version`);
  }
  if (manifest.license !== expectedLicense(manifest.name)) {
    throw new Error(`${manifest.name} must declare ${expectedLicense(manifest.name)}`);
  }
  if (!manifest.description || !manifest.exports) {
    throw new Error(`${manifest.name} requires description and exports metadata`);
  }
  if (manifest.source !== './src/index.ts') {
    throw new Error(`${manifest.name} must identify ./src/index.ts as its source entry`);
  }
  for (const required of ['dist', 'src', 'README.md', 'LICENSE']) {
    if (!manifest.files?.includes(required)) {
      throw new Error(`${manifest.name} package files must include ${required}`);
    }
  }
  if (manifest.name === SERVER_PACKAGE && !manifest.files?.includes('migrations')) {
    throw new Error(
      `${SERVER_PACKAGE} must distribute its SQL migrations with corresponding source`,
    );
  }
  if (manifest.name === SERVER_PACKAGE) await serverMigrationFiles(item);
  if (
    manifest.name === SERVER_PACKAGE &&
    (!manifest.files?.includes('tsconfig.json') || !manifest.files.includes('tsconfig.build.json'))
  ) {
    throw new Error(`${SERVER_PACKAGE} must distribute self-contained source build configuration`);
  }
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig.provenance !== true) {
    throw new Error(`${manifest.name} must require public provenance publication`);
  }
  await Promise.all(
    ['dist/index.js', 'src/index.ts', 'README.md', 'LICENSE'].map((path) =>
      access(join(item.directory, path)),
    ),
  );
  const readme = await readFile(join(item.directory, 'README.md'), 'utf8');
  if (!readme.includes(manifest.name) || !readme.includes(manifest.license)) {
    throw new Error(`${manifest.name} README must identify the package and its license`);
  }
  const canonicalLicense = await readFile(
    join(workspaceRoot, manifest.license === AGPL_LICENSE ? 'LICENSE-AGPL' : 'LICENSE-APACHE'),
  );
  const packageLicense = await readFile(join(item.directory, 'LICENSE'));
  if (!canonicalLicense.equals(packageLicense)) {
    throw new Error(`${manifest.name} LICENSE is not the canonical ${manifest.license} text`);
  }
  for (const group of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.devDependencies,
  ]) {
    for (const [name, range] of Object.entries(group ?? {})) {
      if (name.startsWith('@scenebook/') && range !== 'workspace:*') {
        throw new Error(
          `${manifest.name} must use workspace:* for internal source dependency ${name}`,
        );
      }
    }
  }
  if (metadataConfigured) {
    const expected = deriveReleaseMetadata(root, item);
    if (!metadataMatches(manifest, expected)) {
      throw new Error(
        `${manifest.name} repository/homepage/bugs metadata is stale; run bun run release:metadata:write`,
      );
    }
  }
}

async function packAndValidate(
  item: ReleasePackage,
  packagesByName: Map<string, ReleasePackage>,
  destination: string,
  metadataConfigured: boolean,
): Promise<PackedPackage> {
  const before = new Set(await Array.fromAsync(new Bun.Glob('*.tgz').scan({ cwd: destination })));
  await run('bun', ['pm', 'pack', '--quiet', '--destination', destination], {
    cwd: item.directory,
  });
  const after = await Array.fromAsync(new Bun.Glob('*.tgz').scan({ cwd: destination }));
  const created = after.filter((name) => !before.has(name));
  if (created.length !== 1) {
    throw new Error(`${item.manifest.name} pack created ${created.length} tarballs instead of one`);
  }
  const filename = created[0]!;
  const tarball = join(destination, filename);
  const entries = (await runTarText(tarball)).trim().split('\n').filter(Boolean);
  assertSafeMembers(entries, item);
  for (const required of [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/src/index.ts',
    'package/dist/index.js',
  ]) {
    if (!entries.includes(required))
      throw new Error(`${item.manifest.name} tarball is missing ${required}`);
  }
  if (
    item.manifest.name === SERVER_PACKAGE &&
    !entries.some((entry) => /^package\/migrations\/[^/]+\.sql$/u.test(entry))
  ) {
    throw new Error(`${SERVER_PACKAGE} tarball is missing SQL migrations`);
  }
  if (
    item.manifest.name === SERVER_PACKAGE &&
    (!entries.includes('package/tsconfig.json') || !entries.includes('package/tsconfig.build.json'))
  ) {
    throw new Error(`${SERVER_PACKAGE} tarball is missing source build configuration`);
  }

  const packedManifestText = await runTarText(tarball, 'package/package.json');
  if (packedManifestText.includes('workspace:')) {
    throw new Error(`${item.manifest.name} tarball still contains a workspace: dependency`);
  }
  const packedManifest = JSON.parse(packedManifestText) as PackageManifest;
  if (
    packedManifest.name !== item.manifest.name ||
    packedManifest.version !== item.manifest.version
  ) {
    throw new Error(`${item.manifest.name} tarball identity does not match its source manifest`);
  }
  if (stableJson(packedManifest.exports) !== stableJson(item.manifest.exports)) {
    throw new Error(`${item.manifest.name} tarball exports differ from its source manifest`);
  }
  for (const target of new Set(exportTargets(packedManifest.exports))) {
    if (!target.startsWith('./') || target.includes('\\') || target.includes('*')) {
      throw new Error(
        `${item.manifest.name} has an unsafe or unverifiable export target ${target}`,
      );
    }
    const path = target.slice(2);
    if (path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`${item.manifest.name} has an unsafe export target ${target}`);
    }
    if (!entries.includes(`package/${path}`)) {
      throw new Error(`${item.manifest.name} tarball is missing exported target ${target}`);
    }
  }
  if (item.manifest.name === SERVER_PACKAGE) {
    for (const migration of await serverMigrationFiles(item)) {
      if (!entries.includes(`package/migrations/${migration}`)) {
        throw new Error(`${SERVER_PACKAGE} tarball is missing migration ${migration}`);
      }
    }
  }
  for (const groupName of ['dependencies', 'optionalDependencies', 'devDependencies'] as const) {
    for (const [name, range] of Object.entries(packedManifest[groupName] ?? {})) {
      const dependency = packagesByName.get(name);
      if (dependency && range !== dependency.manifest.version) {
        throw new Error(
          `${item.manifest.name} tarball ${groupName}.${name} is ${range}; expected ${dependency.manifest.version}`,
        );
      }
    }
  }
  if (metadataConfigured) {
    const expected = deriveReleaseMetadata(
      await readManifest(join(workspaceRoot, 'package.json')),
      item,
    );
    if (!metadataMatches(packedManifest, expected)) {
      throw new Error(`${item.manifest.name} tarball is missing synchronized release metadata`);
    }
  }
  const canonicalLicense = await readFile(
    join(workspaceRoot, item.manifest.license === AGPL_LICENSE ? 'LICENSE-AGPL' : 'LICENSE-APACHE'),
    'utf8',
  );
  if ((await runTarText(tarball, 'package/LICENSE')) !== canonicalLicense) {
    throw new Error(`${item.manifest.name} tarball contains the wrong full license text`);
  }
  const packedReadme = await runTarText(tarball, 'package/README.md');
  if (
    !packedReadme.includes(item.manifest.name) ||
    !packedReadme.includes(item.manifest.license!)
  ) {
    throw new Error(`${item.manifest.name} tarball README is incomplete`);
  }

  const bytes = await readFile(tarball);
  const info = await stat(tarball);
  return {
    name: item.manifest.name,
    version: item.manifest.version,
    relativeDirectory: item.relativeDirectory,
    tarball,
    filename,
    bytes: info.size,
    sha256: hash(bytes, 'sha256', 'hex'),
    integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
  };
}

async function installSmoke(manager: 'npm' | 'bun', packages: PackedPackage[]): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `scenebook-install-${manager}-`));
  try {
    const tarballDependencies = Object.fromEntries(
      packages.map((item) => [item.name, `file:${item.tarball}`]),
    );
    const serverSourceManifest = await readManifest(
      join(workspaceRoot, 'packages/server/package.json'),
    );
    const sourceBuildDependencies = Object.fromEntries(
      ['typescript', '@types/node', '@types/pg'].map((name) => {
        const version = serverSourceManifest.devDependencies?.[name];
        if (!version)
          throw new Error(`${SERVER_PACKAGE} is missing source build dependency ${name}`);
        return [name, version];
      }),
    );
    const manifest = {
      name: `scenebook-release-smoke-${manager}`,
      private: true,
      type: 'module',
      dependencies: tarballDependencies,
      devDependencies: sourceBuildDependencies,
      ...(manager === 'bun' ? { overrides: tarballDependencies } : {}),
    };
    await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    const sourceManifests = await Promise.all(
      packages.map((item) =>
        readManifest(join(workspaceRoot, item.relativeDirectory, 'package.json')),
      ),
    );
    const imports = sourceManifests.flatMap(publicEntryPoints);
    const smoke = `
globalThis.HTMLElement ??= class HTMLElement {};
globalThis.customElements ??= { get() { return undefined; }, define() {} };
for (const name of ${JSON.stringify(imports)}) {
  const loaded = await import(name);
  if (!loaded || typeof loaded !== 'object') throw new Error('empty import: ' + name);
}
console.log('imported ${imports.length} Scenebook entry points');
`;
    await writeFile(join(directory, 'smoke.mjs'), smoke, { mode: 0o600 });
    const typeConsumer = imports
      .map((name, index) => `import * as entry${index} from ${JSON.stringify(name)};`)
      .concat(`void [${imports.map((_, index) => `entry${index}`).join(', ')}];`)
      .join('\n');
    await writeFile(join(directory, 'consumer.ts'), `${typeConsumer}\n`, { mode: 0o600 });
    await writeFile(
      join(directory, 'tsconfig.consumer.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            lib: ['ES2023', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: 'ES2022',
            types: ['node'],
          },
          include: ['consumer.ts'],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    if (manager === 'npm') {
      await run(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
        {
          cwd: directory,
          env: { npm_config_cache: join(directory, '.npm-cache') },
        },
      );
      await run('node', ['smoke.mjs'], { cwd: directory });
    } else {
      await run('bun', ['install', '--ignore-scripts'], {
        cwd: directory,
        env: { BUN_INSTALL_CACHE_DIR: join(directory, '.bun-cache') },
      });
      await run('bun', ['smoke.mjs'], { cwd: directory });
    }

    const cli = join(directory, 'node_modules', '.bin', 'scenebook');
    const help = await run(cli, ['--help'], { cwd: directory, quiet: true });
    if (!help.stdout.includes('Usage: scenebook <command>')) {
      throw new Error(`${manager} install produced a broken scenebook --help command`);
    }
    if (manager === 'npm') {
      await run(join(directory, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.consumer.json'], {
        cwd: directory,
      });
    }
    const serverDirectory = join(directory, 'node_modules', '@scenebook', 'server');
    const sourceBuild = join(directory, '.server-source-build');
    await rm(sourceBuild, { recursive: true, force: true });
    await run(
      join(directory, 'node_modules', '.bin', 'tsc'),
      [
        '-p',
        join(serverDirectory, 'tsconfig.build.json'),
        '--outDir',
        sourceBuild,
        '--declarationMap',
        'false',
        '--sourceMap',
        'false',
      ],
      { cwd: directory },
    );
    await Promise.all([
      access(join(sourceBuild, 'index.js')),
      access(join(sourceBuild, 'index.d.ts')),
    ]);
    console.log(
      `${manager}: clean install, runtime imports, CLI help${manager === 'npm' ? ', strict declaration consumer typecheck' : ''}, and packed server source rebuild passed`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function safeOutputDirectory(): Promise<{ directory: string; temporary: boolean }> {
  if (!outputValue) {
    return { directory: await mkdtemp(join(tmpdir(), 'scenebook-release-')), temporary: true };
  }
  const directory = isAbsolute(outputValue)
    ? resolve(outputValue)
    : resolve(workspaceRoot, outputValue);
  const releaseRoot = resolve(workspaceRoot, '.release');
  if (!directory.startsWith(`${releaseRoot}${sep}`)) {
    throw new Error('--output must be a named directory inside .release');
  }
  if (directory === workspaceRoot || relative(workspaceRoot, directory).startsWith(`..${sep}`)) {
    throw new Error('Refusing unsafe release output directory');
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { directory, temporary: false };
}

if (Bun.version !== '1.3.3') {
  throw new Error(`Release packing requires Bun 1.3.3 exactly; found ${Bun.version}`);
}

const root = await readManifest(join(workspaceRoot, 'package.json'));
const packages = await discoverPublicPackages();
if (packages.length === 0) throw new Error('No public packages discovered');
const packageNames = new Set(packages.map((item) => item.manifest.name));
if (!packageNames.has('@scenebook/adapters') || !packageNames.has('@scenebook/policy')) {
  throw new Error('The public package set must include adapters and policy');
}

let metadataConfigured = true;
let metadataBlocker = '';
try {
  for (const item of packages) deriveReleaseMetadata(root, item);
} catch (error) {
  metadataConfigured = false;
  metadataBlocker = (error as Error).message;
}
if (!metadataConfigured && strictMetadata) {
  throw new Error(
    `Publication blocked: ${metadataBlocker}. Configure real repository, homepage, and bugs fields in root package.json, then run bun run release:metadata:write.`,
  );
}
if (!metadataConfigured) {
  console.warn(`release metadata prerequisite (publish remains blocked): ${metadataBlocker}`);
}

for (const item of packages) await validateSourcePackage(item, root, metadataConfigured);
const output = await safeOutputDirectory();
const packagesByName = new Map(packages.map((item) => [item.manifest.name, item]));

try {
  const packed: PackedPackage[] = [];
  for (const item of packages) {
    packed.push(await packAndValidate(item, packagesByName, output.directory, metadataConfigured));
  }
  await installSmoke('npm', packed);
  await installSmoke('bun', packed);

  const releaseManifest: ReleaseManifest = {
    schemaVersion: 1,
    bunVersion: Bun.version,
    packages: packed.map(({ tarball: _tarball, ...item }) => item),
  };
  await writeFile(
    join(output.directory, 'release-manifest.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    `verified ${packed.length} Bun tarballs in dependency order: ${packed.map((item) => item.name).join(' -> ')}`,
  );
  console.log(`release manifest: ${join(output.directory, 'release-manifest.json')}`);
  if (!metadataConfigured) console.log('local artifacts verified; npm publication remains blocked');
} finally {
  if (output.temporary && !keep) await rm(output.directory, { recursive: true, force: true });
}
