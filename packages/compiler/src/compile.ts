import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { sha256, stableStringify } from '@scenebook/core';
import {
  assessAssetPrivacy,
  evaluatePublicationPrivacy,
  scanStructuredValue,
} from '@scenebook/privacy';
import { replaceDirectoryAtomically } from './atomic.js';
import { DEFAULT_FORMATS, FORMAT_POLICY } from './formats.js';
import { validateSceneGraph } from './graph.js';
import { canonicalJson, writeOutputFile } from './io.js';
import { loadSceneDirectory } from './load.js';
import {
  gifAdapter,
  mp4Adapter,
  resolveFfmpegToolchain,
  verifyFfmpegToolchain,
  webmAdapter,
} from './media.js';
import { normalizeScene } from './normalize.js';
import { safeOutputDirectory } from './path-safety.js';
import { presentationAsset } from './presentation.js';
import { publicationPrivacyProjection } from './privacy.js';
import { publicArtifactUrl, validatePublicationDistribution } from './public.js';
import { resolvePublicationPlan } from './publication.js';
import { remixSourceAdapter } from './remix.js';
import {
  guideHtmlAdapter,
  interactiveHtmlAdapter,
  iframeAdapter,
  markdownAdapter,
  mdxAdapter,
  ogAdapter,
  pdfAdapter,
  readmeAdapter,
  renderCatalogIndex,
  renderCatalogScene,
  renderEvidence,
  socialAdapter,
  webComponentAdapter,
} from './renderers.js';
import type {
  CatalogManifest,
  CompileOptions,
  CompileResult,
  CompiledAsset,
  CompiledSceneManifest,
  CompilerDiagnostic,
  LoadedScene,
  OutputFormat,
  PrivacyAssessment,
  PublishedAssetCandidate,
  SceneAdapterContext,
  SceneOutputAdapter,
} from './types.js';

const ADAPTERS = new Map<OutputFormat, SceneOutputAdapter>(
  [
    interactiveHtmlAdapter,
    webComponentAdapter,
    iframeAdapter,
    markdownAdapter,
    mdxAdapter,
    guideHtmlAdapter,
    readmeAdapter,
    ogAdapter,
    socialAdapter,
    remixSourceAdapter,
    pdfAdapter,
    gifAdapter,
    webmAdapter,
    mp4Adapter,
  ].map((adapter) => [adapter.format, adapter]),
);

export function canonicalAssetIdentity(
  existing: CompiledAsset,
  requested: CompiledAsset,
): CompiledAsset {
  if (existing.hash !== requested.hash) {
    throw new Error('Compiler asset identity comparison requires the same digest.');
  }
  if (existing.mediaType !== requested.mediaType) {
    throw new Error(
      `Compiled asset ${existing.hash} was requested as conflicting media types ${existing.mediaType} and ${requested.mediaType}.`,
    );
  }
  if (existing.bytes !== requested.bytes) {
    throw new Error(`Compiled asset ${existing.hash} has conflicting byte lengths.`);
  }
  return {
    ...existing,
    privacyBasis:
      existing.privacyBasis === 'ocr' || requested.privacyBasis === 'ocr' ? 'ocr' : 'structured',
  };
}

function generatedAt(epoch?: number): string {
  const source = epoch ?? Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? '0', 10);
  if (!Number.isFinite(source) || source < 0)
    throw new Error('sourceDateEpoch must be a non-negative Unix timestamp.');
  return new Date(source * 1000).toISOString();
}

function requestedFormats(formats?: readonly OutputFormat[]): OutputFormat[] {
  const selected = new Set(formats ?? DEFAULT_FORMATS);
  if (selected.has('iframe') || selected.has('readme-card')) selected.add('standalone-html');
  if (selected.has('readme-card')) selected.add('og-image');
  for (const format of selected) {
    if (!(format in FORMAT_POLICY)) throw new Error(`Unsupported output format: ${String(format)}`);
  }
  return [...selected];
}

function shareLinks(
  outputs: Readonly<Partial<Record<OutputFormat, readonly string[]>>>,
  distribution: CatalogManifest['publication']['distribution'],
): CompiledSceneManifest['share'] {
  const first = (format: OutputFormat): string | undefined => outputs[format]?.[0];
  const source = outputs['remix-source'] ?? [];
  const link = (path?: string): string | undefined =>
    path ? publicArtifactUrl(distribution, path) : undefined;
  const socialImages = outputs['social-carousel']?.map((path) =>
    publicArtifactUrl(distribution, path),
  );
  return {
    ...(link(first('catalog')) ? { page: link(first('catalog')) } : {}),
    ...(link(first('standalone-html')) ? { standalone: link(first('standalone-html')) } : {}),
    ...(link(first('iframe')) ? { embed: link(first('iframe')) } : {}),
    ...(link(first('web-component')) ? { webComponent: link(first('web-component')) } : {}),
    ...(link(first('readme-card')) ? { readme: link(first('readme-card')) } : {}),
    ...(link(first('og-image')) ? { ogImage: link(first('og-image')) } : {}),
    ...(socialImages?.length ? { socialImages } : {}),
    ...(link(source.find((path) => path.endsWith('/scene.yaml')))
      ? { remixSource: link(source.find((path) => path.endsWith('/scene.yaml'))) }
      : {}),
    ...(link(source.find((path) => path.endsWith('.scene.zip')))
      ? { remixArchive: link(source.find((path) => path.endsWith('.scene.zip'))) }
      : {}),
  };
}

async function listFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(relative(directory, path).replaceAll('\\', '/'));
    }
  }
  await visit(directory);
  return result;
}

async function defaultPrivacyAssessment(
  _scene: LoadedScene,
  publishedAssets: readonly PublishedAssetCandidate[],
  publication: ReturnType<typeof publicationPrivacyProjection>,
): Promise<PrivacyAssessment> {
  const structured = scanStructuredValue(publication, { path: '$publication' });
  const gate = evaluatePublicationPrivacy({
    structured,
    assets: publishedAssets.map((asset) =>
      asset.requiresOcr
        ? assessAssetPrivacy(asset.hash)
        : {
            assetHash: asset.hash,
            status: 'clear',
            method: 'manual',
            scannerVersion: 'scenebook-deterministic-structured-renderer',
            findings: [],
          },
    ),
  });
  return {
    status:
      gate.status === 'blocked' ? 'blocked' : gate.status === 'unknown' ? 'unknown' : 'passed',
    scanner: `@scenebook/privacy:${structured.scannerVersion}`,
    findings: gate.findings.map((finding) => ({
      code: finding.ruleId,
      level: finding.severity === 'blocking' || finding.severity === 'high' ? 'error' : 'warning',
      message: finding.message,
      path: finding.path,
    })),
  };
}

function assertPrivacy(
  assessment: PrivacyAssessment,
  allowUnscannedPrivacy: boolean,
  sceneId: string,
): boolean {
  if (assessment.status === 'blocked') {
    const summary = assessment.findings.map((finding) => finding.message).join('; ');
    throw new Error(`Privacy gate blocked Scene ${sceneId}${summary ? `: ${summary}` : '.'}`);
  }
  if (assessment.status === 'unknown' && !allowUnscannedPrivacy) {
    throw new Error(
      `Privacy status is unknown for Scene ${sceneId}. Configure the Scenebook privacy scanner, or use the explicit local --allow-unscanned-privacy override.`,
    );
  }
  return assessment.status === 'unknown';
}

export async function compileScenes(options: CompileOptions): Promise<CompileResult> {
  if (options.scenes.length === 0)
    throw new Error('At least one portable Scene directory is required.');
  let formats = requestedFormats(options.formats);
  const timestamp = generatedAt(options.sourceDateEpoch);
  const loadedCandidates = await Promise.all(
    options.scenes.map((scene) =>
      typeof scene === 'string'
        ? loadSceneDirectory(scene, { strictAssetHashes: options.strictAssetHashes })
        : Promise.resolve(scene),
    ),
  );
  const outputDirectory = await safeOutputDirectory(options.outputDirectory, [
    ...loadedCandidates.flatMap((scene) => [scene.directory, scene.manifestPath]),
    ...(options.protectedPaths ?? []),
  ]);
  const normalizedCandidates = loadedCandidates.map((scene) =>
    normalizeScene(scene.scene, {
      loaded: scene,
      locale: options.locale,
      fallbackLocale: options.fallbackLocale,
    }),
  );
  const idSet = new Set<string>();
  const slugSet = new Set<string>();
  for (const scene of normalizedCandidates) {
    if (idSet.has(scene.id)) throw new Error(`Duplicate Scene id: ${scene.id}`);
    if (slugSet.has(scene.slug)) throw new Error(`Duplicate Scene slug: ${scene.slug}`);
    idSet.add(scene.id);
    slugSet.add(scene.slug);
  }
  const publication = resolvePublicationPlan(
    options.publicationPlan,
    normalizedCandidates,
    options.title ?? 'Scenebook',
  );
  validatePublicationDistribution(
    publication.plan.distribution,
    {
      ...(options.publicAnalytics ? { analytics: options.publicAnalytics } : {}),
      ...(options.publicCta ? { cta: options.publicCta } : {}),
    },
    true,
  );
  if (publication.plan.distribution.remix && formats.includes('catalog')) {
    formats = [...new Set([...formats, 'remix-source' as const])];
  }
  if (!publication.plan.distribution.remix && formats.includes('remix-source')) {
    throw new Error('Publication disables remix source, but remix-source was requested.');
  }
  const candidatesById = new Map(
    normalizedCandidates.map((scene, index) => [
      scene.id,
      { scene, loaded: loadedCandidates[index] },
    ]),
  );
  const selected = publication.sceneIds.map((sceneId) => {
    const candidate = candidatesById.get(sceneId);
    if (!candidate?.loaded) throw new Error('Compiler publication Scene alignment failure.');
    return { scene: candidate.scene, loaded: candidate.loaded };
  });
  const normalized = selected.map((candidate) => candidate.scene);
  const loaded = selected.map((candidate) => candidate.loaded);
  validateSceneGraph(normalized);
  const ffmpeg = formats.some((format) => FORMAT_POLICY[format].requiresFfmpeg)
    ? await resolveFfmpegToolchain()
    : undefined;

  let assessments: readonly PrivacyAssessment[] = [];
  let overrides: readonly boolean[] = [];
  let manifest: CatalogManifest | undefined;

  const replacement = await replaceDirectoryAtomically(
    outputDirectory,
    async (staging) => {
      const compiledAssets = new Map<string, CompiledAsset>();
      const contexts: SceneAdapterContext[] = [];
      for (const [sceneIndex, scene] of normalized.entries()) {
        const source = loaded[sceneIndex];
        if (!source) throw new Error('Compiler internal scene alignment failure.');
        for (const sourceStep of source.scene.steps) {
          const unresolved = sourceStep.masks.find(
            (mask) =>
              (mask.scope === 'publication' || mask.scope === 'both') && mask.rect === undefined,
          );
          if (unresolved) {
            throw new Error(
              `Scene ${scene.id} Step ${sourceStep.id} publication mask ${unresolved.id} has no resolved rect. Re-capture or resolve the locator before publication.`,
            );
          }
        }
        for (const step of scene.steps) {
          const unsafeBlur = step.masks.find(
            (mask) =>
              mask.mode === 'blur' &&
              (mask.source !== 'manual' || mask.classification !== 'custom'),
          );
          if (unsafeBlur) {
            throw new Error(
              `Scene ${scene.id} Step ${step.id} uses reversible blur for a ${unsafeBlur.source}/${unsafeBlur.classification} mask. Blur is limited to manual custom presentation regions; use an opaque publication mask for privacy.`,
            );
          }
        }
        const publishedAssets = new Map<string, PublishedAssetCandidate>();
        const putAsset: SceneAdapterContext['putAsset'] = async (contents, assetOptions) => {
          const hash = sha256(contents);
          const extension = assetOptions.extension.startsWith('.')
            ? assetOptions.extension
            : `.${assetOptions.extension}`;
          const requestedPath = `assets/${hash}${extension}`;
          const requestedAsset: CompiledAsset = {
            hash,
            path: requestedPath,
            mediaType: assetOptions.mediaType,
            bytes: contents.byteLength,
            privacyBasis: assetOptions.requiresOcr ? 'ocr' : 'structured',
          };
          const existingAsset = compiledAssets.get(hash);
          const canonicalAsset = existingAsset
            ? canonicalAssetIdentity(existingAsset, requestedAsset)
            : requestedAsset;
          if (!existingAsset) {
            await writeOutputFile(staging, canonicalAsset.path, contents);
          }
          compiledAssets.set(hash, canonicalAsset);
          const path = canonicalAsset.path;
          if (assetOptions.sourceStepId) {
            const existing = publishedAssets.get(hash);
            const sourceStepIds = [
              ...new Set([...(existing?.sourceStepIds ?? []), assetOptions.sourceStepId]),
            ].sort();
            publishedAssets.set(hash, {
              hash,
              path,
              sourceSceneId: scene.id,
              sourceStepIds,
              mediaType: canonicalAsset.mediaType,
              bytes: canonicalAsset.bytes,
              requiresOcr: Boolean(existing?.requiresOcr) || Boolean(assetOptions.requiresOcr),
            });
          }
          return path;
        };
        const context: SceneAdapterContext = {
          loaded: source,
          scene,
          outputDirectory: staging,
          generatedAt: timestamp,
          publication: publication.plan,
          assetOutputPaths: new Map(),
          privacy: {
            status: 'unknown',
            scanner: 'pending',
            findings: [],
            overridden: false,
          },
          sceneSlugs: new Map(normalized.map((candidate) => [candidate.id, candidate.slug])),
          formats,
          ...(options.publicAnalytics ? { publicAnalytics: options.publicAnalytics } : {}),
          ...(options.publicCta ? { publicCta: options.publicCta } : {}),
          ...(ffmpeg ? { ffmpegExecutable: ffmpeg.executable } : {}),
          putAsset,
          publishedAssets,
        };
        contexts.push(context);

        // Materialize the exact post-crop/post-mask derivatives before privacy assessment.
        for (const step of scene.steps) {
          if (step.hidden || !Object.values(step.visibility).some(Boolean)) continue;
          await presentationAsset(context, step, 'guide');
          if (step.secondaryImageReference)
            await presentationAsset(context, step, 'guide', { secondary: true });
        }
      }

      // Render every selected adapter into the private atomic staging tree first. Adapters
      // register exact public raster derivatives via putAsset; private encoder intermediates stay
      // outside the publication tree.
      const outputsByScene = new Map<string, Partial<Record<OutputFormat, readonly string[]>>>();
      const thumbnails = new Map<string, string>();
      for (const context of contexts) {
        const outputs: Partial<Record<OutputFormat, readonly string[]>> = {};
        for (const format of formats) {
          if (format === 'catalog') continue;
          const adapter = ADAPTERS.get(format);
          if (!adapter) throw new Error(`No compiler adapter registered for ${format}.`);
          outputs[format] = await adapter.render(context);
        }
        if (formats.includes('catalog')) outputs.catalog = [await renderCatalogScene(context)];
        const thumbnailStep = context.scene.steps.find(
          (step) => !step.hidden && step.visibility.interactive,
        );
        if (thumbnailStep) {
          thumbnails.set(
            context.scene.id,
            await presentationAsset(context, thumbnailStep, 'launch'),
          );
        }
        outputsByScene.set(context.scene.id, outputs);
      }

      // Motion output is reproducible only within the exact encoder binding captured before the
      // build. Re-probe before promotion so an executable replaced during rendering cannot produce
      // an artifact whose manifest claims the previous toolchain.
      if (ffmpeg) await verifyFfmpegToolchain(ffmpeg);

      assessments = await Promise.all(
        contexts.map((context) =>
          (options.privacyGate ?? defaultPrivacyAssessment)(
            context.loaded,
            [...context.publishedAssets.values()],
            publicationPrivacyProjection(context.loaded, context.scene, context.publication),
          ),
        ),
      );
      overrides = assessments.map((assessment, index) =>
        assertPrivacy(
          assessment,
          options.allowUnscannedPrivacy ?? false,
          normalized[index]?.id ?? 'unknown',
        ),
      );

      const sceneManifests: CompiledSceneManifest[] = [];
      for (const [index, pendingContext] of contexts.entries()) {
        const scene = pendingContext.scene;
        const source = pendingContext.loaded;
        const privacy = assessments[index];
        if (!privacy) throw new Error('Compiler internal scene alignment failure.');
        const context: SceneAdapterContext = {
          ...pendingContext,
          privacy: { ...privacy, overridden: overrides[index] ?? false },
        };
        const outputs = outputsByScene.get(scene.id) ?? {};
        const evidence = await renderEvidence(context);
        const sourceHash = sha256(stableStringify(source.scene));
        sceneManifests.push({
          id: scene.id,
          slug: scene.slug,
          title: scene.title,
          capability: scene.capability,
          locale: scene.locale,
          sourceHash,
          steps: scene.steps.filter((step) => !step.hidden && step.visibility.interactive).length,
          assets: [...context.publishedAssets.keys()].sort(),
          evidence,
          outputs,
          share: shareLinks(outputs, publication.plan.distribution),
        });
      }

      if (formats.includes('catalog')) {
        await renderCatalogIndex(staging, publication.plan, normalized, thumbnails, formats);
      }
      const anyOverride = overrides.some(Boolean);
      manifest = {
        format: 'scenebook-catalog',
        version: 1,
        generatedAt: timestamp,
        title: publication.plan.title,
        publication: publication.plan,
        privacy: {
          status: anyOverride ? 'overridden' : 'passed',
          scanner: [...new Set(assessments.map((assessment) => assessment.scanner))]
            .sort()
            .join(', '),
        },
        toolchains: ffmpeg ? [ffmpeg.manifest] : [],
        scenes: sceneManifests,
        assets: [...compiledAssets.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
      };
      await writeOutputFile(staging, 'manifest.json', canonicalJson(manifest));
      await writeOutputFile(
        staging,
        'formats.json',
        canonicalJson({
          selected: formats,
          policy: FORMAT_POLICY,
          toolchains: ffmpeg ? [ffmpeg.manifest] : [],
        }),
      );
    },
    options.overwrite ?? true,
  );

  if (!manifest) throw new Error('Compiler did not produce a manifest.');
  const cleanupDiagnostics: CompilerDiagnostic[] =
    replacement.cleanup.status === 'pending'
      ? [
          {
            code: 'atomic-backup-cleanup-pending',
            level: 'warning',
            message: replacement.cleanup.warning,
            path: replacement.cleanup.backupDirectory,
          },
        ]
      : [];
  return {
    outputDirectory,
    manifest,
    files: await listFiles(outputDirectory),
    diagnostics: loaded
      .flatMap((scene) => scene.diagnostics)
      .concat(
        assessments.flatMap((value) => value.findings),
        cleanupDiagnostics,
      ),
  };
}
