import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import {
  ffmpegExecutable,
  FORMAT_POLICY,
  loadSceneDirectory,
  type CompileResult,
} from '@scenebook/compiler';
import {
  artifactHash,
  createDeterministicId,
  sha256,
  slugify,
  stableStringify,
} from '@scenebook/core';
import {
  importPlaywrightFile,
  mergeShardBuildEvidence,
  readBoundedRegularFile,
  readBoundedRegularFileAtPath,
  SafeFileReadError,
  writeImportedScene,
} from '@scenebook/playwright';
import {
  ARTIFACT_VERSION,
  ApprovalAttestationSchema,
  BaselineSchema,
  BuildArtifactSchema,
  PublicationCandidateSchema,
  PublicationEventSchema,
  PublicationReleaseSchema,
  ReviewSchema,
  RunArtifactSchema,
  SCHEMA_VERSION,
  ScenebookConfigSchema,
  SceneSchema,
  migrateConfigDocument,
  migrateSceneDocument,
  serializeConfigYaml,
  serializeSceneYaml,
  type BuildArtifact,
  type RunArtifact,
} from '@scenebook/schema';
import { glob } from 'tinyglobby';
import { parse, stringify } from 'yaml';
import { toJSONSchema } from 'zod';
import { optionBoolean, optionString, optionStrings } from './arguments.js';
import { writeFileAtomically } from './atomic-write.js';
import { ciExitCode, ciSummary, readCiBuildArtifact } from './ci.js';
import { findConfig, loadConfig } from './config.js';
import { startDevServer } from './dev-server.js';
import { installDocsAdapter } from './docs-install.js';
import {
  assertHostedGitHead,
  prepareHostedUploadSettings,
  uploadHostedCiEvidence,
  type HostedUploadSettings,
} from './hosted-upload.js';
import {
  approvePublication,
  migrateLegacyBaselines,
  persistImmutableBaseline,
  promotePublication,
  rollbackPublication,
  sealPublicationCandidate,
  validateLocalTrustStorage,
  validatePublicationDestination,
} from './local-publication.js';
import {
  buildProject,
  projectPrivacyPolicyDigest,
  projectPrivacyScanOptions,
  sceneDirectories,
} from './project.js';
import { runProcess } from './process.js';
import {
  createCommandOcrProvider,
  attestRunEvidence,
  refreshEvidenceBuilds,
  scanAssetFiles,
  tesseractProvider,
  type OcrProvider,
} from './privacy-scan.js';
import { prepareRecordingTarget } from './recording-url.js';
import {
  captureSanitizedPlaywrightRecording,
  MAX_RECORDING_SOURCE_BYTES,
} from './record-capture.js';
import { prepareRecorderArtifactPaths, writeRecorderReviewArtifacts } from './record-review.js';
import { scaffoldRecordedScene } from './record-scaffold.js';
import {
  createPlaywrightSafetyConfig,
  playwrightTargetEnvironment,
  resolvePlaywrightTarget,
  type ResolvedPlaywrightTarget,
} from './playwright-target.js';
import { CliError, type CliContext, type LoadedConfig, type ParsedArguments } from './types.js';

const HELP = `Scenebook — portable product stories that stay connected to the product

Usage: scenebook <command> [options]

Commands:
  init                 Detect Playwright and create a production-safe project config
  dev                  Build, watch, and serve the static catalog (not Studio)
  build                Compile Scenes; --channel also seals an immutable candidate
  export               Compile selected --format outputs
  import playwright    Import test and test.step metadata as draft Scenes
  docs install         Install a safe docs-framework integration without overwriting files
  test                 Execute Playwright with the Scenebook reporter
  doctor               Validate configuration, sources, encoders, and privacy readiness
  privacy scan         OCR-scan exact publication derivatives or --run evidence, fail closed
  schema               Print the versioned JSON Schema for scene/config/run/build
  migrate              Migrate YAML documents to the current schema
  review               Summarize a Run, Build, or Review artifact
  baseline accept      Preserve a Run as immutable Baseline truth and active pointer
  baseline migrate     Bind legacy Baselines to exact Runs and immutable pointers
  approve              Attest visual, editorial, release, or privacy decisions
  publish              Promote one immutable candidate without rebuilding
  rollback             Atomically restore a prior immutable Channel Release
  record               Record sanitized Playwright plus hash-bound review diagnostics
  ci                   Test and compile with GitHub summary output
  ci merge-shards      Finalize an exact set of shard Build fragments

Global options: --config <path> --help --version
Privacy: pixel exports fail closed unless OCR evidence exists. For local-only work,
use --allow-unscanned-privacy; the override is recorded in every manifest.
Publication: build --channel requires exact Build evidence and seals its compiled
tree/archive. Approve the exact candidate, then publish --channel promotes those
bytes without rebuilding. --collection may narrow a candidate at build time.
Test safety: test and ci select one enabled Project Run Target with --target <id>;
the sole enabled target is inferred. Environment mutation policy and base URL are enforced.
Hosted CI: --upload is explicit and requires --server-url, --workspace-id,
--project-id, a local OCR provider, and GitHub Actions OIDC with id-token: write.
`;
const MAX_BASELINE_INPUT_BYTES = 16 * 1024 * 1024;

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function print(context: CliContext, value: string): void {
  context.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

function printBuildWarnings(context: CliContext, result: CompileResult): void {
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.level === 'warning') {
      context.stderr.write(`Warning [${diagnostic.code}]: ${diagnostic.message}\n`);
    }
  }
}

function publicationSelection(arguments_: ParsedArguments): {
  readonly channel?: string;
  readonly collection?: string;
} {
  for (const name of ['channel', 'collection'] as const) {
    if (Array.isArray(arguments_.options.get(name))) {
      throw new CliError(`Option --${name} may only be provided once.`);
    }
  }
  const channel = optionString(arguments_, 'channel');
  const collection = optionString(arguments_, 'collection');
  return {
    ...(channel ? { channel } : {}),
    ...(collection ? { collection } : {}),
  };
}

async function commandInit(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  if (await findConfig(context.cwd, optionString(arguments_, 'config'))) {
    throw new CliError('A Scenebook configuration already exists in this project.');
  }
  const packagePath = resolve(context.cwd, 'package.json');
  const packageJson = (await exists(packagePath))
    ? (JSON.parse(await readFile(packagePath, 'utf8')) as { name?: string })
    : {};
  const name = optionString(arguments_, 'name') ?? packageJson.name ?? basename(context.cwd);
  const id = slugify(name);
  const playwrightCandidates = [
    'playwright.config.ts',
    'playwright.config.mts',
    'playwright.config.js',
  ];
  const playwrightConfig = (
    await Promise.all(
      playwrightCandidates.map(async (candidate) =>
        (await exists(resolve(context.cwd, candidate))) ? candidate : undefined,
      ),
    )
  ).find(Boolean);
  const testCandidates = playwrightConfig
    ? (
        await glob('**/*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs}', {
          cwd: context.cwd,
          ignore: [
            '**/.git/**',
            '**/.scenebook/**',
            '**/dist/**',
            '**/node_modules/**',
            '**/scenebook-dist/**',
          ],
          onlyFiles: true,
        })
      ).sort((left, right) => left.localeCompare(right))
    : [];
  const explicitImport = uniqueOption(arguments_, 'import');
  const selectedTest = uniqueOption(arguments_, 'test');
  if (selectedTest && !explicitImport && !optionBoolean(arguments_, 'yes')) {
    throw new CliError('--test during init requires --import <test-file> or --yes.');
  }
  let selectedImport = explicitImport;
  if (!selectedImport && optionBoolean(arguments_, 'yes')) {
    if (testCandidates.length > 1) {
      throw new CliError(
        `Detected ${testCandidates.length} Playwright test files. Refusing to guess; rerun with --import <test-file>.`,
      );
    }
    selectedImport = testCandidates[0];
  }
  if (selectedTest && !selectedImport) {
    throw new CliError('--test during init requires a selected Playwright test file.');
  }
  if (!selectedImport && context.stdin?.isTTY && testCandidates.length > 0) {
    const offeredCandidates = testCandidates.slice(0, 50);
    print(context, 'Choose a Playwright file to turn into your first portable Scene:');
    for (const [index, candidate] of offeredCandidates.entries()) {
      print(context, `  ${index + 1}. ${candidate}`);
    }
    if (testCandidates.length > offeredCandidates.length) {
      print(
        context,
        `  … ${testCandidates.length - offeredCandidates.length} more; use --import <test-file> for an unlisted file.`,
      );
    }
    context.stderr.write('File number (Enter to skip): ');
    const reader = createInterface({ input: context.stdin, terminal: false });
    try {
      const answer = (await reader.question('')).trim();
      if (answer) {
        const index = Number.parseInt(answer, 10);
        if (!/^\d+$/u.test(answer) || index < 1 || index > offeredCandidates.length) {
          throw new CliError(`Expected a number from 1 to ${offeredCandidates.length}, or Enter.`);
        }
        selectedImport = offeredCandidates[index - 1];
      }
    } finally {
      reader.close();
    }
  }
  let firstScenes: Awaited<ReturnType<typeof importPlaywrightFile>> = [];
  const canonicalProjectRoot = await realpath(context.cwd);
  if (selectedImport) {
    const absoluteImport = resolve(context.cwd, selectedImport);
    const sourceStatus = await lstat(absoluteImport).catch(() => {
      throw new CliError(`The init import file does not exist: ${selectedImport}.`);
    });
    if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) {
      throw new CliError('The init import source must be a regular file, not a symlink.');
    }
    const canonicalImport = await realpath(absoluteImport);
    const projectRelative = relative(canonicalProjectRoot, canonicalImport);
    if (
      projectRelative === '' ||
      projectRelative === '..' ||
      projectRelative.startsWith('../') ||
      projectRelative.startsWith('..\\') ||
      isAbsolute(projectRelative)
    ) {
      throw new CliError('The init import file must be a regular file inside the project.');
    }
    firstScenes = await importPlaywrightFile(canonicalImport);
    if (firstScenes.length === 0) {
      throw new CliError(`No literal Playwright test titles were found in ${selectedImport}.`);
    }
    if (selectedTest) {
      firstScenes = firstScenes.filter(
        (scene) => scene.title === selectedTest || scene.id === selectedTest,
      );
      if (firstScenes.length === 0) {
        throw new CliError(`No imported test matched --test ${selectedTest}.`);
      }
    }
    const ids = new Set<string>();
    for (const scene of firstScenes) {
      if (ids.has(scene.id)) {
        throw new CliError(
          `The selected Playwright tests produce duplicate Scene id ${scene.id}; use --test to choose one.`,
        );
      }
      ids.add(scene.id);
      const target = resolve(context.cwd, 'scenes', `${scene.id}.scene`);
      try {
        await lstat(target);
        throw new CliError(`Refusing to overwrite existing Scene directory: ${target}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const parsed = ScenebookConfigSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    project: { schemaVersion: SCHEMA_VERSION, id, name, slug: id },
    ...(playwrightConfig ? { playwright: { config: playwrightConfig } } : {}),
  });
  const configPath = resolve(context.cwd, 'scenebook.config.ts');
  const source = `// Scenebook source and output policy. Keep this file in version control.\nexport default ${JSON.stringify(parsed, null, 2)};\n`;
  await writeFile(configPath, source, { flag: 'wx' });
  await mkdir(resolve(context.cwd, 'scenes'), { recursive: true });
  print(
    context,
    `Created ${relative(context.cwd, configPath)}${playwrightConfig ? ` and detected ${playwrightConfig}` : ''}.`,
  );
  print(
    context,
    'Verification is not configured yet. Before `scenebook test` or `scenebook ci`, add an Environment with your actual controlled base URL, a Product Variant, a Capture Profile, and an enabled Run Target; `init` does not guess a URL.',
  );
  for (const scene of firstScenes) {
    const path = await writeImportedScene(
      scene,
      resolve(context.cwd, 'scenes'),
      canonicalProjectRoot,
    );
    print(context, `Imported first Scene ${scene.title} → ${relative(context.cwd, path)}`);
  }
  if (firstScenes.length > 0) {
    print(
      context,
      'Your first portable Scene is ready to edit. It is source-linked but remains Monitored until a controlled Run captures evidence.',
    );
    return 0;
  }
  if (testCandidates.length > 0) {
    print(
      context,
      `Detected ${testCandidates.length} candidate test file${testCandidates.length === 1 ? '' : 's'}; no files were modified or imported automatically.`,
    );
    print(
      context,
      `Next: inspect and import one with \`scenebook import playwright ${testCandidates[0]}\`.`,
    );
  } else {
    print(
      context,
      'Next: import an existing test with `scenebook import playwright <test-file>` or run `scenebook record <url>`.',
    );
  }
  return 0;
}

async function commandBuild(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const selection = publicationSelection(arguments_);
  if (selection.channel && optionBoolean(arguments_, 'allow-unscanned-privacy')) {
    throw new CliError(
      'Channel candidates cannot use --allow-unscanned-privacy. Scan exact derivatives and rebuild.',
    );
  }
  const result = await buildProject(config, {
    ...selection,
    output: optionString(arguments_, 'output', 'o'),
    allowUnscannedPrivacy: optionBoolean(arguments_, 'allow-unscanned-privacy'),
    locale: optionString(arguments_, 'locale'),
    fallbackLocale: optionString(arguments_, 'fallback-locale'),
  });
  printBuildWarnings(context, result);
  print(
    context,
    `Built ${result.manifest.scenes.length} Scene(s) and ${result.files.length} file(s) at ${result.outputDirectory}.`,
  );
  if (selection.channel) {
    const stored = await sealPublicationCandidate({
      config,
      result,
      channel: selection.channel,
      ...(selection.collection ? { collection: selection.collection } : {}),
      buildPath: optionString(arguments_, 'build') ?? '.scenebook/runs/build.json',
    });
    print(
      context,
      `Sealed immutable candidate ${stored.candidate.id} (${stored.revision}) for Channel ${stored.candidate.channelId}; tree ${stored.candidate.publication.treeHash}.`,
    );
  }
  return 0;
}

async function commandExport(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const formats = optionStrings(arguments_, 'format');
  if (formats.length === 0)
    throw new CliError('Export requires at least one --format (or --format all).');
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const result = await buildProject(config, {
    ...publicationSelection(arguments_),
    formats,
    output: optionString(arguments_, 'output', 'o'),
    allowUnscannedPrivacy: optionBoolean(arguments_, 'allow-unscanned-privacy'),
    locale: optionString(arguments_, 'locale'),
    fallbackLocale: optionString(arguments_, 'fallback-locale'),
  });
  printBuildWarnings(context, result);
  print(context, `Exported ${formats.join(', ')} to ${result.outputDirectory}.`);
  return 0;
}

async function commandImport(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const positionals =
    arguments_.positionals[0] === 'playwright'
      ? arguments_.positionals.slice(1)
      : arguments_.positionals;
  const file = positionals[0];
  if (!file) throw new CliError('Usage: scenebook import playwright <test-file>');
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const scenes = await importPlaywrightFile(resolve(config.directory, file));
  if (scenes.length === 0)
    throw new CliError(`No literal Playwright test titles were found in ${file}.`);
  const output = resolve(config.directory, optionString(arguments_, 'output') ?? 'scenes');
  const selected = optionString(arguments_, 'test');
  const imports = selected
    ? scenes.filter((scene) => scene.title === selected || scene.id === selected)
    : scenes;
  if (imports.length === 0) throw new CliError(`No imported test matched --test ${selected}.`);
  for (const scene of imports) {
    const path = await writeImportedScene(scene, output, config.directory);
    print(context, `Imported ${scene.title} → ${relative(config.directory, path)}`);
  }
  return 0;
}

async function commandDocs(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  if (arguments_.positionals[0] !== 'install') {
    throw new CliError(
      'Usage: scenebook docs install --adapter <fumadocs|docusaurus|vitepress|starlight|nextra|mintlify|github-pages> [--base-path /docs] [--destination .] [--dry-run]',
    );
  }
  const adapter = uniqueOption(arguments_, 'adapter');
  if (!adapter) throw new CliError('docs install requires --adapter <framework>.');
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const basePath = uniqueOption(arguments_, 'base-path');
  const destination = uniqueOption(arguments_, 'destination');
  const result = await installDocsAdapter({
    projectDirectory: config.directory,
    adapter,
    ...(basePath ? { basePath } : {}),
    ...(destination ? { destination } : {}),
    dryRun: optionBoolean(arguments_, 'dry-run'),
  });
  const prefix = result.dryRun ? 'Would install' : 'Installed';
  print(
    context,
    `${prefix} ${result.adapter} docs integration at ${relative(config.directory, result.destination) || '.'}: ${result.created.length} new, ${result.unchanged.length} unchanged.`,
  );
  for (const path of result.created) print(context, `  + ${path}`);
  for (const path of result.unchanged) print(context, `  = ${path}`);
  return 0;
}

interface PlaywrightPreflight {
  readonly config: LoadedConfig;
  readonly selection: ResolvedPlaywrightTarget;
}

function uniqueOption(arguments_: ParsedArguments, name: string): string | undefined {
  if (Array.isArray(arguments_.options.get(name))) {
    throw new CliError(`Option --${name} may only be provided once.`);
  }
  return optionString(arguments_, name);
}

function strictBooleanOption(arguments_: ParsedArguments, name: string): boolean {
  const value = arguments_.options.get(name);
  if (Array.isArray(value)) throw new CliError(`Option --${name} may only be provided once.`);
  if (value === undefined || value === false || value === 'false' || value === '0') return false;
  if (value === true || value === 'true' || value === '1') return true;
  throw new CliError(`Option --${name} must be true or false.`);
}

function hostedUploadSettings(
  arguments_: ParsedArguments,
  context: CliContext,
  config: LoadedConfig,
): HostedUploadSettings | undefined {
  const upload = strictBooleanOption(arguments_, 'upload');
  const hostedOptions = ['server-url', 'workspace-id', 'project-id', 'oidc-audience'];
  if (!upload) {
    const supplied = hostedOptions.filter((name) => arguments_.options.has(name));
    if (supplied.length > 0) {
      throw new CliError(
        `Hosted option${supplied.length === 1 ? '' : 's'} ${supplied.map((name) => `--${name}`).join(', ')} require explicit --upload.`,
      );
    }
    return undefined;
  }
  if (optionBoolean(arguments_, 'allow-unscanned-privacy')) {
    throw new CliError('Hosted upload never permits --allow-unscanned-privacy.');
  }
  for (const name of hostedOptions) {
    if (Array.isArray(arguments_.options.get(name))) {
      throw new CliError(`Option --${name} may only be provided once.`);
    }
  }
  return prepareHostedUploadSettings(
    config,
    {
      serverUrl: optionString(arguments_, 'server-url'),
      workspaceId: optionString(arguments_, 'workspace-id'),
      projectId: optionString(arguments_, 'project-id'),
      oidcAudience: optionString(arguments_, 'oidc-audience'),
    },
    context.env,
  );
}

function assertSafePlaywrightArguments(values: readonly string[]): void {
  const blocked = ['--config', '--project', '--reporter'];
  for (const value of values) {
    if (
      value === '-c' ||
      value.startsWith('-c=') ||
      (value.startsWith('-c') && value.length > 2) ||
      blocked.some((option) => value === option || value.startsWith(`${option}=`))
    ) {
      throw new CliError(
        `Playwright argument ${value} would override Scenebook's verified configuration. Configure playwright.config or playwright.projects instead.`,
      );
    }
  }
}

async function playwrightPreflight(
  arguments_: ParsedArguments,
  context: CliContext,
): Promise<PlaywrightPreflight> {
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const baseUrlOverride = uniqueOption(arguments_, 'base-url');
  if (baseUrlOverride) {
    throw new CliError(
      'Ad-hoc --base-url overrides are not allowed. Configure Environment baseUrl and select it with --target <id>.',
    );
  }
  const selection = resolvePlaywrightTarget(config, uniqueOption(arguments_, 'target'));
  assertSafePlaywrightArguments(arguments_.positionals);
  return { config, selection };
}

async function runPlaywrightTests(
  arguments_: ParsedArguments,
  context: CliContext,
  preflight: PlaywrightPreflight,
): Promise<void> {
  const { config, selection } = preflight;
  const safetyConfig = await createPlaywrightSafetyConfig(config);
  const playwrightArguments = ['playwright', 'test'];
  playwrightArguments.push('--config', safetyConfig.path);
  for (const project of config.config.playwright.projects)
    playwrightArguments.push('--project', project);
  playwrightArguments.push(
    '--reporter=line,@scenebook/playwright/reporter',
    ...arguments_.positionals,
  );
  print(
    context,
    `Testing Run Target ${selection.target.id} on ${selection.environment.kind} Environment ${selection.environment.id} at ${selection.baseUrl}.`,
  );
  try {
    const code = await runProcess('bunx', playwrightArguments, {
      cwd: config.directory,
      env: playwrightTargetEnvironment(config, selection, context.env),
    });
    if (code !== 0) throw new CliError(`Playwright failed with exit code ${code}.`, code);
  } finally {
    await safetyConfig.cleanup();
  }
}

async function commandTest(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  await runPlaywrightTests(arguments_, context, await playwrightPreflight(arguments_, context));
  return 0;
}

async function commandDoctor(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const scenes = await sceneDirectories(config);
  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];
  checks.push({
    label: 'Runtime',
    ok: Number(process.versions.node.split('.')[0]) >= 22,
    detail: process.version,
  });
  checks.push({ label: 'Configuration', ok: true, detail: relative(context.cwd, config.path) });
  checks.push({ label: 'Scenes', ok: scenes.length > 0, detail: `${scenes.length} discovered` });
  const enabledTargets = config.project.runTargets.filter((target) => target.enabled);
  const runnableTargets: string[] = [];
  const blockedTargets: string[] = [];
  for (const target of enabledTargets) {
    try {
      resolvePlaywrightTarget(config, target.id);
      runnableTargets.push(target.id);
    } catch (error) {
      blockedTargets.push(
        `${target.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const playwrightConfigured =
    config.config.playwright.config !== undefined ||
    config.config.playwright.projects.length > 0 ||
    config.project.runTargets.length > 0;
  checks.push({
    label: 'Playwright Run Targets',
    ok: !playwrightConfigured || runnableTargets.length > 0,
    detail:
      enabledTargets.length === 0
        ? `${playwrightConfigured ? 'none enabled' : 'not configured (optional)'}; add an Environment, Product Variant, Capture Profile, and enabled Run Target before scenebook test or scenebook ci`
        : runnableTargets.length === 0
          ? `none runnable; ${blockedTargets.join('; ')}`
          : `${runnableTargets.length} runnable (${runnableTargets.join(', ')})${runnableTargets.length > 1 ? '; test and ci require --target <id>' : ''}${blockedTargets.length ? `; blocked: ${blockedTargets.join('; ')}` : ''}`,
  });
  for (const directory of scenes) {
    try {
      await loadSceneDirectory(directory);
      checks.push({
        label: `Scene ${basename(directory)}`,
        ok: true,
        detail: 'schema and assets valid',
      });
    } catch (error) {
      checks.push({
        label: `Scene ${basename(directory)}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const needsFfmpeg = config.config.output.formats.some(
    (format) => FORMAT_POLICY[format].requiresFfmpeg,
  );
  if (needsFfmpeg) {
    let encoder: string | null = null;
    let encoderError: string | undefined;
    try {
      encoder = ffmpegExecutable();
    } catch (error) {
      encoderError = error instanceof Error ? error.message : String(error);
    }
    checks.push({
      label: 'Motion encoder',
      ok: encoder !== null,
      detail:
        encoder ??
        encoderError ??
        'unavailable; install ffmpeg on PATH or set SCENEBOOK_FFMPEG_PATH to an absolute executable path',
    });
  }
  if (!config.config.privacy.ocrBeforePublication) {
    checks.push({
      label: 'Publication privacy',
      ok: true,
      detail: 'OCR policy disabled by configuration',
    });
  } else {
    const temporary = await mkdtemp(join(tmpdir(), 'scenebook-doctor-'));
    try {
      const result = await buildProject(config, {
        ...publicationSelection(arguments_),
        output: temporary,
        allowUnscannedPrivacy: optionBoolean(arguments_, 'allow-unscanned-privacy'),
        locale: optionString(arguments_, 'locale'),
        fallbackLocale: optionString(arguments_, 'fallback-locale'),
      });
      checks.push({
        label: 'Publication privacy',
        ok:
          result.manifest.privacy.status === 'passed' ||
          optionBoolean(arguments_, 'allow-unscanned-privacy'),
        detail:
          result.manifest.privacy.status === 'passed'
            ? `${result.manifest.assets.length} exact derivative assessment(s) current`
            : `${result.manifest.assets.length} derivative(s) accepted only by explicit override`,
      });
    } catch (error) {
      checks.push({
        label: 'Publication privacy',
        ok: false,
        detail:
          error instanceof Error
            ? error.message
            : 'Publication derivative assessment failed unexpectedly.',
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  for (const check of checks)
    print(context, `${check.ok ? '✓' : '✗'} ${check.label}: ${check.detail}`);
  const failures = checks.filter((check) => !check.ok).length;
  if (failures) throw new CliError(`Doctor found ${failures} blocking issue(s).`, 2);
  return 0;
}

async function commandSchema(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const kind = arguments_.positionals[0] ?? optionString(arguments_, 'kind') ?? 'scene';
  const schemas = {
    scene: SceneSchema,
    config: ScenebookConfigSchema,
    run: RunArtifactSchema,
    build: BuildArtifactSchema,
    candidate: PublicationCandidateSchema,
    approval: ApprovalAttestationSchema,
    release: PublicationReleaseSchema,
    'publication-event': PublicationEventSchema,
  } as const;
  const schema = schemas[kind as keyof typeof schemas];
  if (!schema)
    throw new CliError(
      'Schema kind must be one of: scene, config, run, build, candidate, approval, release, publication-event.',
    );
  print(context, JSON.stringify(toJSONSchema(schema, { target: 'draft-2020-12' }), null, 2));
  return 0;
}

async function commandMigrate(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const dryRun = optionBoolean(arguments_, 'dry-run');
  const explicit = arguments_.positionals;
  const paths = explicit.length
    ? explicit.map((path) => resolve(context.cwd, path))
    : [
        config.path,
        ...(await sceneDirectories(config)).map((directory) => join(directory, 'scene.yaml')),
      ];
  for (const path of paths) {
    if (!/\.ya?ml$/u.test(path)) {
      if (path === config.path) {
        print(
          context,
          `Skipped ${relative(context.cwd, path)}: TypeScript configs are validated at load time and have no safe text migration.`,
        );
        continue;
      }
      throw new CliError(`Only YAML documents can be migrated safely: ${path}`);
    }
    const value = parse(await readFile(path, 'utf8')) as unknown;
    const sceneDocument = basename(path) === 'scene.yaml';
    const output = sceneDocument
      ? serializeSceneYaml(SceneSchema.parse(migrateSceneDocument(value)))
      : serializeConfigYaml(ScenebookConfigSchema.parse(migrateConfigDocument(value)));
    if (!dryRun) await writeFileAtomically(path, output, { mode: 0o644 });
    print(context, `${dryRun ? 'Would migrate' : 'Migrated'} ${relative(context.cwd, path)}`);
  }
  return 0;
}

async function commandReview(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const path = resolve(context.cwd, arguments_.positionals[0] ?? '.scenebook/runs/build.json');
  const value = JSON.parse(await readFile(path, 'utf8')) as { kind?: string };
  if (value.kind === 'build') {
    const build = BuildArtifactSchema.parse(value);
    print(context, `Build ${build.id}: ${build.status}`);
    print(
      context,
      `  ${build.summary.passed} passed · ${build.summary.changed} changed · ${build.summary.broken} broken · ${build.summary.blocked} blocked · ${build.summary.pending} pending`,
    );
    return build.status === 'failed' || build.status === 'blocked' ? 2 : 0;
  }
  if (value.kind === 'run') {
    const run = RunArtifactSchema.parse(value);
    print(context, `Run ${run.id}: ${run.status} · Scene ${run.sceneId} · ${run.durationMs}ms`);
    const selected = run.attempts.find((attempt) => attempt.id === run.selectedAttemptId);
    print(
      context,
      `  ${selected?.states.length ?? 0} states · ${selected?.errors.length ?? 0} errors · privacy ${run.privacy.status}`,
    );
    return run.status === 'failed' || run.status === 'blocked' ? 2 : 0;
  }
  if (value.kind === 'review') {
    const review = ReviewSchema.parse(value);
    print(context, `Review ${review.id}: ${review.status} · ${review.changeState}`);
    for (const change of review.changes)
      print(context, `  [${change.dimension}/${change.severity}] ${change.summary}`);
    return review.status === 'rejected' || review.changeState === 'blocked' ? 2 : 0;
  }
  throw new CliError(`Unsupported artifact kind in ${path}.`);
}

interface BaselineAssetCopy {
  readonly bytes: Uint8Array;
  readonly path: string;
}

function canonicalBaselineAssetPath(sha: string, mediaType: string): string {
  if (mediaType === 'image/png') return `assets/${sha}.png`;
  if (mediaType === 'image/jpeg') return `assets/${sha}.jpg`;
  throw new CliError(`Baseline screenshots must be PNG or JPEG; received ${mediaType}.`);
}

function assertScreenshotMedia(bytes: Uint8Array, mediaType: string, logicalPath: string): void {
  const png =
    bytes.byteLength >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  const jpeg = bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((mediaType === 'image/png' && !png) || (mediaType === 'image/jpeg' && !jpeg)) {
    throw new CliError(`Run screenshot media does not match ${mediaType}: ${logicalPath}.`);
  }
}

async function prepareBaselineAssets(
  resolvedRunPath: string,
  states: RunArtifact['attempts'][number]['states'],
): Promise<Map<string, BaselineAssetCopy>> {
  const runDirectory = dirname(resolvedRunPath);
  const evidenceRoot = basename(runDirectory) === 'runs' ? dirname(runDirectory) : runDirectory;
  const copies = new Map<string, BaselineAssetCopy>();
  for (const state of states) {
    const asset = state.screenshot;
    const destinationPath = canonicalBaselineAssetPath(asset.sha256, asset.mediaType);
    let bytes: Uint8Array;
    try {
      bytes = (
        await readBoundedRegularFile(evidenceRoot, asset.path, {
          maximumBytes: asset.byteLength,
          minimumBytes: asset.byteLength,
        })
      ).bytes;
    } catch (error) {
      if (error instanceof SafeFileReadError) {
        throw new CliError(`Run screenshot path is unsafe (${error.reason}): ${asset.path}.`);
      }
      throw error;
    }
    if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256) {
      throw new CliError(`Run screenshot does not match its exact content address: ${asset.path}.`);
    }
    assertScreenshotMedia(bytes, asset.mediaType, asset.path);
    const previous = copies.get(destinationPath);
    if (previous && !Buffer.from(previous.bytes).equals(bytes)) {
      throw new CliError(`Conflicting Run screenshots share content address ${asset.sha256}.`);
    }
    copies.set(destinationPath, { bytes, path: destinationPath });
  }
  return copies;
}

async function persistBaselineAssets(
  baselineRoot: string,
  copies: ReadonlyMap<string, BaselineAssetCopy>,
): Promise<void> {
  await mkdir(baselineRoot, { recursive: true, mode: 0o700 });
  const rootStatus = await lstat(baselineRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new CliError('Configured baseline root must be a real directory, not a symbolic link.');
  }
  const assetsRoot = resolve(baselineRoot, 'assets');
  await mkdir(assetsRoot, { recursive: true, mode: 0o700 });
  const assetsStatus = await lstat(assetsRoot);
  if (!assetsStatus.isDirectory() || assetsStatus.isSymbolicLink()) {
    throw new CliError('Baseline asset directory must be a real directory, not a symbolic link.');
  }
  for (const copy of copies.values()) {
    const destination = resolve(baselineRoot, copy.path);
    const existing = await readBoundedRegularFile(baselineRoot, copy.path, {
      maximumBytes: copy.bytes.byteLength,
      minimumBytes: copy.bytes.byteLength,
    }).catch((error: unknown) => {
      if (error instanceof SafeFileReadError && error.reason === 'missing') return undefined;
      if (error instanceof SafeFileReadError) {
        throw new CliError(`Baseline asset destination is unsafe (${error.reason}): ${copy.path}.`);
      }
      throw error;
    });
    if (existing) {
      if (!Buffer.from(existing.bytes).equals(copy.bytes)) {
        throw new CliError(`Baseline asset content-address collision: ${copy.path}.`);
      }
      continue;
    }
    await writeFileAtomically(destination, copy.bytes, { mode: 0o600, directoryMode: 0o700 });
  }
}

async function commandBaseline(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const operation = arguments_.positionals[0];
  if (!optionBoolean(arguments_, 'yes', 'y'))
    throw new CliError('Baseline promotion requires --yes because it changes review truth.');
  const actor = optionString(arguments_, 'actor');
  if (!actor) throw new CliError('Baseline changes require --actor <id>.');
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  if (operation === 'migrate') {
    const migrated = await migrateLegacyBaselines({
      config,
      actorId: actor,
      ...(optionString(arguments_, 'reason') ? { reason: optionString(arguments_, 'reason') } : {}),
    });
    print(
      context,
      `Migrated ${migrated.migrated} legacy Baseline(s); ${migrated.alreadyImmutable} already used exact immutable pointers.`,
    );
    return 0;
  }
  if (operation !== 'accept') {
    throw new CliError('Usage: scenebook baseline <accept <run.json>|migrate> --actor <id> --yes');
  }
  const runPath = arguments_.positionals[1];
  if (!runPath) throw new CliError('Baseline promotion requires a Run artifact path.');
  const resolvedRunPath = resolve(context.cwd, runPath);
  const runBytes = await readBoundedRegularFileAtPath(resolvedRunPath, {
    maximumBytes: MAX_BASELINE_INPUT_BYTES,
    minimumBytes: 1,
  }).catch((error: unknown) => {
    if (error instanceof SafeFileReadError) {
      throw new CliError(`Run artifact is unsafe (${error.reason}): ${resolvedRunPath}.`);
    }
    throw error;
  });
  const run = RunArtifactSchema.parse(JSON.parse(Buffer.from(runBytes.bytes).toString('utf8')));
  if (run.projectId !== config.project.id) {
    throw new CliError('Run artifact belongs to another configured Project.');
  }
  if (run.status !== 'passed')
    throw new CliError(`Only a passed Run can become a baseline; received ${run.status}.`);
  if (
    (run.privacy.status === 'unknown' || run.privacy.status === 'warning') &&
    !optionBoolean(arguments_, 'allow-unscanned-privacy')
  ) {
    throw new CliError(
      'Run privacy is not clear. Scan the evidence or use the explicit --allow-unscanned-privacy override.',
    );
  }
  if (run.privacy.status === 'blocked' || run.privacy.status === 'quarantined')
    throw new CliError('Privacy-blocked evidence cannot become a baseline.');
  const privacyOverride = optionBoolean(arguments_, 'allow-unscanned-privacy');
  const reason = optionString(arguments_, 'reason');
  if (privacyOverride && (!reason || reason.trim().length < 10)) {
    throw new CliError('A privacy override requires --reason with at least 10 characters.');
  }
  const selected = run.attempts.find((attempt) => attempt.id === run.selectedAttemptId);
  if (!selected) throw new CliError('Selected Run attempt does not exist.');
  const covered = new Set(selected.states.map((state) => state.stepId));
  const missing = run.expectedStepIds.filter((id) => !covered.has(id));
  if (missing.length)
    throw new CliError(
      `The successful attempt is incomplete; missing evidence for: ${missing.join(', ')}.`,
    );
  const baselineAssets = await prepareBaselineAssets(resolvedRunPath, selected.states);
  const now = new Date().toISOString();
  const runRevision = artifactHash(run);
  const baseline = BaselineSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: createDeterministicId('baseline', `${runRevision}:${run.selectedAttemptId}`, 32),
    projectId: run.projectId,
    kind: 'baseline',
    createdAt: now,
    producer: { name: '@scenebook/cli', version: '0.1.0', runtime: process.version },
    sceneId: run.sceneId,
    runTargetId: run.runTargetId,
    sourceRunId: run.id,
    sourceRunRevision: runRevision,
    sourceAttemptId: selected.id,
    sourceRevision: run.sourceRevision,
    completeness: 'complete',
    sourceRunStatus: 'passed',
    expectedStepIds: run.expectedStepIds,
    states: selected.states.map((state) => ({
      sceneId: state.sceneId,
      stepId: state.stepId,
      phase: state.phase,
      stateId: state.id,
      screenshot: {
        ...state.screenshot,
        path: canonicalBaselineAssetPath(state.screenshot.sha256, state.screenshot.mediaType),
      },
      screenshotHash: state.screenshotHash,
      ...(state.perceptualHash ? { perceptualHash: state.perceptualHash } : {}),
      route: state.route,
      viewport: state.viewport,
      ...(state.target ? { target: state.target } : {}),
      ...(state.semantic ? { semantic: state.semantic } : {}),
      privacy: state.privacy,
    })),
    checksHash: sha256(stableStringify(selected.checks)),
    checks: selected.checks,
    approvals: [
      {
        id: createDeterministicId('approval', `${run.id}:${actor}:${now}`),
        kind: 'visual',
        decision: 'approved',
        actorId: actor,
        createdAt: now,
        revision: runRevision,
        ...(reason ? { reason } : {}),
      },
    ],
  });
  const baselineRoot = resolve(config.directory, config.config.paths.baselines);
  await validateLocalTrustStorage(config);
  await persistBaselineAssets(baselineRoot, baselineAssets);
  const persisted = await persistImmutableBaseline({
    config,
    baseline,
    actorId: actor,
    ...(reason ? { reason } : {}),
    ...(privacyOverride && reason ? { privacyOverrideReason: reason } : {}),
  });
  print(
    context,
    `Accepted complete Run ${run.id} as immutable Baseline ${persisted.revision}; active pointer ${relative(config.directory, persisted.pointerPath)}.`,
  );
  return 0;
}

async function commandPublish(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const destination =
    optionString(arguments_, 'destination') ?? optionString(arguments_, 'output', 'o');
  if (!destination)
    throw new CliError(
      'Publish requires --destination <directory>; no build is performed during promotion.',
    );
  await validatePublicationDestination(config, destination);
  const channel = optionString(arguments_, 'channel');
  if (!channel) throw new CliError('Publish requires --channel <id-or-slug>.');
  const actor = optionString(arguments_, 'actor');
  if (!actor) throw new CliError('Publish requires --actor <id>.');
  if (!optionBoolean(arguments_, 'yes', 'y')) {
    throw new CliError('Publish requires --yes because it advances the atomic Channel pointer.');
  }
  for (const option of [
    'allow-unscanned-privacy',
    'collection',
    'fallback-locale',
    'format',
    'locale',
  ]) {
    if (arguments_.options.has(option)) {
      throw new CliError(
        `Publish cannot use --${option}; promotion consumes the already sealed candidate without rebuilding.`,
      );
    }
  }
  const promoted = await promotePublication({
    config,
    channel,
    ...(optionString(arguments_, 'candidate')
      ? { candidate: optionString(arguments_, 'candidate') }
      : {}),
    destination,
    actorId: actor,
  });
  print(
    context,
    `Published immutable Release ${promoted.release.id} (${promoted.releaseRevision}) with event ${promoted.eventRevision} to ${promoted.destination}.`,
  );
  return 0;
}

async function commandApprove(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const scope = arguments_.positionals[0];
  if (!['visual', 'editorial', 'release', 'privacy-override'].includes(scope ?? '')) {
    throw new CliError(
      'Usage: scenebook approve <visual|editorial|release|privacy-override> --actor <id> --yes',
    );
  }
  if (!optionBoolean(arguments_, 'yes', 'y')) {
    throw new CliError('Approval attestation requires --yes because it changes publication truth.');
  }
  const actor = optionString(arguments_, 'actor');
  if (!actor) throw new CliError('Approval attestation requires --actor <id>.');
  const decision = optionString(arguments_, 'decision') ?? 'approved';
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new CliError('--decision must be approved or rejected.');
  }
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const stored = await approvePublication({
    config,
    scope: scope as 'visual' | 'editorial' | 'release' | 'privacy-override',
    actorId: actor,
    decision,
    ...(optionString(arguments_, 'reason') ? { reason: optionString(arguments_, 'reason') } : {}),
    ...(optionString(arguments_, 'channel')
      ? { channel: optionString(arguments_, 'channel') }
      : {}),
    ...(optionString(arguments_, 'candidate')
      ? { candidate: optionString(arguments_, 'candidate') }
      : {}),
    ...(optionString(arguments_, 'baseline')
      ? { baseline: optionString(arguments_, 'baseline') }
      : {}),
    ...(optionString(arguments_, 'scene') ? { sceneId: optionString(arguments_, 'scene') } : {}),
    ...(optionString(arguments_, 'review') ? { review: optionString(arguments_, 'review') } : {}),
  });
  print(
    context,
    `Recorded immutable ${stored.approval.scope} ${stored.approval.decision} attestation ${stored.revision} for ${stored.approval.subject.revision}.`,
  );
  return 0;
}

async function commandRollback(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const channel = optionString(arguments_, 'channel');
  if (!channel) throw new CliError('Rollback requires --channel <id-or-slug>.');
  const actor = optionString(arguments_, 'actor');
  if (!actor) throw new CliError('Rollback requires --actor <id>.');
  if (!optionBoolean(arguments_, 'yes', 'y')) {
    throw new CliError('Rollback requires --yes because it advances the atomic Channel pointer.');
  }
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const rolledBack = await rollbackPublication({
    config,
    channel,
    actorId: actor,
    ...(optionString(arguments_, 'release')
      ? { release: optionString(arguments_, 'release') }
      : {}),
    ...(optionString(arguments_, 'destination')
      ? { destination: optionString(arguments_, 'destination') }
      : {}),
  });
  print(
    context,
    `Rolled Channel back to immutable Release ${rolledBack.release.id} (${rolledBack.releaseRevision}); event ${rolledBack.eventRevision}; destination ${rolledBack.destination}.`,
  );
  return 0;
}

async function commandRecord(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  const rawUrl = arguments_.positionals[0];
  if (!rawUrl)
    throw new CliError(
      'Usage: scenebook record <url> [--output scenes/name.scene/automation/replay.ts]',
    );
  const target = prepareRecordingTarget(rawUrl);
  if (!target.local && !optionBoolean(arguments_, 'allow-remote')) {
    throw new CliError(
      'Recording a remote environment requires --allow-remote. Use a synthetic account and never a personal browser profile.',
    );
  }
  const output = resolve(
    context.cwd,
    optionString(arguments_, 'output', 'o') ?? 'scenes/recorded.scene/automation/replay.ts',
  );
  await prepareRecorderArtifactPaths(context.cwd, output);
  const recording = await captureSanitizedPlaywrightRecording({
    cwd: context.cwd,
    env: context.env,
    targetHref: target.href,
  });
  // Recording is interactive and may remain open for minutes. Recheck operations and symlink
  // ancestry immediately before persistence so the file-impact report reflects this invocation.
  const artifactPaths = await prepareRecorderArtifactPaths(context.cwd, output);
  await writeFileAtomically(artifactPaths.replayPath, recording.source, {
    mode: 0o600,
    directoryMode: 0o700,
  });
  const persisted = await readBoundedRegularFileAtPath(artifactPaths.replayPath, {
    minimumBytes: 1,
    maximumBytes: MAX_RECORDING_SOURCE_BYTES,
  });
  if (!Buffer.from(persisted.bytes).equals(Buffer.from(recording.source, 'utf8'))) {
    throw new CliError(
      'Sanitized recorder output changed during persistence; no Scene was scaffolded.',
    );
  }
  const scaffold = await scaffoldRecordedScene({
    replayPath: artifactPaths.replayPath,
    targetHref: target.href,
    title: optionString(arguments_, 'name'),
  });
  const review = await writeRecorderReviewArtifacts({
    paths: artifactPaths,
    source: recording.source,
    placeholders: recording.placeholders,
    manifestCreated: scaffold.created,
  });
  print(
    context,
    `Recorded a sanitized Playwright draft at ${relative(context.cwd, artifactPaths.replayPath)} with ${recording.placeholders.length} fixture placeholder(s). ${scaffold.created ? `Created portable Captured Scene source at ${relative(context.cwd, scaffold.manifestPath)}.` : `Existing ${relative(context.cwd, scaffold.manifestPath)} was left unchanged.`} Wrote a privacy-safe review at ${relative(context.cwd, artifactPaths.reviewPath)} with ${review.summary.suggestedSteps} Step suggestion(s), ${review.summary.warnings} warning(s), and an unapplied exact patch at ${relative(context.cwd, artifactPaths.patchPath)}. Curate and verify the proposal before changing executable truth.`,
  );
  return 0;
}

async function resolveOcrProvider(arguments_: ParsedArguments): Promise<OcrProvider> {
  const providerName = uniqueOption(arguments_, 'provider') ?? 'tesseract';
  if (providerName === 'tesseract') {
    for (const name of ['command-json', 'scanner-id', 'scanner-version']) {
      if (arguments_.options.has(name)) {
        throw new CliError(`--${name} requires --provider command.`);
      }
    }
    return tesseractProvider();
  }
  if (providerName !== 'command') {
    throw new CliError('Privacy scan provider must be tesseract or command.');
  }
  const encoded = uniqueOption(arguments_, 'command-json');
  const version = uniqueOption(arguments_, 'scanner-version');
  if (!encoded || !version) {
    throw new CliError(
      'The command provider requires --command-json \'["executable","{input}"]\' and --scanner-version <version>.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new CliError('--command-json must be a JSON array of command arguments.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((value) => typeof value === 'string' && !value.includes('\u0000'))
  ) {
    throw new CliError('--command-json must be a non-empty JSON array of strings.');
  }
  return createCommandOcrProvider({
    command: parsed as [string, ...string[]],
    id: uniqueOption(arguments_, 'scanner-id') ?? 'local-command',
    version,
  });
}

async function commandPrivacy(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  if (arguments_.positionals[0] !== 'scan') {
    throw new CliError('Usage: scenebook privacy scan [--provider tesseract]');
  }
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const provider = await resolveOcrProvider(arguments_);
  const runReference = optionString(arguments_, 'run');
  if (runReference) {
    const evidenceDirectory = resolve(config.directory, '.scenebook/runs');
    const runPath = resolve(config.directory, runReference);
    const logical = relative(evidenceDirectory, runPath);
    if (!logical || logical.startsWith('..') || isAbsolute(logical)) {
      throw new CliError('--run must point to a Run artifact inside .scenebook/runs.');
    }
    const attested = await attestRunEvidence({
      runPath,
      evidenceDirectory,
      baselineDirectory: resolve(config.directory, config.config.paths.baselines),
      assessmentDirectory: resolve(config.directory, '.scenebook/privacy/evidence'),
      provider,
      scanOptions: projectPrivacyScanOptions(config),
      policyDigest: projectPrivacyPolicyDigest(config),
    });
    await refreshEvidenceBuilds({
      evidenceDirectory,
      baselineDirectory: resolve(config.directory, config.config.paths.baselines),
    });
    print(
      context,
      `Attested exact Run ${attested.run.id}: privacy ${attested.run.privacy.status} · review ${attested.review.changeState} · ${attested.assessments.length} screenshot(s).`,
    );
    return attested.run.privacy.status === 'blocked' ||
      attested.run.privacy.status === 'quarantined'
      ? 2
      : 0;
  }
  // External OCR providers can execute in a different runtime namespace (for
  // example `nix shell`) whose OS temp directory does not match this process.
  // Keep exact publication derivatives in a private project-local staging area
  // until every provider has consumed them, then remove the area in `finally`.
  const stagingRoot = resolve(config.directory, '.scenebook/staging');
  await mkdir(stagingRoot, { recursive: true });
  const temporary = await mkdtemp(join(stagingRoot, 'privacy-scan-'));
  try {
    const requestedScanFormats = optionStrings(arguments_, 'format');
    const result = await buildProject(config, {
      ...publicationSelection(arguments_),
      ...(requestedScanFormats.length ? { formats: requestedScanFormats } : {}),
      output: temporary,
      allowUnscannedPrivacy: true,
      locale: optionString(arguments_, 'locale'),
      fallbackLocale: optionString(arguments_, 'fallback-locale'),
    });
    const assessments = await scanAssetFiles({
      assets: result.manifest.assets
        .filter((asset) => asset.privacyBasis === 'ocr')
        .map((asset) => ({
          hash: asset.hash,
          path: resolve(result.outputDirectory, asset.path),
        })),
      provider,
      assessmentDirectory: resolve(config.directory, '.scenebook/privacy'),
      scanOptions: projectPrivacyScanOptions(config),
      policyDigest: projectPrivacyPolicyDigest(config),
    });
    for (const assessment of assessments) {
      print(
        context,
        `${assessment.assetHash}  ${assessment.status}  ${assessment.findings.length} finding(s)`,
      );
    }
    print(
      context,
      `Scanned ${assessments.length} sanitized publication derivative(s) with ${provider.id}/${provider.version}.`,
    );
    return assessments.some((assessment) => assessment.status === 'blocked') ? 2 : 0;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function requestedPlaywrightShard(
  arguments_: ParsedArguments,
): { readonly current: number; readonly total: number } | undefined {
  if (arguments_.options.has('shard')) {
    throw new CliError('Forward Playwright sharding after --, for example: -- --shard=1/2.');
  }
  let shard: { readonly current: number; readonly total: number } | undefined;
  for (const [index, value] of arguments_.positionals.entries()) {
    const raw = value.startsWith('--shard=')
      ? value.slice('--shard='.length)
      : value === '--shard'
        ? arguments_.positionals[index + 1]
        : undefined;
    if (!raw) continue;
    const match = /^(\d+)\/(\d+)$/u.exec(raw);
    if (!match) throw new CliError('Playwright --shard must use current/total positive integers.');
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (current < 1 || total < 1 || current > total) {
      throw new CliError('Playwright --shard current must be between 1 and total.');
    }
    if (shard) throw new CliError('Playwright --shard may only be forwarded once.');
    shard = { current, total };
  }
  return shard;
}

async function commandMergeShardBuilds(
  arguments_: ParsedArguments,
  context: CliContext,
): Promise<number> {
  const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
  const evidenceDirectory = resolve(config.directory, '.scenebook/runs');
  const paths = await glob('shards/*/build.json', {
    cwd: evidenceDirectory,
    absolute: true,
    onlyFiles: true,
  });
  const fragments = await Promise.all(
    paths.map(async (path) => BuildArtifactSchema.parse(JSON.parse(await readFile(path, 'utf8')))),
  );
  let build: BuildArtifact;
  try {
    build = mergeShardBuildEvidence(fragments);
  } catch (error) {
    throw new CliError(
      `Cannot finalize shard Builds: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  await writeFileAtomically(
    resolve(evidenceDirectory, 'build.json'),
    `${stableStringify(build)}\n`,
    { mode: 0o600 },
  );
  await refreshEvidenceBuilds({
    evidenceDirectory,
    baselineDirectory: resolve(config.directory, config.config.paths.baselines),
  });
  build = await readCiBuildArtifact(resolve(evidenceDirectory, 'build.json'));
  const summary = ciSummary(build);
  if (context.env.GITHUB_STEP_SUMMARY) await appendFile(context.env.GITHUB_STEP_SUMMARY, summary);
  else print(context, summary);
  return ciExitCode(build);
}

async function commandCi(arguments_: ParsedArguments, context: CliContext): Promise<number> {
  if (arguments_.positionals[0] === 'merge-shards') {
    return commandMergeShardBuilds(arguments_, context);
  }
  // Resolve and authorize the target before deleting a prior artifact or
  // creating the temporary Playwright safety config.
  const preflight = await playwrightPreflight(arguments_, context);
  const { config, selection } = preflight;
  const uploadSettings = hostedUploadSettings(arguments_, context, config);
  if (uploadSettings) await assertHostedGitHead(config, uploadSettings, context.env);
  const requestedShard = requestedPlaywrightShard(arguments_);
  const buildPath = requestedShard
    ? resolve(
        config.directory,
        '.scenebook/runs/shards',
        `${requestedShard.current}-of-${requestedShard.total}`,
        'build.json',
      )
    : resolve(config.directory, '.scenebook/runs/build.json');
  await rm(buildPath, { force: true });
  let runnerError: unknown;
  try {
    await runPlaywrightTests(arguments_, context, preflight);
  } catch (error) {
    runnerError = error;
  }
  let build: Awaited<ReturnType<typeof readCiBuildArtifact>>;
  try {
    build = await readCiBuildArtifact(buildPath);
  } catch (error) {
    if (runnerError) throw runnerError;
    throw error;
  }
  const reportedTargetIds = new Set([
    ...build.expectedRunPlan.map((entry) => entry.runTargetId),
    ...build.runs.map((entry) => entry.runTargetId),
  ]);
  if (
    build.projectId !== config.project.id ||
    reportedTargetIds.size !== 1 ||
    !reportedTargetIds.has(selection.target.id)
  ) {
    throw new CliError(
      `Playwright reporter binding mismatch: expected Project ${config.project.id} / Run Target ${selection.target.id}, received Project ${build.projectId} / Run Target(s) ${[...reportedTargetIds].join(', ') || '(none)'}.`,
      2,
    );
  }
  if (!optionBoolean(arguments_, 'allow-unscanned-privacy')) {
    const provider = await resolveOcrProvider(arguments_);
    const evidenceDirectory = resolve(config.directory, '.scenebook/runs');
    for (const reference of build.runs) {
      if (!reference.run?.path) continue;
      const runPath = resolve(evidenceDirectory, reference.run.path);
      const logical = relative(evidenceDirectory, runPath);
      if (!logical || logical.startsWith('..') || isAbsolute(logical)) {
        throw new CliError(`Reporter emitted an unsafe Run path: ${reference.run.path}`);
      }
      await attestRunEvidence({
        runPath,
        evidenceDirectory,
        baselineDirectory: resolve(config.directory, config.config.paths.baselines),
        assessmentDirectory: resolve(config.directory, '.scenebook/privacy/evidence'),
        provider,
        scanOptions: projectPrivacyScanOptions(config),
        policyDigest: projectPrivacyPolicyDigest(config),
      });
    }
    await refreshEvidenceBuilds({
      evidenceDirectory,
      baselineDirectory: resolve(config.directory, config.config.paths.baselines),
    });
    build = await readCiBuildArtifact(buildPath);
  }
  let exportError: unknown;
  try {
    await commandBuild(arguments_, context);
  } catch (error) {
    exportError = error;
  }
  const summary = ciSummary(build);
  if (context.env.GITHUB_STEP_SUMMARY) await appendFile(context.env.GITHUB_STEP_SUMMARY, summary);
  else print(context, summary);
  if (exportError) throw exportError;
  if (runnerError) {
    context.stderr.write(
      `Playwright reported ${build.status}: ${runnerError instanceof Error ? runnerError.message : String(runnerError)}\n`,
    );
  }
  const exitCode = ciExitCode(build, Boolean(runnerError));
  if (!uploadSettings) return exitCode;
  if (build.summary.broken > 0 || build.summary.blocked > 0 || build.summary.pending > 0) {
    return exitCode;
  }
  await assertHostedGitHead(config, uploadSettings, context.env);
  const provider = await resolveOcrProvider(arguments_);
  const publicationDirectory = resolve(
    config.directory,
    optionString(arguments_, 'output', 'o') ?? config.config.paths.output,
  );
  const uploaded = await uploadHostedCiEvidence({
    config,
    settings: uploadSettings,
    buildPath,
    build,
    publicationDirectory,
    provider,
  });
  const uploadSummary = `Hosted evidence upload ${uploaded.uploadId} finalized ${uploaded.objectCount} immutable object(s) (${uploaded.byteLength} bytes; ${uploaded.sceneCount} Scene revision(s), ${uploaded.runCount} Run(s), ${uploaded.reviewCount} Review(s)); upload manifest ${uploaded.manifestHash}; publication tree ${uploaded.publication.treeHash}.`;
  print(context, uploadSummary);
  if (context.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      context.env.GITHUB_STEP_SUMMARY,
      `\n### Hosted evidence\n\n${uploadSummary}\n`,
    );
  }
  return exitCode;
}

export async function executeCommand(
  arguments_: ParsedArguments,
  context: CliContext,
): Promise<number> {
  if (optionBoolean(arguments_, 'version', 'v')) {
    print(context, '0.1.0');
    return 0;
  }
  if (optionBoolean(arguments_, 'help', 'h') || !arguments_.command) {
    print(context, HELP);
    return 0;
  }
  if (arguments_.command === 'help') {
    print(context, HELP);
    return 0;
  }
  switch (arguments_.command) {
    case 'init':
      return commandInit(arguments_, context);
    case 'dev': {
      const config = await loadConfig(context.cwd, optionString(arguments_, 'config'));
      const port = Number.parseInt(optionString(arguments_, 'port', 'p') ?? '6100', 10);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new CliError('Port must be between 1 and 65535.');
      const output = optionString(arguments_, 'output', 'o');
      await startDevServer(config, {
        host: optionString(arguments_, 'host') ?? '127.0.0.1',
        port,
        allowUnscannedPrivacy: optionBoolean(arguments_, 'allow-unscanned-privacy'),
        ...(output ? { output } : {}),
        ...publicationSelection(arguments_),
      });
      return 0;
    }
    case 'build':
      return commandBuild(arguments_, context);
    case 'export':
      return commandExport(arguments_, context);
    case 'import':
      return commandImport(arguments_, context);
    case 'docs':
      return commandDocs(arguments_, context);
    case 'test':
      return commandTest(arguments_, context);
    case 'doctor':
      return commandDoctor(arguments_, context);
    case 'schema':
      return commandSchema(arguments_, context);
    case 'migrate':
      return commandMigrate(arguments_, context);
    case 'review':
      return commandReview(arguments_, context);
    case 'baseline':
      return commandBaseline(arguments_, context);
    case 'approve':
      return commandApprove(arguments_, context);
    case 'publish':
      return commandPublish(arguments_, context);
    case 'rollback':
      return commandRollback(arguments_, context);
    case 'record':
      return commandRecord(arguments_, context);
    case 'privacy':
      return commandPrivacy(arguments_, context);
    case 'ci':
      return commandCi(arguments_, context);
    default:
      throw new CliError(
        `Unknown command: ${arguments_.command}. Run \`scenebook --help\` for usage.`,
        2,
      );
  }
}
