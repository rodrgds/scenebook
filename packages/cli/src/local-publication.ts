import { randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { loadSceneDirectory, type CompileResult, type LoadedScene } from '@scenebook/compiler';
import {
  artifactHash,
  canonicalJsonHash,
  createDeterministicId,
  sceneSourceRevision,
  sha256,
  stableStringify,
} from '@scenebook/core';
import { evaluateChannelPolicy, type HealthStatus } from '@scenebook/policy';
import { readBoundedRegularFile, SafeFileReadError } from '@scenebook/playwright';
import {
  ApprovalAttestationSchema,
  ARTIFACT_VERSION,
  BaselinePointerSchema,
  BaselineSchema,
  BuildArtifactSchema,
  CandidatePointerSchema,
  ChannelPointerSchema,
  CompilerPublicationManifestSchema,
  PublicationCandidateSchema,
  PublicationEventSchema,
  PublicationInventorySchema,
  PublicationReleaseSchema,
  ReviewSchema,
  RunArtifactSchema,
  SCHEMA_VERSION,
  type ApprovalAttestation,
  type Baseline,
  type BuildArtifact,
  type CandidatePointer,
  type Channel,
  type ChannelPointer,
  type ExactArtifactBinding,
  type PublicationCandidate,
  type PublicationCandidateScene,
  type PublicationEvent,
  type PublicationFile,
  type PublicationRelease,
  type PublicationReleaseScene,
  type Review,
  type RunArtifact,
} from '@scenebook/schema';

import { writeFileAtomically } from './atomic-write.js';
import { createCompiledPublicationArchive } from './hosted-upload.js';
import { sceneDirectories } from './project.js';
import { CliError, type LoadedConfig } from './types.js';

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PUBLICATION_FILE_BYTES = 250 * 1024 * 1024;
const PRODUCER = { name: '@scenebook/cli', version: '0.1.0', runtime: process.version } as const;

interface StoredCandidate {
  readonly candidate: PublicationCandidate;
  readonly revision: string;
  readonly directory: string;
}

interface StoredRelease {
  readonly release: PublicationRelease;
  readonly revision: string;
  readonly path: string;
}

interface VerifiedEvidence {
  readonly build: BuildArtifact;
  readonly runs: ReadonlyMap<string, RunArtifact>;
  readonly reviews: ReadonlyMap<string, Review>;
}

interface BaselineEvidence {
  readonly baseline: Baseline;
  readonly binding: ExactArtifactBinding;
  readonly approvals: readonly ApprovalAttestation[];
}

function publicationRoot(config: LoadedConfig): string {
  return resolve(config.directory, config.config.paths.publication);
}

function relativeStorePath(config: LoadedConfig, absolutePath: string): string {
  const logical = relative(publicationRoot(config), absolutePath).replaceAll('\\', '/');
  if (!logical || logical.startsWith('../') || isAbsolute(logical)) {
    throw new CliError(`Immutable publication path escaped its store: ${absolutePath}.`);
  }
  return logical;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${stableStringify(value)}\n`);
}

function safeRelativePath(value: string, label = 'Publication'): string {
  if (
    !value ||
    value.length > 2_000 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.includes('\u0000') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new CliError(`${label} path is unsafe: ${value}.`);
  }
  return value;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new CliError(`Publication storage must be a real directory: ${path}.`);
  }
}

async function ensureProjectStoreDirectory(
  config: LoadedConfig,
  path: string,
  label: string,
): Promise<void> {
  const root = resolve(config.directory);
  const destination = resolve(path);
  const logical = relative(root, destination);
  if (!logical || logical.startsWith(`..${sep}`) || logical === '..' || isAbsolute(logical)) {
    throw new CliError(`${label} must be a dedicated directory inside the configured Project.`);
  }
  await ensurePrivateDirectory(destination);
  let current = root;
  for (const segment of logical.split(sep)) {
    current = resolve(current, segment);
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new CliError(`${label} cannot contain a symbolic-link path component: ${current}.`);
    }
  }
}

async function ensurePublicationRoot(config: LoadedConfig): Promise<void> {
  await ensureProjectStoreDirectory(config, publicationRoot(config), 'Publication storage');
}

async function ensureBaselineRoot(config: LoadedConfig): Promise<void> {
  await ensureProjectStoreDirectory(
    config,
    resolve(config.directory, config.config.paths.baselines),
    'Baseline storage',
  );
}

/** Validate private immutable roots before any evidence asset or metadata write. */
export async function validateLocalTrustStorage(config: LoadedConfig): Promise<void> {
  await ensureBaselineRoot(config);
  await ensurePublicationRoot(config);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSafeFile(
  root: string,
  logicalPath: string,
  maximumBytes = MAX_JSON_BYTES,
): Promise<Uint8Array> {
  const safe = safeRelativePath(logicalPath);
  try {
    return (
      await readBoundedRegularFile(root, safe, {
        maximumBytes,
        minimumBytes: 1,
      })
    ).bytes;
  } catch (error) {
    if (error instanceof SafeFileReadError) {
      throw new CliError(`Publication file is unsafe (${error.reason}): ${safe}.`);
    }
    throw error;
  }
}

async function readJson<T>(
  root: string,
  logicalPath: string,
  parse: (input: unknown) => T,
): Promise<T> {
  const bytes = await readSafeFile(root, logicalPath);
  try {
    return parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch (error) {
    throw new CliError(
      `Invalid immutable JSON at ${logicalPath}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

async function writeImmutableFile(path: string, contents: Uint8Array): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new CliError(`Immutable object path is not a regular file: ${path}.`);
    }
    const current = await readFile(path);
    if (!Buffer.from(current).equals(contents)) {
      throw new CliError(`Immutable object collision at ${path}.`);
    }
    return;
  }
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const current = await readFile(path);
    if (!Buffer.from(current).equals(contents)) {
      throw new CliError(`Immutable object collision at ${path}.`);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await writeImmutableFile(path, jsonBytes(value));
}

async function assertPointerDestination(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new CliError(`Mutable publication pointer is not a regular file: ${path}.`);
  }
}

function resolveChannel(config: LoadedConfig, token: string): Channel {
  const byId = config.project.channels.find((channel) => channel.id === token);
  if (byId) return byId;
  const bySlug = config.project.channels.filter((channel) => channel.slug === token);
  if (bySlug.length === 1 && bySlug[0]) return bySlug[0];
  if (bySlug.length > 1) throw new CliError(`Ambiguous Channel slug ${token}; use its exact id.`);
  throw new CliError(`Unknown Channel ${token}.`);
}

function binding(
  kind: ExactArtifactBinding['kind'],
  id: string,
  revision: string,
  path?: string,
): ExactArtifactBinding {
  return { kind, id, revision, ...(path ? { path } : {}) };
}

function projectLogicalPath(config: LoadedConfig, path: string, label: string): string {
  const absolute = resolve(config.directory, path);
  const logical = relative(config.directory, absolute).replaceAll('\\', '/');
  if (!logical || logical.startsWith('../') || isAbsolute(logical)) {
    throw new CliError(`${label} must be inside the configured project directory.`);
  }
  return safeRelativePath(logical, label);
}

async function loadBuild(
  config: LoadedConfig,
  path: string,
): Promise<{
  readonly build: BuildArtifact;
  readonly revision: string;
  readonly root: string;
}> {
  const logical = projectLogicalPath(config, path, 'Build artifact');
  const build = await readJson(config.directory, logical, (input) =>
    BuildArtifactSchema.parse(input),
  );
  if (
    build.projectId !== config.project.id ||
    build.completeness !== 'complete' ||
    build.shard ||
    !build.endedAt ||
    ['pending', 'running', 'cancelled'].includes(build.status)
  ) {
    throw new CliError(
      'Candidate sealing requires one finalized, complete Build for this Project.',
    );
  }
  return {
    build,
    revision: artifactHash(build),
    root: dirname(resolve(config.directory, logical)),
  };
}

function assertClearPrivacy(run: RunArtifact): void {
  const summaries = [
    run.privacy,
    ...run.attempts.flatMap((attempt) => [
      attempt.privacy,
      ...attempt.states.map((state) => state.privacy),
    ]),
  ];
  if (summaries.some((summary) => summary.status !== 'clear')) {
    throw new CliError(
      `Run ${run.id} is not backed exclusively by clear, scanned privacy evidence. Overrides never satisfy publication privacy.`,
    );
  }
}

async function discoverReviews(
  buildRoot: string,
  projectId: string,
  subjects: ReadonlyMap<string, { readonly kind: 'build' | 'run'; readonly id: string }>,
): Promise<Array<{ readonly review: Review; readonly revision: string }>> {
  const directory = resolve(buildRoot, 'reviews');
  const status = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!status) return [];
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new CliError('Build Review evidence directory must be a real directory.');
  }
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const reviews: Array<{ review: Review; revision: string }> = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new CliError(`Review evidence must be a regular JSON file: ${entry.name}.`);
    }
    const review = ReviewSchema.parse(
      JSON.parse(await readFile(join(directory, entry.name), 'utf8')),
    );
    const subject = subjects.get(review.subject.revision);
    if (!subject) continue;
    if (
      review.projectId !== projectId ||
      review.subject.kind !== subject.kind ||
      review.subject.id !== subject.id
    ) {
      throw new CliError(`Review ${review.id} contradicts its exact Build or Run subject.`);
    }
    reviews.push({ review, revision: artifactHash(review) });
  }
  return reviews;
}

function localeRevisions(
  config: LoadedConfig,
  loaded: LoadedScene,
): {
  readonly revisions: Record<string, string>;
  readonly complete: boolean;
} {
  const revisions: Record<string, string> = {};
  const defaultNarrative = loaded.narrative
    ? sha256(loaded.narrative)
    : sceneSourceRevision(loaded.scene);
  revisions[loaded.scene.defaultLocale] = defaultNarrative;
  for (const [locale, translation] of Object.entries(loaded.scene.translations)) {
    revisions[locale] = canonicalJsonHash(translation);
  }
  for (const [locale, translation] of Object.entries(loaded.locales)) {
    revisions[locale] = canonicalJsonHash(translation);
  }
  return {
    revisions,
    complete: config.project.locales.every((locale) => revisions[locale] !== undefined),
  };
}

function sceneFiles(
  scene: CompileResult['manifest']['scenes'][number],
  inventory: readonly PublicationFile[],
  assets: CompileResult['manifest']['assets'],
): PublicationFile[] {
  const paths = new Set<string>([
    scene.evidence,
    ...Object.values(scene.outputs).flatMap((outputs) => outputs ?? []),
  ]);
  const assetPaths = new Map(assets.map((asset) => [asset.hash, asset.path]));
  for (const hash of scene.assets) {
    const path = assetPaths.get(hash);
    if (path) paths.add(path);
  }
  const selected = inventory.filter((file) => paths.has(file.path));
  const missing = [...paths].filter((path) => !selected.some((file) => file.path === path));
  if (missing.length > 0) {
    throw new CliError(`Compiled Scene ${scene.id} is missing owned files: ${missing.join(', ')}.`);
  }
  return selected;
}

async function copyVerifiedPublicationTree(
  sourceRoot: string,
  destinationRoot: string,
  files: readonly PublicationFile[],
): Promise<void> {
  await ensurePrivateDirectory(destinationRoot);
  for (const file of files) {
    const bytes = await readSafeFile(sourceRoot, file.path, MAX_PUBLICATION_FILE_BYTES);
    if (bytes.byteLength !== file.byteLength || sha256(bytes) !== file.sha256) {
      throw new CliError(`Publication file changed after archival: ${file.path}.`);
    }
    const destination = resolve(destinationRoot, file.path);
    await ensurePrivateDirectory(dirname(destination));
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
}

async function listRegularFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new CliError(`Publication trees cannot contain links: ${path}.`);
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    else throw new CliError(`Publication tree contains a non-regular entry: ${path}.`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function writeCandidateObject(
  config: LoadedConfig,
  staging: string,
  candidate: PublicationCandidate,
): Promise<StoredCandidate> {
  const root = publicationRoot(config);
  const objectsRoot = resolve(root, 'candidates/objects');
  const revision = canonicalJsonHash(candidate);
  const destination = resolve(objectsRoot, revision);
  await writeFile(resolve(staging, 'candidate.json'), jsonBytes(candidate), {
    flag: 'wx',
    mode: 0o600,
  });
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new CliError(`Candidate object collision at ${destination}.`);
    }
    const stored = await readJson(destination, 'candidate.json', (input) =>
      PublicationCandidateSchema.parse(input),
    );
    if (canonicalJsonHash(stored) !== revision) {
      throw new CliError(`Candidate object collision at ${destination}.`);
    }
    await rm(staging, { recursive: true, force: true });
    return { candidate: stored, revision, directory: destination };
  }
  try {
    await rename(staging, destination);
    await syncDirectory(objectsRoot);
  } catch (error) {
    const raced = await lstat(destination).catch(() => undefined);
    if (!raced) throw error;
    await rm(staging, { recursive: true, force: true });
    const stored = await readJson(destination, 'candidate.json', (input) =>
      PublicationCandidateSchema.parse(input),
    );
    if (canonicalJsonHash(stored) !== revision) throw error;
  }
  return { candidate, revision, directory: destination };
}

export async function sealPublicationCandidate(options: {
  readonly config: LoadedConfig;
  readonly result: CompileResult;
  readonly channel: string;
  readonly collection?: string;
  readonly buildPath: string;
}): Promise<StoredCandidate> {
  await ensurePublicationRoot(options.config);
  const channel = resolveChannel(options.config, options.channel);
  const selectedChannel = options.result.manifest.publication.selection.channelId;
  if (selectedChannel !== channel.id) {
    throw new CliError('Compiler output does not bind the requested Channel exactly.');
  }
  if (options.result.manifest.privacy.status !== 'passed') {
    throw new CliError(
      'Immutable publication candidates require fully scanned, passed publication privacy. Local overrides cannot be sealed.',
    );
  }
  const buildSource = await loadBuild(options.config, options.buildPath);
  const loadedScenes = await Promise.all(
    (await sceneDirectories(options.config)).map((directory) => loadSceneDirectory(directory)),
  );
  const loadedById = new Map(loadedScenes.map((loaded) => [loaded.scene.id, loaded]));
  const compiledSceneIds = new Set(options.result.manifest.scenes.map((scene) => scene.id));
  const planByScene = new Map<string, BuildArtifact['expectedRunPlan']>();
  for (const planned of buildSource.build.expectedRunPlan) {
    if (!compiledSceneIds.has(planned.sceneId)) continue;
    const entries = planByScene.get(planned.sceneId) ?? [];
    entries.push(planned);
    planByScene.set(planned.sceneId, entries);
  }
  const buildReferences = new Map(
    buildSource.build.runs.map((reference) => [
      `${reference.sceneId}\u0000${reference.runTargetId}`,
      reference,
    ]),
  );
  const runs = new Map<string, { run: RunArtifact; revision: string }>();
  for (const reference of buildSource.build.runs) {
    if (!compiledSceneIds.has(reference.sceneId) || !reference.run) continue;
    const runPath = safeRelativePath(reference.run.path ?? `runs/${reference.run.id}.json`, 'Run');
    const run = await readJson(buildSource.root, runPath, (input) =>
      RunArtifactSchema.parse(input),
    );
    const revision = artifactHash(run);
    if (revision !== reference.run.sha256) {
      throw new CliError(`Run ${run.id} does not match its exact Build reference.`);
    }
    if (
      run.id !== reference.run.id ||
      run.projectId !== options.config.project.id ||
      run.sceneId !== reference.sceneId ||
      run.runTargetId !== reference.runTargetId ||
      run.status !== reference.status ||
      run.changeState !== reference.changeState ||
      stableStringify(run.repository) !== stableStringify(buildSource.build.repository) ||
      (run.buildId !== undefined && run.buildId !== buildSource.build.id)
    ) {
      throw new CliError(`Run ${run.id} contradicts its Build binding.`);
    }
    assertClearPrivacy(run);
    runs.set(`${run.sceneId}\u0000${run.runTargetId}`, { run, revision });
  }
  const subjects = new Map<string, { kind: 'build' | 'run'; id: string }>([
    [buildSource.revision, { kind: 'build', id: buildSource.build.id }],
    ...[...runs.values()].map(
      ({ run, revision }) => [revision, { kind: 'run' as const, id: run.id }] as const,
    ),
  ]);
  const reviews = await discoverReviews(buildSource.root, options.config.project.id, subjects);
  const root = publicationRoot(options.config);
  const objectsRoot = resolve(root, 'candidates/objects');
  await ensurePrivateDirectory(objectsRoot);
  const staging = await mkdtemp(resolve(objectsRoot, '.candidate-staging-'));
  try {
    const archived = await createCompiledPublicationArchive(
      options.result.outputDirectory,
      staging,
    );
    const compilerManifest = CompilerPublicationManifestSchema.parse(
      JSON.parse(await readFile(resolve(options.result.outputDirectory, 'manifest.json'), 'utf8')),
    );
    const treeRoot = resolve(staging, 'tree');
    await copyVerifiedPublicationTree(
      options.result.outputDirectory,
      treeRoot,
      archived.inventory.files,
    );
    await ensurePrivateDirectory(resolve(staging, 'evidence/runs'));
    await ensurePrivateDirectory(resolve(staging, 'evidence/reviews'));
    await writeFile(resolve(staging, 'evidence/build.json'), jsonBytes(buildSource.build), {
      flag: 'wx',
      mode: 0o600,
    });
    for (const { run, revision } of runs.values()) {
      await writeFile(resolve(staging, `evidence/runs/${revision}.json`), jsonBytes(run), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    for (const { review, revision } of reviews) {
      await writeFile(resolve(staging, `evidence/reviews/${revision}.json`), jsonBytes(review), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    await writeFile(resolve(staging, 'inventory.json'), jsonBytes(archived.inventory), {
      flag: 'wx',
      mode: 0o600,
    });
    const candidateScenes: PublicationCandidateScene[] = options.result.manifest.scenes.map(
      (compiled) => {
        const loaded = loadedById.get(compiled.id);
        if (!loaded) throw new CliError(`Compiled Scene ${compiled.id} has no source artifact.`);
        const sourceRevision = sceneSourceRevision(loaded.scene);
        if (sourceRevision !== compiled.sourceHash) {
          throw new CliError(
            `Compiled Scene ${compiled.id} does not match its current source revision.`,
          );
        }
        const localized = localeRevisions(options.config, loaded);
        const plan = planByScene.get(compiled.id) ?? [];
        const runBindings = plan.map((planned) => {
          const exact = runs.get(`${planned.sceneId}\u0000${planned.runTargetId}`);
          const reference = buildReferences.get(`${planned.sceneId}\u0000${planned.runTargetId}`);
          if (!exact || !reference) {
            return {
              runTargetId: planned.runTargetId,
              required: planned.required,
              reviews: [],
              fresh: false,
            };
          }
          const fresh =
            exact.run.sourceRevision === sourceRevision &&
            (exact.run.narrativeRevision === undefined ||
              exact.run.narrativeRevision ===
                (loaded.narrative ? sha256(loaded.narrative) : undefined)) &&
            (exact.run.themeRevision === undefined ||
              exact.run.themeRevision ===
                (loaded.theme ? canonicalJsonHash(loaded.theme) : undefined));
          const runReviews = reviews.filter(
            ({ review }) =>
              review.subject.kind === 'run' && review.subject.revision === exact.revision,
          );
          return {
            runTargetId: planned.runTargetId,
            required: planned.required,
            run: binding(
              'run',
              exact.run.id,
              exact.revision,
              `evidence/runs/${exact.revision}.json`,
            ),
            reviews: runReviews.map(({ review, revision }) =>
              binding('review', review.id, revision, `evidence/reviews/${revision}.json`),
            ),
            status: exact.run.status,
            ...(exact.run.changeState ? { changeState: exact.run.changeState } : {}),
            privacy: exact.run.privacy,
            fresh,
          };
        });
        return {
          sceneId: compiled.id,
          slug: compiled.slug,
          criticality: loaded.scene.criticality,
          sourceRevision,
          ...(loaded.narrative ? { narrativeRevision: sha256(loaded.narrative) } : {}),
          ...(loaded.theme ? { themeRevision: canonicalJsonHash(loaded.theme) } : {}),
          localeRevisions: localized.revisions,
          localizationComplete: localized.complete,
          runs: runBindings,
          files: sceneFiles(compiled, archived.files, options.result.manifest.assets),
        };
      },
    );
    const createdAt = options.result.manifest.generatedAt;
    const candidate = PublicationCandidateSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      artifactVersion: ARTIFACT_VERSION,
      id: createDeterministicId(
        'candidate',
        `${channel.id}:${buildSource.revision}:${archived.publication.treeHash}`,
        32,
      ),
      projectId: options.config.project.id,
      createdAt,
      producer: PRODUCER,
      kind: 'publication-candidate',
      channelId: channel.id,
      ...(options.collection && options.result.manifest.publication.selection.collectionIds[0]
        ? { collectionId: options.result.manifest.publication.selection.collectionIds[0] }
        : {}),
      sourceBuild: binding(
        'build',
        buildSource.build.id,
        buildSource.revision,
        'evidence/build.json',
      ),
      repository: buildSource.build.repository,
      publication: archived.publication,
      inventory: archived.inventory,
      compilerManifest,
      reviews: reviews.map(({ review, revision }) =>
        binding('review', review.id, revision, `evidence/reviews/${revision}.json`),
      ),
      scenes: candidateScenes,
    });
    const stored = await writeCandidateObject(options.config, staging, candidate);
    await verifyCandidate(stored);
    const pointer = CandidatePointerSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      kind: 'candidate-pointer',
      projectId: options.config.project.id,
      channelId: channel.id,
      candidate: binding(
        'publication-candidate',
        candidate.id,
        stored.revision,
        relativeStorePath(options.config, resolve(stored.directory, 'candidate.json')),
      ),
      updatedAt: createdAt,
    });
    const pointerPath = resolve(root, `candidates/channels/${channel.id}.json`);
    await assertPointerDestination(pointerPath);
    await writeFileAtomically(pointerPath, jsonBytes(pointer), {
      mode: 0o600,
      directoryMode: 0o700,
    });
    return stored;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function resolveCandidateToken(
  config: LoadedConfig,
  channel: Channel,
  token?: string,
): Promise<StoredCandidate> {
  await ensurePublicationRoot(config);
  const root = publicationRoot(config);
  let revision = token;
  if (!revision) {
    const pointer = await readJson(root, `candidates/channels/${channel.id}.json`, (input) =>
      CandidatePointerSchema.parse(input),
    );
    if (pointer.projectId !== config.project.id || pointer.channelId !== channel.id) {
      throw new CliError('Active candidate pointer belongs to another Project or Channel.');
    }
    revision = pointer.candidate.revision;
  }
  const objectsRoot = resolve(root, 'candidates/objects');
  let candidates: string[];
  if (/^[a-f0-9]{64}$/u.test(revision)) candidates = [revision];
  else {
    candidates = (await readdir(objectsRoot)).filter((entry) => /^[a-f0-9]{64}$/u.test(entry));
  }
  for (const candidateRevision of candidates.sort()) {
    const directory = resolve(objectsRoot, candidateRevision);
    const candidate = await readJson(directory, 'candidate.json', (input) =>
      PublicationCandidateSchema.parse(input),
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!candidate) continue;
    const actual = canonicalJsonHash(candidate);
    if (actual !== candidateRevision) {
      throw new CliError(
        `Candidate object ${candidateRevision} failed canonical hash verification.`,
      );
    }
    if (revision !== candidateRevision && candidate.id !== revision) continue;
    if (candidate.projectId !== config.project.id || candidate.channelId !== channel.id) {
      throw new CliError('Publication candidate belongs to another Project or Channel.');
    }
    return { candidate, revision: actual, directory };
  }
  throw new CliError(`Unknown immutable publication candidate ${revision}.`);
}

async function verifyCandidate(stored: StoredCandidate): Promise<VerifiedEvidence> {
  const { candidate, directory } = stored;
  const inventoryBytes = await readSafeFile(directory, 'inventory.json');
  if (
    sha256(inventoryBytes) !== candidate.publication.inventory.sha256 ||
    inventoryBytes.byteLength !== candidate.publication.inventory.byteLength
  ) {
    throw new CliError('Candidate inventory bytes do not match its immutable descriptor.');
  }
  const inventory = PublicationInventorySchema.parse(
    JSON.parse(Buffer.from(inventoryBytes).toString('utf8')),
  );
  if (stableStringify(inventory) !== stableStringify(candidate.inventory)) {
    throw new CliError('Candidate embedded and stored inventories differ.');
  }
  const archive = await readSafeFile(directory, 'publication.zip', 2 * 1024 * 1024 * 1024);
  if (
    sha256(archive) !== candidate.publication.archive.sha256 ||
    archive.byteLength !== candidate.publication.archive.byteLength
  ) {
    throw new CliError('Candidate deterministic archive failed exact hash verification.');
  }
  const treeRoot = resolve(directory, 'tree');
  const actualPaths = await listRegularFiles(treeRoot);
  const expectedPaths = candidate.inventory.files.map((file) => file.path);
  if (stableStringify(actualPaths) !== stableStringify(expectedPaths)) {
    throw new CliError('Candidate tree contains missing or unexpected files.');
  }
  for (const file of candidate.inventory.files) {
    const bytes = await readSafeFile(treeRoot, file.path, MAX_PUBLICATION_FILE_BYTES);
    if (bytes.byteLength !== file.byteLength || sha256(bytes) !== file.sha256) {
      throw new CliError(`Candidate tree file failed exact verification: ${file.path}.`);
    }
  }
  const manifestBytes = await readSafeFile(treeRoot, 'manifest.json');
  if (
    sha256(manifestBytes) !== candidate.publication.compilerManifest.sha256 ||
    manifestBytes.byteLength !== candidate.publication.compilerManifest.byteLength
  ) {
    throw new CliError('Candidate compiler manifest failed exact verification.');
  }
  const manifest = CompilerPublicationManifestSchema.parse(
    JSON.parse(Buffer.from(manifestBytes).toString('utf8')),
  );
  if (stableStringify(manifest) !== stableStringify(candidate.compilerManifest)) {
    throw new CliError('Candidate compiler manifest metadata is inconsistent.');
  }
  const build = await readJson(directory, candidate.sourceBuild.path!, (input) =>
    BuildArtifactSchema.parse(input),
  );
  if (
    artifactHash(build) !== candidate.sourceBuild.revision ||
    build.id !== candidate.sourceBuild.id
  ) {
    throw new CliError('Candidate Build evidence failed exact binding verification.');
  }
  const runs = new Map<string, RunArtifact>();
  const reviews = new Map<string, Review>();
  for (const scene of candidate.scenes) {
    for (const runBinding of scene.runs) {
      if (!runBinding.run) continue;
      const run = await readJson(directory, runBinding.run.path!, (input) =>
        RunArtifactSchema.parse(input),
      );
      if (
        artifactHash(run) !== runBinding.run.revision ||
        run.id !== runBinding.run.id ||
        run.sceneId !== scene.sceneId ||
        run.runTargetId !== runBinding.runTargetId
      ) {
        throw new CliError(`Candidate Run ${run.id} failed exact binding verification.`);
      }
      assertClearPrivacy(run);
      runs.set(runBinding.run.revision, run);
    }
  }
  for (const reviewBinding of candidate.reviews) {
    const review = await readJson(directory, reviewBinding.path!, (input) =>
      ReviewSchema.parse(input),
    );
    if (artifactHash(review) !== reviewBinding.revision || review.id !== reviewBinding.id) {
      throw new CliError(`Candidate Review ${review.id} failed exact binding verification.`);
    }
    const exactSubject =
      (review.subject.kind === 'build' &&
        review.subject.revision === candidate.sourceBuild.revision) ||
      (review.subject.kind === 'run' && runs.has(review.subject.revision));
    if (!exactSubject) throw new CliError(`Candidate Review ${review.id} has an unbound subject.`);
    reviews.set(reviewBinding.revision, review);
  }
  for (const scene of candidate.scenes) {
    for (const runBinding of scene.runs) {
      if (!runBinding.run) {
        if (runBinding.reviews.length > 0) {
          throw new CliError(`Candidate has Review evidence without a Run for ${scene.sceneId}.`);
        }
        continue;
      }
      for (const reviewBinding of runBinding.reviews) {
        const review = reviews.get(reviewBinding.revision);
        if (
          !review ||
          reviewBinding.id !== review.id ||
          review.subject.kind !== 'run' ||
          review.subject.id !== runBinding.run.id ||
          review.subject.revision !== runBinding.run.revision ||
          review.changeState !== runBinding.changeState
        ) {
          throw new CliError(
            `Candidate Review does not bind the exact Run outcome for ${scene.sceneId}/${runBinding.runTargetId}.`,
          );
        }
      }
    }
  }
  return { build, runs, reviews };
}

async function approvalObjects(config: LoadedConfig): Promise<ApprovalAttestation[]> {
  await ensurePublicationRoot(config);
  const root = publicationRoot(config);
  const objects = resolve(root, 'approvals/objects');
  await ensurePrivateDirectory(objects);
  const entries = (await readdir(objects, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const approvals: ApprovalAttestation[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new CliError(`Approval object is not a regular file: ${entry.name}.`);
    }
    const revision = entry.name.slice(0, -5);
    const approval = ApprovalAttestationSchema.parse(
      JSON.parse(await readFile(resolve(objects, entry.name), 'utf8')),
    );
    if (canonicalJsonHash(approval) !== revision) {
      throw new CliError(`Approval attestation ${approval.id} failed canonical hash verification.`);
    }
    approvals.push(approval);
  }
  return approvals;
}

function activeApprovals(
  approvals: readonly ApprovalAttestation[],
  predicate: (approval: ApprovalAttestation) => boolean,
): ApprovalAttestation[] {
  const latest = new Map<string, ApprovalAttestation>();
  for (const approval of approvals.filter(predicate)) {
    const existing = latest.get(approval.actorId);
    if (
      !existing ||
      approval.createdAt > existing.createdAt ||
      (approval.createdAt === existing.createdAt &&
        canonicalJsonHash(approval) > canonicalJsonHash(existing))
    ) {
      latest.set(approval.actorId, approval);
    }
  }
  return [...latest.values()].filter((approval) => approval.decision === 'approved');
}

async function storeApproval(
  config: LoadedConfig,
  approval: ApprovalAttestation,
): Promise<{
  readonly approval: ApprovalAttestation;
  readonly revision: string;
  readonly path: string;
}> {
  const revision = canonicalJsonHash(approval);
  const path = resolve(publicationRoot(config), `approvals/objects/${revision}.json`);
  await writeImmutableJson(path, approval);
  return { approval, revision, path };
}

async function resolveBaselineToken(
  config: LoadedConfig,
  token: string,
): Promise<BaselineEvidence> {
  await ensureBaselineRoot(config);
  const baselineRoot = resolve(config.directory, config.config.paths.baselines);
  const objectRoot = resolve(baselineRoot, 'objects');
  await ensurePrivateDirectory(objectRoot);
  const revisions = /^[a-f0-9]{64}$/u.test(token)
    ? [token]
    : (await readdir(objectRoot))
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => entry.slice(0, -5));
  for (const revision of revisions.sort()) {
    const path = resolve(objectRoot, `${revision}.json`);
    const baseline = await readJson(objectRoot, `${revision}.json`, (input) =>
      BaselineSchema.parse(input),
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!baseline) continue;
    const actual = artifactHash(baseline);
    if (actual !== revision)
      throw new CliError(`Baseline ${baseline.id} failed exact hash verification.`);
    if (token !== revision && token !== baseline.id) continue;
    const approvals = await approvalObjects(config);
    return {
      baseline,
      binding: binding(
        'baseline',
        baseline.id,
        revision,
        relative(config.directory, path).replaceAll('\\', '/'),
      ),
      approvals: activeApprovals(
        approvals,
        (approval) =>
          approval.scope === 'visual' &&
          approval.subject.revision === revision &&
          approval.sceneId === baseline.sceneId &&
          approval.runTargetId === baseline.runTargetId,
      ),
    };
  }
  throw new CliError(`Unknown immutable Baseline ${token}.`);
}

async function activeBaseline(
  config: LoadedConfig,
  sceneId: string,
  runTargetId: string,
): Promise<BaselineEvidence | undefined> {
  await ensureBaselineRoot(config);
  const baselineRoot = resolve(config.directory, config.config.paths.baselines);
  let pointer;
  try {
    pointer = await readJson(baselineRoot, `pointers/${sceneId}/${runTargetId}.json`, (input) =>
      BaselinePointerSchema.parse(input),
    );
  } catch (error) {
    if (error instanceof CliError && error.message.includes('(missing)')) return undefined;
    throw error;
  }
  if (
    pointer.projectId !== config.project.id ||
    pointer.sceneId !== sceneId ||
    pointer.runTargetId !== runTargetId
  ) {
    throw new CliError(`Baseline pointer contradicts ${sceneId}/${runTargetId}.`);
  }
  return resolveBaselineToken(config, pointer.baseline.revision);
}

export async function persistImmutableBaseline(options: {
  readonly config: LoadedConfig;
  readonly baseline: Baseline;
  readonly actorId: string;
  readonly reason?: string;
  readonly privacyOverrideReason?: string;
}): Promise<{
  readonly revision: string;
  readonly objectPath: string;
  readonly pointerPath: string;
}> {
  await ensureBaselineRoot(options.config);
  await ensurePublicationRoot(options.config);
  const baseline = BaselineSchema.parse(options.baseline);
  if (!baseline.sourceRunRevision) {
    throw new CliError('Immutable Baselines require the exact source Run revision.');
  }
  const revision = artifactHash(baseline);
  const baselineRoot = resolve(options.config.directory, options.config.config.paths.baselines);
  const objectPath = resolve(baselineRoot, `objects/${revision}.json`);
  await writeImmutableJson(objectPath, baseline);
  const now = new Date().toISOString();
  const visual = ApprovalAttestationSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: createDeterministicId(
      'approval-attestation',
      `visual:${revision}:${options.actorId}:${now}`,
      32,
    ),
    projectId: options.config.project.id,
    createdAt: now,
    producer: PRODUCER,
    kind: 'approval-attestation',
    scope: 'visual',
    decision: 'approved',
    subject: binding(
      'baseline',
      baseline.id,
      revision,
      relative(options.config.directory, objectPath).replaceAll('\\', '/'),
    ),
    sceneId: baseline.sceneId,
    runTargetId: baseline.runTargetId,
    actorId: options.actorId,
    ...(options.reason ? { reason: options.reason } : {}),
  });
  await storeApproval(options.config, visual);
  if (options.privacyOverrideReason) {
    const override = ApprovalAttestationSchema.parse({
      ...visual,
      id: createDeterministicId(
        'approval-attestation',
        `privacy-override:${revision}:${options.actorId}:${now}`,
        32,
      ),
      scope: 'privacy-override',
      reason: options.privacyOverrideReason,
    });
    await storeApproval(options.config, override);
  }
  const pointer = BaselinePointerSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    kind: 'baseline-pointer',
    projectId: options.config.project.id,
    sceneId: baseline.sceneId,
    runTargetId: baseline.runTargetId,
    baseline: binding('baseline', baseline.id, revision, `objects/${revision}.json`),
    updatedAt: now,
  });
  const pointerPath = resolve(
    baselineRoot,
    `pointers/${baseline.sceneId}/${baseline.runTargetId}.json`,
  );
  await assertPointerDestination(pointerPath);
  await writeFileAtomically(pointerPath, jsonBytes(pointer), { mode: 0o600, directoryMode: 0o700 });
  // Compatibility materialization for reporters and hosted upload. This is a
  // mutable view; the pointer and content-addressed object remain authoritative.
  const compatibilityPath = resolve(
    baselineRoot,
    `${baseline.sceneId}/${baseline.runTargetId}.json`,
  );
  await assertPointerDestination(compatibilityPath);
  await writeFileAtomically(compatibilityPath, jsonBytes(baseline), {
    mode: 0o600,
    directoryMode: 0o700,
  });
  return { revision, objectPath, pointerPath };
}

export async function approvePublication(options: {
  readonly config: LoadedConfig;
  readonly scope: ApprovalAttestation['scope'];
  readonly actorId: string;
  readonly decision: ApprovalAttestation['decision'];
  readonly reason?: string;
  readonly channel?: string;
  readonly candidate?: string;
  readonly baseline?: string;
  readonly sceneId?: string;
  readonly review?: string;
}): Promise<{ readonly approval: ApprovalAttestation; readonly revision: string }> {
  let subject: ExactArtifactBinding;
  let sceneId = options.sceneId;
  let runTargetId: string | undefined;
  let candidate: StoredCandidate | undefined;
  if (options.scope === 'visual' || options.scope === 'privacy-override') {
    if (!options.baseline) throw new CliError(`${options.scope} approval requires --baseline.`);
    const resolved = await resolveBaselineToken(options.config, options.baseline);
    subject = resolved.binding;
    sceneId = resolved.baseline.sceneId;
    runTargetId = resolved.baseline.runTargetId;
  } else {
    if (!options.channel) throw new CliError(`${options.scope} approval requires --channel.`);
    const channel = resolveChannel(options.config, options.channel);
    candidate = await resolveCandidateToken(options.config, channel, options.candidate);
    await verifyCandidate(candidate);
    subject = binding(
      'publication-candidate',
      candidate.candidate.id,
      candidate.revision,
      relativeStorePath(options.config, resolve(candidate.directory, 'candidate.json')),
    );
    if (options.scope === 'editorial') {
      if (!sceneId || !candidate.candidate.scenes.some((scene) => scene.sceneId === sceneId)) {
        throw new CliError('Editorial approval requires --scene from the exact candidate.');
      }
    } else if (sceneId) {
      throw new CliError('Release approval applies to the whole candidate; omit --scene.');
    }
  }
  let reviewBinding: ExactArtifactBinding | undefined;
  if (options.review) {
    if (!candidate) throw new CliError('--review is supported for candidate approvals only.');
    const review = candidate.candidate.reviews.find(
      (entry) => entry.id === options.review || entry.revision === options.review,
    );
    if (!review)
      throw new CliError('Approval Review must be an exact Review embedded in the candidate.');
    reviewBinding = review;
  }
  const now = new Date().toISOString();
  const approval = ApprovalAttestationSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: createDeterministicId(
      'approval-attestation',
      `${options.scope}:${subject.revision}:${sceneId ?? ''}:${options.actorId}:${options.decision}:${now}`,
      32,
    ),
    projectId: options.config.project.id,
    createdAt: now,
    producer: PRODUCER,
    kind: 'approval-attestation',
    scope: options.scope,
    decision: options.decision,
    subject,
    ...(sceneId ? { sceneId } : {}),
    ...(runTargetId ? { runTargetId } : {}),
    actorId: options.actorId,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(reviewBinding ? { review: reviewBinding } : {}),
  });
  const stored = await storeApproval(options.config, approval);
  return { approval, revision: stored.revision };
}

function sceneHealth(scene: PublicationCandidateScene): HealthStatus {
  const required = scene.runs.filter((run) => run.required);
  if (
    required.length === 0 ||
    required.some((run) => !run.run || !run.fresh || run.reviews.length === 0)
  )
    return 'unverified';
  if (
    required.some(
      (run) =>
        run.status === 'blocked' ||
        run.changeState === 'blocked' ||
        run.privacy?.status !== 'clear',
    )
  ) {
    return 'blocked';
  }
  if (
    required.some(
      (run) =>
        run.status !== 'passed' || (run.changeState !== 'passed' && run.changeState !== 'changed'),
    )
  ) {
    return 'broken';
  }
  return required.some((run) => run.changeState === 'changed') ? 'changed' : 'passed';
}

async function loadChannelPointer(
  config: LoadedConfig,
  channelId: string,
): Promise<ChannelPointer | undefined> {
  const root = publicationRoot(config);
  try {
    const pointer = await readJson(root, `channels/${channelId}.json`, (input) =>
      ChannelPointerSchema.parse(input),
    );
    if (pointer.projectId !== config.project.id || pointer.channelId !== channelId) {
      throw new CliError('Channel pointer belongs to another Project or Channel.');
    }
    if (!pointer.event.path) throw new CliError('Channel pointer is missing its exact event path.');
    const event = await readJson(root, pointer.event.path, (input) =>
      PublicationEventSchema.parse(input),
    );
    if (
      canonicalJsonHash(event) !== pointer.event.revision ||
      event.id !== pointer.event.id ||
      event.projectId !== config.project.id ||
      event.channelId !== channelId ||
      event.sequence !== pointer.publicationSequence ||
      event.release.revision !== pointer.release.revision
    ) {
      throw new CliError('Channel pointer event failed exact binding verification.');
    }
    return pointer;
  } catch (error) {
    if (error instanceof CliError && error.message.includes('(missing)')) return undefined;
    throw error;
  }
}

async function resolveReleaseToken(
  config: LoadedConfig,
  channelId: string,
  token: string,
): Promise<StoredRelease> {
  const objectRoot = resolve(publicationRoot(config), 'releases/objects');
  await ensurePrivateDirectory(objectRoot);
  const revisions = /^[a-f0-9]{64}$/u.test(token)
    ? [token]
    : (await readdir(objectRoot))
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => entry.slice(0, -5));
  for (const revision of revisions.sort()) {
    const release = await readJson(objectRoot, `${revision}.json`, (input) =>
      PublicationReleaseSchema.parse(input),
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!release) continue;
    const actual = canonicalJsonHash(release);
    if (actual !== revision) throw new CliError(`Release ${release.id} failed exact verification.`);
    if (token !== revision && token !== release.id) continue;
    if (release.projectId !== config.project.id || release.channelId !== channelId) {
      throw new CliError('Release belongs to another Project or Channel.');
    }
    for (const approvalBinding of release.approvals) {
      if (!approvalBinding.path) {
        throw new CliError(`Release ${release.id} has an approval without an exact object path.`);
      }
      const approval = await readJson(publicationRoot(config), approvalBinding.path, (input) =>
        ApprovalAttestationSchema.parse(input),
      );
      if (
        approval.id !== approvalBinding.id ||
        canonicalJsonHash(approval) !== approvalBinding.revision
      ) {
        throw new CliError(`Release ${release.id} has a corrupt approval binding.`);
      }
    }
    return { release, revision, path: resolve(objectRoot, `${revision}.json`) };
  }
  throw new CliError(`Unknown immutable Release ${token}.`);
}

function sameExactFiles(
  left: readonly PublicationFile[],
  right: readonly PublicationFile[],
): boolean {
  return stableStringify(left) === stableStringify(right);
}

async function maximumReleaseSequence(config: LoadedConfig, channelId: string): Promise<number> {
  const root = resolve(publicationRoot(config), 'releases/objects');
  await ensurePrivateDirectory(root);
  let maximum = 0;
  for (const entry of await readdir(root)) {
    if (!entry.endsWith('.json')) continue;
    const release = await readJson(root, entry, (input) => PublicationReleaseSchema.parse(input));
    if (release.projectId === config.project.id && release.channelId === channelId) {
      maximum = Math.max(maximum, release.sequence);
    }
  }
  return maximum;
}

async function storeRelease(
  config: LoadedConfig,
  release: PublicationRelease,
): Promise<StoredRelease> {
  const revision = canonicalJsonHash(release);
  const path = resolve(publicationRoot(config), `releases/objects/${revision}.json`);
  await writeImmutableJson(path, release);
  return { release, revision, path };
}

async function storeEvent(
  config: LoadedConfig,
  event: PublicationEvent,
): Promise<{ readonly revision: string; readonly path: string }> {
  const revision = canonicalJsonHash(event);
  const path = resolve(publicationRoot(config), `events/objects/${revision}.json`);
  await writeImmutableJson(path, event);
  return { revision, path };
}

function storedDestination(config: LoadedConfig, destination: string): string {
  const absolute = resolve(config.directory, destination);
  const logical = relative(config.directory, absolute).replaceAll('\\', '/');
  return logical && !logical.startsWith('../') && !isAbsolute(logical) ? logical : absolute;
}

function restoredDestination(config: LoadedConfig, destination: string): string {
  return isAbsolute(destination) ? resolve(destination) : resolve(config.directory, destination);
}

function overlaps(left: string, right: string): boolean {
  const relativePath = relative(left, right);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..');
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let current = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      await lstat(current);
      return resolve(await realpath(current), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) {
        throw new CliError(`Publication destination has no resolvable parent: ${path}.`);
      }
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

async function assertSafeDestination(config: LoadedConfig, destination: string): Promise<string> {
  const absolute = resolve(config.directory, destination);
  const canonicalDestination = await canonicalProspectivePath(absolute);
  const projectRoot = await canonicalProspectivePath(config.directory);
  const sourceDirectories = await sceneDirectories(config);
  const protectedDirectories = await Promise.all(
    [
      publicationRoot(config),
      resolve(config.directory, config.config.paths.baselines),
      resolve(config.directory, config.config.paths.cache),
      ...sourceDirectories,
    ].map((path) => canonicalProspectivePath(path)),
  );
  const protectedFiles = await Promise.all(
    [config.path, ...(config.projectPath ? [config.projectPath] : [])].map((path) =>
      canonicalProspectivePath(path),
    ),
  );
  if (
    canonicalDestination === dirname(canonicalDestination) ||
    canonicalDestination === projectRoot ||
    protectedDirectories.some(
      (path) => overlaps(canonicalDestination, path) || overlaps(path, canonicalDestination),
    ) ||
    protectedFiles.some((path) => overlaps(canonicalDestination, path))
  ) {
    throw new CliError(
      `Publication destination overlaps protected source or state path: ${canonicalDestination}.`,
    );
  }
  const existing = await lstat(canonicalDestination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new CliError('Publication destination must be a real directory or not exist.');
  }
  return canonicalDestination;
}

/** Read-only destination validation used before resolving promotion evidence. */
export async function validatePublicationDestination(
  config: LoadedConfig,
  destination: string,
): Promise<string> {
  return assertSafeDestination(config, destination);
}

interface DirectoryTransaction {
  readonly destination: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

async function beginDirectoryPromotion(
  config: LoadedConfig,
  stored: StoredCandidate,
  destinationInput: string,
): Promise<DirectoryTransaction> {
  const destination = await assertSafeDestination(config, destinationInput);
  const parent = dirname(destination);
  await ensurePrivateDirectory(parent);
  const staging = await mkdtemp(join(parent, `.${basename(destination)}.publication-`));
  const backup = resolve(parent, `.${basename(destination)}.backup-${randomUUID()}`);
  let hadExisting = false;
  try {
    await copyVerifiedPublicationTree(
      resolve(stored.directory, 'tree'),
      staging,
      stored.candidate.inventory.files,
    );
    const stagedPaths = await listRegularFiles(staging);
    if (
      stableStringify(stagedPaths) !==
      stableStringify(stored.candidate.inventory.files.map((file) => file.path))
    ) {
      throw new CliError('Staged publication tree is incomplete.');
    }
    if (await lstat(destination).catch(() => undefined)) {
      await rename(destination, backup);
      hadExisting = true;
    }
    await rename(staging, destination);
    await syncDirectory(parent);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (hadExisting && !(await lstat(destination).catch(() => undefined))) {
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
  let settled = false;
  return {
    destination,
    async commit() {
      if (settled) return;
      settled = true;
      if (hadExisting) await rm(backup, { recursive: true, force: true });
    },
    async rollback() {
      if (settled) return;
      settled = true;
      await rm(destination, { recursive: true, force: true });
      if (hadExisting) await rename(backup, destination);
      await syncDirectory(parent);
    },
  };
}

async function withChannelLock<T>(
  config: LoadedConfig,
  channelId: string,
  operation: () => Promise<T>,
): Promise<T> {
  await ensurePublicationRoot(config);
  const directory = resolve(publicationRoot(config), 'locks');
  await ensurePrivateDirectory(directory);
  const path = resolve(directory, `${channelId}.lock`);
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(path, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const lock = JSON.parse(await readFile(path, 'utf8')) as {
          readonly pid?: unknown;
          readonly createdAt?: unknown;
        };
        if (typeof lock.pid === 'number' && Number.isInteger(lock.pid) && lock.pid > 0) {
          try {
            process.kill(lock.pid, 0);
          } catch (signalError) {
            if ((signalError as NodeJS.ErrnoException).code === 'ESRCH') stale = true;
          }
        }
      } catch {
        // A malformed or unsafe lock is never removed automatically.
      }
      if (!stale || attempt > 0) {
        throw new CliError(`Channel ${channelId} already has a publication operation in progress.`);
      }
      await rm(path, { force: true });
    }
  }
  if (!handle) throw new CliError(`Could not acquire the publication lock for ${channelId}.`);
  try {
    await handle.writeFile(
      `${stableStringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
    await handle.sync();
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
  }
}

export async function promotePublication(options: {
  readonly config: LoadedConfig;
  readonly channel: string;
  readonly candidate?: string;
  readonly destination: string;
  readonly actorId: string;
}): Promise<{
  readonly release: PublicationRelease;
  readonly releaseRevision: string;
  readonly eventRevision: string;
  readonly destination: string;
}> {
  const channel = resolveChannel(options.config, options.channel);
  return withChannelLock(options.config, channel.id, async () => {
    const stored = await resolveCandidateToken(options.config, channel, options.candidate);
    const evidence = await verifyCandidate(stored);
    const approvals = await approvalObjects(options.config);
    const previousPointer = await loadChannelPointer(options.config, channel.id);
    const previous = previousPointer
      ? await resolveReleaseToken(options.config, channel.id, previousPointer.release.revision)
      : undefined;
    const previousScenes = new Map(previous?.release.scenes.map((scene) => [scene.sceneId, scene]));
    const baselineBySceneTarget = new Map<string, BaselineEvidence>();
    const referencedApprovals = new Map<string, ApprovalAttestation>();
    for (const scene of stored.candidate.scenes) {
      for (const run of scene.runs.filter((entry) => entry.required && entry.run && entry.fresh)) {
        const baseline = await activeBaseline(options.config, scene.sceneId, run.runTargetId);
        if (!baseline) continue;
        const exactRun = evidence.runs.get(run.run!.revision);
        if (
          !exactRun ||
          !baseline.baseline.sourceRunRevision ||
          baseline.baseline.sourceRunRevision !== run.run!.revision ||
          baseline.baseline.sourceRunId !== run.run!.id ||
          baseline.baseline.sourceAttemptId !== exactRun.selectedAttemptId ||
          baseline.baseline.sourceRevision !== scene.sourceRevision ||
          baseline.baseline.sceneId !== scene.sceneId ||
          baseline.baseline.runTargetId !== run.runTargetId ||
          baseline.baseline.states.some((state) => state.privacy.status !== 'clear')
        ) {
          throw new CliError(
            `Active Baseline for ${scene.sceneId}/${run.runTargetId} does not bind the exact clear candidate Run.`,
          );
        }
        baselineBySceneTarget.set(`${scene.sceneId}\u0000${run.runTargetId}`, baseline);
        for (const approval of baseline.approvals) {
          referencedApprovals.set(canonicalJsonHash(approval), approval);
        }
      }
    }
    const editorial = new Map<string, ApprovalAttestation[]>();
    for (const scene of stored.candidate.scenes) {
      const active = activeApprovals(
        approvals,
        (approval) =>
          approval.scope === 'editorial' &&
          approval.subject.revision === stored.revision &&
          approval.sceneId === scene.sceneId,
      );
      editorial.set(scene.sceneId, active);
      for (const approval of active) referencedApprovals.set(canonicalJsonHash(approval), approval);
    }
    const releaseApprovals = activeApprovals(
      approvals,
      (approval) => approval.scope === 'release' && approval.subject.revision === stored.revision,
    );
    if (releaseApprovals.length === 0) {
      throw new CliError(
        'Publication requires a separate active Release approval for this exact candidate.',
      );
    }
    for (const approval of releaseApprovals) {
      referencedApprovals.set(canonicalJsonHash(approval), approval);
    }
    const readiness = stored.candidate.scenes.map((scene) => {
      const requiredFresh = scene.runs.filter((run) => run.required && run.run && run.fresh);
      const visualApproved =
        requiredFresh.length > 0 &&
        requiredFresh.every(
          (run) =>
            (baselineBySceneTarget.get(`${scene.sceneId}\u0000${run.runTargetId}`)?.approvals
              .length ?? 0) > 0,
        );
      return {
        sceneId: scene.sceneId,
        criticality: scene.criticality,
        status: sceneHealth(scene),
        visualApproved,
        editorialApproved: (editorial.get(scene.sceneId)?.length ?? 0) > 0,
        localizationComplete: scene.localizationComplete,
        candidateRevision: scene.sourceRevision,
        ...(previousScenes.get(scene.sceneId)
          ? { previousReleaseRevision: previousScenes.get(scene.sceneId)!.revision }
          : {}),
      };
    });
    const decision = evaluateChannelPolicy(channel.policy, readiness);
    if (!decision.allowed) {
      throw new CliError(
        `Channel policy blocked publication: ${decision.blockers.map((reason) => reason.message).join(' ')}`,
      );
    }
    const releaseScenes: PublicationReleaseScene[] = [];
    const releaseApprovalBindings = new Map<string, ExactArtifactBinding>(
      [...referencedApprovals].map(([revision, approval]) => [
        revision,
        binding(
          'approval-attestation',
          approval.id,
          revision,
          `approvals/objects/${revision}.json`,
        ),
      ]),
    );
    for (const sceneDecision of decision.scenes) {
      const candidateScene = stored.candidate.scenes.find(
        (scene) => scene.sceneId === sceneDecision.sceneId,
      )!;
      if (sceneDecision.action === 'exclude') {
        throw new CliError(
          `Channel policy selected exclusion for ${sceneDecision.sceneId}, but the immutable candidate tree contains that Scene. Build a narrowed candidate; publication fails closed.`,
        );
      }
      if (sceneDecision.action === 'carry-forward') {
        const prior = previousScenes.get(sceneDecision.sceneId);
        if (
          !prior ||
          prior.revision !== candidateScene.sourceRevision ||
          stableStringify(prior.localeRevisions) !==
            stableStringify(candidateScene.localeRevisions) ||
          !sameExactFiles(prior.files, candidateScene.files)
        ) {
          throw new CliError(
            `Carry-forward for ${sceneDecision.sceneId} is not byte-exact with the prior Release; publication fails closed.`,
          );
        }
        for (const approvalBinding of previous?.release.approvals ?? []) {
          releaseApprovalBindings.set(approvalBinding.revision, approvalBinding);
        }
        releaseScenes.push({ ...prior, action: 'carry-forward' });
        continue;
      }
      const required = candidateScene.runs.filter((run) => run.required);
      const runBindings = required.flatMap((run) => (run.run ? [run.run] : []));
      const reviewBindings = required.flatMap((run) => run.reviews);
      const baselines = required.flatMap((run) => {
        const baseline = baselineBySceneTarget.get(
          `${candidateScene.sceneId}\u0000${run.runTargetId}`,
        );
        return baseline ? [baseline.binding] : [];
      });
      if (
        required.length === 0 ||
        runBindings.length !== required.length ||
        required.some((run) => run.reviews.length === 0) ||
        baselines.length !== required.length
      ) {
        throw new CliError(
          `Scene ${candidateScene.sceneId} lacks exact Run/Baseline evidence for every required target.`,
        );
      }
      releaseScenes.push({
        sceneId: candidateScene.sceneId,
        action: 'include-candidate',
        revision: candidateScene.sourceRevision,
        runs: runBindings,
        reviews: reviewBindings,
        baselines,
        files: candidateScene.files,
        localeRevisions: candidateScene.localeRevisions,
      });
    }
    const now = new Date().toISOString();
    const sequence = (await maximumReleaseSequence(options.config, channel.id)) + 1;
    const release = PublicationReleaseSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      artifactVersion: ARTIFACT_VERSION,
      id: createDeterministicId(
        'publication-release',
        `${channel.id}:${sequence}:${stored.revision}`,
        32,
      ),
      projectId: options.config.project.id,
      createdAt: now,
      producer: PRODUCER,
      kind: 'publication-release',
      channelId: channel.id,
      sequence,
      sourceCandidate: binding(
        'publication-candidate',
        stored.candidate.id,
        stored.revision,
        relativeStorePath(options.config, resolve(stored.directory, 'candidate.json')),
      ),
      sourceBuild: stored.candidate.sourceBuild,
      publication: stored.candidate.publication,
      scenes: releaseScenes,
      approvals: [...releaseApprovalBindings.values()],
      policyDecisionHash: canonicalJsonHash(decision),
      publishedAt: now,
      ...(previous
        ? {
            supersedes: binding(
              'publication-release',
              previous.release.id,
              previous.revision,
              relativeStorePath(options.config, previous.path),
            ),
          }
        : {}),
    });
    const storedRelease = await storeRelease(options.config, release);
    const eventSequence = (previousPointer?.publicationSequence ?? 0) + 1;
    const destinationValue = storedDestination(options.config, options.destination);
    const event = PublicationEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      artifactVersion: ARTIFACT_VERSION,
      id: createDeterministicId(
        'publication-event',
        `published:${channel.id}:${eventSequence}:${storedRelease.revision}:${now}`,
        32,
      ),
      projectId: options.config.project.id,
      createdAt: now,
      producer: PRODUCER,
      kind: 'publication-event',
      action: 'published',
      channelId: channel.id,
      sequence: eventSequence,
      release: binding(
        'publication-release',
        release.id,
        storedRelease.revision,
        relativeStorePath(options.config, storedRelease.path),
      ),
      ...(previous
        ? {
            previousRelease: binding(
              'publication-release',
              previous.release.id,
              previous.revision,
              relativeStorePath(options.config, previous.path),
            ),
          }
        : {}),
      sourceCandidate: binding(
        'publication-candidate',
        stored.candidate.id,
        stored.revision,
        relativeStorePath(options.config, resolve(stored.directory, 'candidate.json')),
      ),
      actorId: options.actorId,
      destination: destinationValue,
      treeHash: stored.candidate.publication.treeHash,
    });
    const storedEvent = await storeEvent(options.config, event);
    const transaction = await beginDirectoryPromotion(options.config, stored, options.destination);
    try {
      const pointer = ChannelPointerSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        kind: 'channel-pointer',
        projectId: options.config.project.id,
        channelId: channel.id,
        publicationSequence: eventSequence,
        release: event.release,
        event: binding(
          'publication-event',
          event.id,
          storedEvent.revision,
          relativeStorePath(options.config, storedEvent.path),
        ),
        destination: destinationValue,
        updatedAt: now,
      });
      const pointerPath = resolve(publicationRoot(options.config), `channels/${channel.id}.json`);
      await assertPointerDestination(pointerPath);
      await writeFileAtomically(pointerPath, jsonBytes(pointer), {
        mode: 0o600,
        directoryMode: 0o700,
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    return {
      release,
      releaseRevision: storedRelease.revision,
      eventRevision: storedEvent.revision,
      destination: transaction.destination,
    };
  });
}

export async function rollbackPublication(options: {
  readonly config: LoadedConfig;
  readonly channel: string;
  readonly release?: string;
  readonly destination?: string;
  readonly actorId: string;
}): Promise<{
  readonly release: PublicationRelease;
  readonly releaseRevision: string;
  readonly eventRevision: string;
  readonly destination: string;
}> {
  const channel = resolveChannel(options.config, options.channel);
  return withChannelLock(options.config, channel.id, async () => {
    const pointer = await loadChannelPointer(options.config, channel.id);
    if (!pointer)
      throw new CliError(`Channel ${channel.id} has no published Release to roll back.`);
    const current = await resolveReleaseToken(options.config, channel.id, pointer.release.revision);
    const targetToken = options.release ?? current.release.supersedes?.revision;
    if (!targetToken) throw new CliError('Current Release has no predecessor; provide --release.');
    const target = await resolveReleaseToken(options.config, channel.id, targetToken);
    if (target.revision === current.revision) {
      throw new CliError('Rollback target is already the active Release.');
    }
    const storedCandidate = await resolveCandidateToken(
      options.config,
      channel,
      target.release.sourceCandidate.revision,
    );
    await verifyCandidate(storedCandidate);
    if (
      storedCandidate.candidate.publication.treeHash !== target.release.publication.treeHash ||
      stableStringify(storedCandidate.candidate.publication) !==
        stableStringify(target.release.publication)
    ) {
      throw new CliError('Rollback Release no longer matches its exact immutable candidate tree.');
    }
    const now = new Date().toISOString();
    const eventSequence = pointer.publicationSequence + 1;
    const destinationInput =
      options.destination ?? restoredDestination(options.config, pointer.destination);
    const destinationValue = storedDestination(options.config, destinationInput);
    const event = PublicationEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      artifactVersion: ARTIFACT_VERSION,
      id: createDeterministicId(
        'publication-event',
        `rolled-back:${channel.id}:${eventSequence}:${target.revision}:${now}`,
        32,
      ),
      projectId: options.config.project.id,
      createdAt: now,
      producer: PRODUCER,
      kind: 'publication-event',
      action: 'rolled-back',
      channelId: channel.id,
      sequence: eventSequence,
      release: binding(
        'publication-release',
        target.release.id,
        target.revision,
        relativeStorePath(options.config, target.path),
      ),
      previousRelease: binding(
        'publication-release',
        current.release.id,
        current.revision,
        relativeStorePath(options.config, current.path),
      ),
      sourceCandidate: target.release.sourceCandidate,
      actorId: options.actorId,
      destination: destinationValue,
      treeHash: target.release.publication.treeHash,
    });
    const storedEvent = await storeEvent(options.config, event);
    const transaction = await beginDirectoryPromotion(
      options.config,
      storedCandidate,
      destinationInput,
    );
    try {
      const next = ChannelPointerSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        kind: 'channel-pointer',
        projectId: options.config.project.id,
        channelId: channel.id,
        publicationSequence: eventSequence,
        release: event.release,
        event: binding(
          'publication-event',
          event.id,
          storedEvent.revision,
          relativeStorePath(options.config, storedEvent.path),
        ),
        destination: destinationValue,
        updatedAt: now,
      });
      const pointerPath = resolve(publicationRoot(options.config), `channels/${channel.id}.json`);
      await assertPointerDestination(pointerPath);
      await writeFileAtomically(pointerPath, jsonBytes(next), {
        mode: 0o600,
        directoryMode: 0o700,
      });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    return {
      release: target.release,
      releaseRevision: target.revision,
      eventRevision: storedEvent.revision,
      destination: transaction.destination,
    };
  });
}

export async function migrateLegacyBaselines(options: {
  readonly config: LoadedConfig;
  readonly actorId: string;
  readonly reason?: string;
}): Promise<{ readonly migrated: number; readonly alreadyImmutable: number }> {
  await ensureBaselineRoot(options.config);
  await ensurePublicationRoot(options.config);
  const baselineRoot = resolve(options.config.directory, options.config.config.paths.baselines);
  await ensurePrivateDirectory(baselineRoot);
  let migrated = 0;
  let alreadyImmutable = 0;
  const entries = await readdir(baselineRoot, { withFileTypes: true });
  for (const sceneEntry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!sceneEntry.isDirectory() || ['assets', 'objects', 'pointers'].includes(sceneEntry.name))
      continue;
    const sceneDirectory = resolve(baselineRoot, sceneEntry.name);
    for (const targetEntry of await readdir(sceneDirectory, { withFileTypes: true })) {
      if (!targetEntry.isFile() || !targetEntry.name.endsWith('.json')) continue;
      let baseline = BaselineSchema.parse(
        JSON.parse(await readFile(resolve(sceneDirectory, targetEntry.name), 'utf8')),
      );
      const current = await activeBaseline(
        options.config,
        baseline.sceneId,
        baseline.runTargetId,
      ).catch(() => undefined);
      if (current && artifactHash(current.baseline) === artifactHash(baseline)) {
        alreadyImmutable += 1;
        continue;
      }
      if (!baseline.sourceRunRevision) {
        const runPath = resolve(
          options.config.directory,
          `.scenebook/runs/runs/${baseline.sourceRunId}.json`,
        );
        const logical = projectLogicalPath(options.config, runPath, 'Legacy Baseline source Run');
        const run = await readJson(options.config.directory, logical, (input) =>
          RunArtifactSchema.parse(input),
        );
        if (
          run.id !== baseline.sourceRunId ||
          run.sceneId !== baseline.sceneId ||
          run.runTargetId !== baseline.runTargetId ||
          run.selectedAttemptId !== baseline.sourceAttemptId ||
          run.sourceRevision !== baseline.sourceRevision ||
          run.status !== 'passed'
        ) {
          throw new CliError(`Legacy Baseline ${baseline.id} cannot be bound to its source Run.`);
        }
        baseline = BaselineSchema.parse({ ...baseline, sourceRunRevision: artifactHash(run) });
      }
      await persistImmutableBaseline({
        config: options.config,
        baseline,
        actorId: options.actorId,
        ...(options.reason ? { reason: options.reason } : {}),
      });
      migrated += 1;
    }
  }
  return { migrated, alreadyImmutable };
}
