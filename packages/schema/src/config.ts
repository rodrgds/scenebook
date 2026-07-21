import { z } from 'zod';

import {
  IdSchema,
  JsonValueSchema,
  LocaleSchema,
  PublicHostnameSchema,
  PublicHttpUrlSchema,
  RelativePathSchema,
  RouteSchema,
  SCHEMA_VERSION,
  SlugSchema,
  ViewportSchema,
} from './common.js';

const PUBLIC_CHANNEL_ENDPOINT =
  '^/v1/public/workspaces/[a-z0-9][a-z0-9._:-]{0,127}/projects/[a-z0-9][a-z0-9._:-]{0,127}/channels/[a-z0-9][a-z0-9._:-]{0,127}';

function publicChannelEndpoint(kind: 'analytics' | 'cta') {
  const path = new RegExp(`${PUBLIC_CHANNEL_ENDPOINT}/${kind}$`, 'u');
  return PublicHttpUrlSchema.refine(
    (value) => path.test(new URL(value).pathname),
    `${kind === 'cta' ? 'CTA' : 'Analytics'} endpoint must be an exact Scenebook public Channel ${kind} URL`,
  ).refine(
    (value) => {
      const parsed = new URL(value);
      return (
        parsed.protocol === 'https:' ||
        (parsed.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
      );
    },
    `${kind === 'cta' ? 'CTA' : 'Analytics'} endpoint must use HTTPS except for explicit loopback development`,
  );
}

const PublicAnalyticsEndpointSchema = publicChannelEndpoint('analytics');
const PublicCtaEndpointSchema = publicChannelEndpoint('cta');

const PublicSeoObjectSchema = z
  .object({
    index: z.boolean().default(false),
    follow: z.boolean().default(false),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const PublicSeoSchema = PublicSeoObjectSchema.default({ index: false, follow: false });

export const PublicAnalyticsConfigSchema = z
  .object({
    endpoint: PublicAnalyticsEndpointSchema,
    /** The public-scoped Channel credential is read at build time, never serialized to manifests. */
    tokenEnv: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'Expected an environment variable name'),
    releaseId: IdSchema,
    respectDoNotTrack: z.boolean().default(true),
  })
  .strict();

export const PublicCtaConfigSchema = z
  .object({
    endpoint: PublicCtaEndpointSchema,
    /** Public-scoped Channel credential, read at build time and omitted from manifests. */
    tokenEnv: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'Expected an environment variable name'),
    releaseId: IdSchema,
  })
  .strict();

const PublicDistributionShape = {
  baseUrl: PublicHttpUrlSchema.optional(),
  customDomain: PublicHostnameSchema.optional(),
  seo: PublicSeoSchema,
  attribution: z.boolean().default(true),
  remix: z.boolean().default(true),
  analytics: PublicAnalyticsConfigSchema.optional(),
  cta: PublicCtaConfigSchema.optional(),
};

function matchingPublicOrigin(
  value: { readonly baseUrl?: string; readonly customDomain?: string },
  context: z.RefinementCtx,
): void {
  if (
    value.baseUrl &&
    value.customDomain &&
    new URL(value.baseUrl).hostname !== value.customDomain
  ) {
    context.addIssue({
      code: 'custom',
      message: 'public.baseUrl hostname must match public.customDomain',
      path: ['baseUrl'],
    });
  }
}

export const PublicDistributionSchema = z
  .object(PublicDistributionShape)
  .strict()
  .default({
    seo: { index: false, follow: false },
    attribution: true,
    remix: true,
  })
  .superRefine(matchingPublicOrigin);

export const PublicDistributionOverrideSchema = z
  .object({
    baseUrl: PublicHttpUrlSchema.optional(),
    customDomain: PublicHostnameSchema.optional(),
    seo: PublicSeoObjectSchema.partial().strict().optional(),
    attribution: z.boolean().optional(),
    remix: z.boolean().optional(),
    /** Explicit null is a reviewed Channel-level opt-out from inherited analytics. */
    analytics: PublicAnalyticsConfigSchema.nullable().optional(),
    /** Explicit null prevents inherited form submissions for this Channel. */
    cta: PublicCtaConfigSchema.nullable().optional(),
  })
  .strict()
  .default({})
  .superRefine(matchingPublicOrigin);

export const RepositoryConfigSchema = z
  .object({
    id: IdSchema,
    provider: z.enum(['github', 'gitlab', 'bitbucket', 'generic']).default('generic'),
    repository: z.string().min(1).max(500),
    defaultBranch: z.string().min(1).max(500).default('main'),
    root: RelativePathSchema.optional(),
  })
  .strict();

export const EnvironmentSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(200),
    kind: z.enum(['local', 'preview', 'staging', 'production', 'custom']),
    baseUrl: RouteSchema,
    authProfileId: IdSchema.optional(),
    variableNames: z.array(IdSchema).max(500).default([]),
    allowMutations: z.boolean().default(false),
    privateNetwork: z.boolean().default(false),
  })
  .strict();

export const ProductVariantSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(200),
    role: IdSchema.optional(),
    plan: IdSchema.optional(),
    locale: LocaleSchema.optional(),
    theme: IdSchema.optional(),
    featureFlags: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).default({}),
    fixture: IdSchema.optional(),
  })
  .strict();

export const CaptureProfileSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(200),
    browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
    browserVersion: z.string().max(100).optional(),
    viewport: ViewportSchema,
    colorScheme: z.enum(['light', 'dark', 'no-preference']).default('light'),
    reducedMotion: z.enum(['reduce', 'no-preference']).default('reduce'),
    timezone: z.string().min(1).max(100).default('UTC'),
    locale: LocaleSchema.default('en'),
    fontPack: z.string().min(1).max(200).optional(),
    osImage: z.string().min(1).max(500).optional(),
  })
  .strict();

export const RunTargetSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(200),
    environmentId: IdSchema,
    productVariantId: IdSchema,
    captureProfileId: IdSchema,
    enabled: z.boolean().default(true),
  })
  .strict();

export const CollectionEntrySchema = z
  .object({
    id: IdSchema,
    sceneId: IdSchema,
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(2_000).optional(),
  })
  .strict();

export const CollectionSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1).max(500),
    slug: SlugSchema,
    description: z.string().max(5_000).optional(),
    audience: z.array(IdSchema).max(100).default([]),
    entries: z.array(CollectionEntrySchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((collection, context) => {
    const ids = new Set<string>();
    for (const [index, entry] of collection.entries.entries()) {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate Collection entry id: ${entry.id}`,
          path: ['entries', index, 'id'],
        });
      }
      ids.add(entry.id);
    }
  });

export const ChannelPolicySchema = z
  .object({
    requireCriticalPassing: z.boolean().default(true),
    requireVisualApproval: z.boolean().default(true),
    requireEditorialApproval: z.boolean().default(true),
    requireCompleteLocalization: z.boolean().default(false),
    publication: z.enum(['manual', 'approved-main']).default('manual'),
    nonCriticalFailure: z.enum(['block', 'carry-forward', 'exclude']).default('block'),
  })
  .strict();

export const ChannelSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(200),
    slug: SlugSchema,
    description: z.string().min(1).max(5_000).optional(),
    kind: z.enum(['public-catalog', 'private-portal', 'docs-sync', 'embed', 'static', 'offline']),
    collectionIds: z.array(IdSchema).max(10_000).default([]),
    policy: ChannelPolicySchema.default({
      requireCriticalPassing: true,
      requireVisualApproval: true,
      requireEditorialApproval: true,
      requireCompleteLocalization: false,
      publication: 'manual',
      nonCriticalFailure: 'block',
    }),
    /** @deprecated Use public.customDomain; retained for schema-version-1 compatibility. */
    customDomain: PublicHostnameSchema.optional(),
    public: PublicDistributionOverrideSchema,
  })
  .strict()
  .superRefine((channel, context) => {
    if (
      channel.customDomain &&
      channel.public.customDomain &&
      channel.customDomain !== channel.public.customDomain
    ) {
      context.addIssue({
        code: 'custom',
        message: 'customDomain and public.customDomain must match when both are present',
        path: ['public', 'customDomain'],
      });
    }
    if (channel.public.seo?.index && !['public-catalog', 'static'].includes(channel.kind)) {
      context.addIssue({
        code: 'custom',
        message: 'Only public-catalog and static Channels can enable public search indexing',
        path: ['public', 'seo', 'index'],
      });
    }
  });

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: IdSchema,
    name: z.string().min(1).max(200),
    slug: SlugSchema,
    description: z.string().max(10_000).optional(),
    defaultLocale: LocaleSchema.default('en'),
    locales: z.array(LocaleSchema).min(1).max(100).default(['en']),
    repositories: z.array(RepositoryConfigSchema).max(100).default([]),
    environments: z.array(EnvironmentSchema).max(100).default([]),
    productVariants: z.array(ProductVariantSchema).max(1_000).default([]),
    captureProfiles: z.array(CaptureProfileSchema).max(1_000).default([]),
    runTargets: z.array(RunTargetSchema).max(10_000).default([]),
    collections: z.array(CollectionSchema).max(10_000).default([]),
    channels: z.array(ChannelSchema).max(1_000).default([]),
    public: PublicDistributionSchema,
    metadata: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict()
  .superRefine((project, context) => {
    const requireUnique = <T extends { id: string }>(values: T[], key: string): Set<string> => {
      const ids = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (ids.has(value.id)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate ${key} id: ${value.id}`,
            path: [key, index, 'id'],
          });
        }
        ids.add(value.id);
      }
      return ids;
    };
    const requireUniqueSlugs = <T extends { slug: string }>(values: T[], key: string): void => {
      const slugs = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (slugs.has(value.slug)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate ${key} slug: ${value.slug}`,
            path: [key, index, 'slug'],
          });
        }
        slugs.add(value.slug);
      }
    };

    const environmentIds = requireUnique(project.environments, 'environments');
    const variantIds = requireUnique(project.productVariants, 'productVariants');
    const captureProfileIds = requireUnique(project.captureProfiles, 'captureProfiles');
    requireUnique(project.repositories, 'repositories');
    requireUnique(project.runTargets, 'runTargets');
    const collectionIds = requireUnique(project.collections, 'collections');
    requireUnique(project.channels, 'channels');
    requireUniqueSlugs(project.collections, 'collections');
    requireUniqueSlugs(project.channels, 'channels');

    if (!project.locales.includes(project.defaultLocale)) {
      context.addIssue({
        code: 'custom',
        message: 'defaultLocale must appear in locales',
        path: ['defaultLocale'],
      });
    }
    if (new Set(project.locales).size !== project.locales.length) {
      context.addIssue({
        code: 'custom',
        message: 'Project locales must be unique',
        path: ['locales'],
      });
    }
    for (const [index, target] of project.runTargets.entries()) {
      if (!environmentIds.has(target.environmentId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown Environment: ${target.environmentId}`,
          path: ['runTargets', index, 'environmentId'],
        });
      }
      if (!variantIds.has(target.productVariantId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown Product Variant: ${target.productVariantId}`,
          path: ['runTargets', index, 'productVariantId'],
        });
      }
      if (!captureProfileIds.has(target.captureProfileId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown Capture Profile: ${target.captureProfileId}`,
          path: ['runTargets', index, 'captureProfileId'],
        });
      }
    }
    for (const [channelIndex, channel] of project.channels.entries()) {
      const selectedCollectionIds = new Set<string>();
      for (const [collectionIndex, collectionId] of channel.collectionIds.entries()) {
        if (selectedCollectionIds.has(collectionId)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate Channel Collection: ${collectionId}`,
            path: ['channels', channelIndex, 'collectionIds', collectionIndex],
          });
        }
        selectedCollectionIds.add(collectionId);
        if (!collectionIds.has(collectionId)) {
          context.addIssue({
            code: 'custom',
            message: `Unknown Collection: ${collectionId}`,
            path: ['channels', channelIndex, 'collectionIds', collectionIndex],
          });
        }
      }
    }
  });

export const PrivacyRuleConfigSchema = z
  .object({
    id: IdSchema,
    pattern: z.string().min(1).max(5_000),
    flags: z
      .string()
      .regex(/^[gimsuvy]*$/u)
      .default('gu'),
    category: z.enum([
      'password',
      'token',
      'private-key',
      'payment',
      'email',
      'phone',
      'personal-data',
      'authentication',
      'custom',
    ]),
    severity: z.enum(['info', 'low', 'medium', 'high', 'blocking']),
    minConfidence: z.number().min(0).max(1).default(0.8),
  })
  .strict();

export const ScenebookConfigSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    project: z.union([ProjectSchema, RelativePathSchema]),
    paths: z
      .object({
        scenes: z
          .array(z.string().min(1).max(1_024))
          .min(1)
          .default(['scenes/**/*.scene/scene.yaml']),
        output: RelativePathSchema.default('scenebook-dist'),
        cache: RelativePathSchema.default('.scenebook/cache'),
        baselines: RelativePathSchema.default('.scenebook/baselines'),
        publication: RelativePathSchema.default('.scenebook/publication'),
      })
      .strict()
      .default({
        scenes: ['scenes/**/*.scene/scene.yaml'],
        output: 'scenebook-dist',
        cache: '.scenebook/cache',
        baselines: '.scenebook/baselines',
        publication: '.scenebook/publication',
      }),
    capture: z
      .object({
        defaultProfileId: IdSchema.optional(),
        disableAnimations: z.boolean().default(true),
        waitForFonts: z.boolean().default(true),
        includeConsole: z.boolean().default(false),
        includeNetworkMetadata: z.boolean().default(false),
        includeNetworkBodies: z.literal(false).default(false),
        maskSelectors: z.array(z.string().min(1).max(4_096)).max(1_000).default([]),
      })
      .strict()
      .default({
        disableAnimations: true,
        waitForFonts: true,
        includeConsole: false,
        includeNetworkMetadata: false,
        includeNetworkBodies: false,
        maskSelectors: [],
      }),
    privacy: z
      .object({
        blockAt: z.enum(['medium', 'high', 'blocking']).default('high'),
        scanBeforeUpload: z.boolean().default(true),
        ocrBeforePublication: z.boolean().default(true),
        customRules: z.array(PrivacyRuleConfigSchema).max(1_000).default([]),
      })
      .strict()
      .default({
        blockAt: 'high',
        scanBeforeUpload: true,
        ocrBeforePublication: true,
        customRules: [],
      }),
    diff: z
      .object({
        pixelThreshold: z.number().min(0).max(1).default(0.1),
        changedPixelRatio: z.number().min(0).max(1).default(0.005),
        perceptualDistance: z.number().int().min(0).max(256).default(4),
        geometryDistance: z.number().min(0).max(2).default(0.01),
        ignoreAntialiasing: z.boolean().default(true),
      })
      .strict()
      .default({
        pixelThreshold: 0.1,
        changedPixelRatio: 0.005,
        perceptualDistance: 4,
        geometryDistance: 0.01,
        ignoreAntialiasing: true,
      }),
    playwright: z
      .object({
        config: RelativePathSchema.optional(),
        projects: z.array(z.string().min(1).max(200)).max(100).default([]),
        forbidProductionMutations: z.boolean().default(true),
      })
      .strict()
      .default({ projects: [], forbidProductionMutations: true }),
    output: z
      .object({
        formats: z
          .array(
            z.enum([
              'catalog',
              'standalone-html',
              'web-component',
              'iframe',
              'markdown',
              'mdx',
              'html-guide',
              'pdf',
              'mp4',
              'webm',
              'gif',
              'readme-card',
              'og-image',
              'social-carousel',
              'remix-source',
            ]),
          )
          .min(1)
          .default(['catalog', 'standalone-html']),
        basePath: z.string().max(1_024).default('/'),
        attribution: z.boolean().default(true),
      })
      .strict()
      .default({ formats: ['catalog', 'standalone-html'], basePath: '/', attribution: true }),
    metadata: z.record(z.string(), JsonValueSchema).default({}),
  })
  .strict()
  .superRefine((config, context) => {
    const entries = [
      ['output', config.paths.output],
      ['cache', config.paths.cache],
      ['baselines', config.paths.baselines],
      ['publication', config.paths.publication],
    ] as const;
    for (const [index, [leftName, left]] of entries.entries()) {
      for (const [rightName, right] of entries.slice(index + 1)) {
        if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
          context.addIssue({
            code: 'custom',
            message: `${leftName} and ${rightName} paths must not overlap`,
            path: ['paths', leftName],
          });
        }
      }
    }
  });

export type CaptureProfile = z.infer<typeof CaptureProfileSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type ChannelPolicy = z.infer<typeof ChannelPolicySchema>;
export type Collection = z.infer<typeof CollectionSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type ProductVariant = z.infer<typeof ProductVariantSchema>;
export type PublicAnalyticsConfig = z.infer<typeof PublicAnalyticsConfigSchema>;
export type PublicCtaConfig = z.infer<typeof PublicCtaConfigSchema>;
export type PublicDistribution = z.infer<typeof PublicDistributionSchema>;
export type PublicDistributionOverride = z.infer<typeof PublicDistributionOverrideSchema>;
export type PublicSeo = z.infer<typeof PublicSeoSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type RunTarget = z.infer<typeof RunTargetSchema>;
export type ScenebookConfig = z.infer<typeof ScenebookConfigSchema>;
