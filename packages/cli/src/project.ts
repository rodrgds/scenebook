import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { glob } from 'tinyglobby';
import { sha256, stableStringify } from '@scenebook/core';
import {
  compileScenes,
  parseOutputFormats,
  type CompileResult,
  type OutputFormat,
} from '@scenebook/compiler';
import {
  PRIVACY_SCANNER_VERSION,
  assessAssetPrivacy,
  compilePrivacyRuleConfigurations,
  evaluatePublicationPrivacy,
  scanStructuredValue,
  type AssetPrivacyAssessment,
  type PrivacyScanOptions,
} from '@scenebook/privacy';
import { loadSceneDirectory } from '@scenebook/compiler';
import type { PrivacyCacheBinding } from './privacy-scan.js';
import {
  projectPublicationAnalytics,
  projectPublicationCta,
  projectPublicationPlan,
} from './publication.js';
import type { LoadedConfig } from './types.js';

export function projectPrivacyScanOptions(config: LoadedConfig): PrivacyScanOptions {
  return {
    blockAt: config.config.privacy.blockAt,
    customRules: compilePrivacyRuleConfigurations(config.config.privacy.customRules),
  };
}

export function projectPrivacyPolicyDigest(config: LoadedConfig): string {
  return sha256(
    stableStringify({
      version: 1,
      privacyScannerVersion: PRIVACY_SCANNER_VERSION,
      blockAt: config.config.privacy.blockAt,
      scanBeforeUpload: config.config.privacy.scanBeforeUpload,
      ocrBeforePublication: config.config.privacy.ocrBeforePublication,
      customRules: [...config.config.privacy.customRules].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    }),
  );
}

export async function sceneDirectories(config: LoadedConfig): Promise<string[]> {
  const manifests = await glob(config.config.paths.scenes, {
    cwd: config.directory,
    absolute: true,
    dot: false,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/.scenebook/**'],
  });
  return manifests.map((manifest) => dirname(manifest)).sort();
}

async function assetAssessment(
  config: LoadedConfig,
  hash: string,
  binding: () => Promise<PrivacyCacheBinding>,
): Promise<AssetPrivacyAssessment> {
  const path = resolve(config.directory, '.scenebook/privacy', `${hash}.json`);
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as AssetPrivacyAssessment;
    if (value.assetHash !== hash) throw new Error(`Privacy assessment hash mismatch in ${path}.`);
    if (!['unknown', 'clear', 'warning', 'blocked'].includes(value.status)) {
      throw new Error(`Invalid privacy assessment status in ${path}.`);
    }
    if (value.method !== 'ocr' || !Array.isArray(value.findings)) {
      throw new Error(`Invalid privacy assessment method or findings in ${path}.`);
    }
    const active = await binding();
    if (
      value.policyDigest !== active.policyDigest ||
      value.providerId !== active.providerId ||
      value.providerVersion !== active.providerVersion ||
      value.scannerVersion !== active.scannerVersion
    ) {
      throw new Error(
        `Cached OCR assessment is stale or belongs to another scanner/policy: ${path}. Re-run \`scenebook privacy scan\`.`,
      );
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return assessAssetPrivacy(hash);
    throw error;
  }
}

export async function readPrivacyCacheBinding(config: LoadedConfig): Promise<PrivacyCacheBinding> {
  const path = resolve(config.directory, '.scenebook/privacy/_context.json');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'OCR cache context is missing. Re-run `scenebook privacy scan` for the exact publication formats.',
      );
    }
    throw error;
  }
  if (!value || typeof value !== 'object') throw new Error(`Invalid OCR cache context: ${path}.`);
  const binding = value as Partial<PrivacyCacheBinding>;
  const expectedPolicyDigest = projectPrivacyPolicyDigest(config);
  if (
    binding.version !== 1 ||
    binding.policyDigest !== expectedPolicyDigest ||
    binding.privacyScannerVersion !== PRIVACY_SCANNER_VERSION ||
    typeof binding.providerId !== 'string' ||
    typeof binding.providerVersion !== 'string' ||
    binding.scannerVersion !==
      `${binding.providerId}/${binding.providerVersion};@scenebook/privacy/${binding.privacyScannerVersion}`
  ) {
    throw new Error(
      `OCR cache context is stale or invalid: ${path}. Re-run \`scenebook privacy scan\` with the active policy and provider.`,
    );
  }
  return binding as PrivacyCacheBinding;
}

export async function buildProject(
  config: LoadedConfig,
  options: {
    readonly formats?: readonly string[];
    readonly output?: string;
    readonly allowUnscannedPrivacy?: boolean;
    readonly locale?: string;
    readonly fallbackLocale?: string;
    readonly channel?: string;
    readonly collection?: string;
  } = {},
): Promise<CompileResult> {
  const directories = await sceneDirectories(config);
  const configured = config.config.output.formats as OutputFormat[];
  const formats = options.formats?.length ? parseOutputFormats(options.formats) : configured;
  let bindingPromise: Promise<PrivacyCacheBinding> | undefined;
  const cacheBinding = (): Promise<PrivacyCacheBinding> =>
    (bindingPromise ??= readPrivacyCacheBinding(config));
  const publicationSelection = {
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.collection ? { collection: options.collection } : {}),
    attribution: config.config.output.attribution,
  };
  const publicAnalytics = projectPublicationAnalytics(config.project, publicationSelection);
  const publicCta = projectPublicationCta(config.project, publicationSelection);
  return compileScenes({
    scenes: directories,
    outputDirectory: resolve(config.directory, options.output ?? config.config.paths.output),
    protectedPaths: [
      config.path,
      ...(config.projectPath ? [config.projectPath] : []),
      resolve(config.directory, config.config.paths.cache),
      resolve(config.directory, config.config.paths.baselines),
      resolve(config.directory, config.config.paths.publication),
    ],
    formats,
    publicationPlan: projectPublicationPlan(config.project, publicationSelection),
    ...(publicAnalytics ? { publicAnalytics } : {}),
    ...(publicCta ? { publicCta } : {}),
    allowUnscannedPrivacy: options.allowUnscannedPrivacy,
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.fallbackLocale ? { fallbackLocale: options.fallbackLocale } : {}),
    privacyGate: async (_loaded, publishedAssets, projection) => {
      const structured = scanStructuredValue(projection, {
        ...projectPrivacyScanOptions(config),
        path: '$publication',
      });
      const assets = await Promise.all(
        publishedAssets.map((asset) =>
          asset.requiresOcr
            ? assetAssessment(config, asset.hash, cacheBinding)
            : Promise.resolve({
                assetHash: asset.hash,
                status: 'clear' as const,
                method: 'manual' as const,
                scannerVersion: 'scenebook-deterministic-structured-renderer',
                findings: [],
              }),
        ),
      );
      const publication = evaluatePublicationPrivacy({ structured, assets });
      return {
        status:
          publication.status === 'blocked'
            ? 'blocked'
            : publication.status === 'unknown'
              ? 'unknown'
              : 'passed',
        scanner: [
          `@scenebook/privacy:${structured.scannerVersion}`,
          ...assets
            .map((asset) => asset.scannerVersion)
            .filter((value): value is string => Boolean(value)),
        ]
          .filter((value, index, values) => values.indexOf(value) === index)
          .join(', '),
        findings: publication.findings.map((finding) => ({
          code: finding.ruleId,
          level:
            finding.severity === 'blocking' || finding.severity === 'high' ? 'error' : 'warning',
          message: finding.message,
          path: finding.path,
        })),
      };
    },
  });
}
