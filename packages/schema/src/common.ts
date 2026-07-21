import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const ARTIFACT_VERSION = 1 as const;
/**
 * Hashes covered by this contract are SHA-256 digests of UTF-8 encoded
 * Scenebook canonical JSON: recursively key-sorted, compact JSON with no
 * trailing whitespace or newline. Schema parsing/defaulting happens before
 * hashing.
 */
export const CANONICAL_JSON_HASH_CONTRACT = 'scenebook-canonical-json-sha256-v1' as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9._:-]*$/u,
    'Use lowercase letters, numbers, dots, colons, underscores, or hyphens',
  );

export const SlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Use a lowercase kebab-case slug');

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256 digest');

export const CanonicalJsonHashSchema = Sha256Schema.describe(CANONICAL_JSON_HASH_CONTRACT);
export const ArtifactHashSchema = CanonicalJsonHashSchema;
export const SceneSourceRevisionSchema = CanonicalJsonHashSchema;

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => !value.startsWith('/') && !value.includes('\\'),
    'Expected a POSIX relative path',
  )
  .refine(
    (value) => value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Path traversal and empty segments are not allowed',
  );

export const LocaleSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/u, 'Expected a BCP 47 locale');

export const RouteSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    if (value.startsWith('/')) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Expected an absolute HTTP(S) URL or a root-relative route');

/**
 * A deployable public origin or page root. Unlike RouteSchema this is always
 * absolute and cannot smuggle credentials, query parameters, or fragments into
 * generated canonical/share URLs.
 */
export const PublicHttpUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }, 'Expected an absolute HTTP(S) URL')
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.username === '' && parsed.password === '';
  }, 'Public URLs cannot contain credentials')
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.search === '' && parsed.hash === '';
  }, 'Public URLs cannot contain a query string or fragment');

export const PublicHostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    'Expected a lowercase DNS hostname without a scheme, port, or path',
  );

export const NormalizedPointSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();

export const NormalizedRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .superRefine((rect, context) => {
    if (rect.x + rect.width > 1.000_001) {
      context.addIssue({
        code: 'custom',
        message: 'Rectangle exceeds the horizontal boundary',
        path: ['width'],
      });
    }
    if (rect.y + rect.height > 1.000_001) {
      context.addIssue({
        code: 'custom',
        message: 'Rectangle exceeds the vertical boundary',
        path: ['height'],
      });
    }
  });

export const PixelRectSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

export const ViewportSchema = z
  .object({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
    deviceScaleFactor: z.number().positive().max(8).default(1),
    isMobile: z.boolean().default(false),
  })
  .strict();

export const SourceLocationSchema = z
  .object({
    path: RelativePathSchema,
    line: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((location, context) => {
    if (location.endLine !== undefined && location.endLine < location.line) {
      context.addIssue({
        code: 'custom',
        message: 'endLine cannot precede line',
        path: ['endLine'],
      });
    }
  });

export const ProducerSchema = z
  .object({
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(100),
    runtime: z.string().min(1).max(200).optional(),
  })
  .strict();

export const RepositoryRevisionSchema = z
  .object({
    provider: z.enum(['github', 'gitlab', 'bitbucket', 'generic']).default('generic'),
    repository: z.string().min(1).max(500),
    commit: z.string().min(7).max(128),
    branch: z.string().min(1).max(500).optional(),
    ref: z.string().min(1).max(500).optional(),
    dirty: z.boolean().default(false),
  })
  .strict();

export const AssetRoleSchema = z.enum([
  'screenshot',
  'thumbnail',
  'trace',
  'video',
  'audio',
  'document',
  'attachment',
  'diff',
  'other',
]);

export const AssetRefSchema = z
  .object({
    sha256: Sha256Schema,
    path: RelativePathSchema,
    mediaType: z.string().min(3).max(255),
    byteLength: z.number().int().nonnegative(),
    role: AssetRoleSchema.default('other'),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    const filename = asset.path.split('/').at(-1);
    if (!filename?.startsWith(asset.sha256)) {
      context.addIssue({
        code: 'custom',
        message: 'Content-addressed asset filename must begin with its SHA-256 digest',
        path: ['path'],
      });
    }
    if ((asset.width === undefined) !== (asset.height === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'width and height must either both be present or both be absent',
        path: ['width'],
      });
    }
  });

export const SelectorCandidateSchema = z
  .object({
    engine: z.enum(['role', 'label', 'text', 'testId', 'css', 'xpath', 'custom']),
    value: z.string().min(1).max(4096),
    confidence: z.number().min(0).max(1),
    generated: z.boolean().default(true),
  })
  .strict();

export const TargetSchema = z
  .object({
    role: z.string().min(1).max(100).optional(),
    accessibleName: z.string().max(500).optional(),
    nearbyText: z.string().max(1_000).optional(),
    selectors: z.array(SelectorCandidateSchema).max(20).default([]),
    normalizedRect: NormalizedRectSchema.optional(),
    pixelRect: PixelRectSchema.optional(),
    visible: z.boolean().default(true),
    occluded: z.boolean().default(false),
  })
  .strict();

export const SemanticNodeSchema = z
  .object({
    id: IdSchema.optional(),
    role: z.string().min(1).max(100),
    name: z.string().max(1_000).default(''),
    value: z.string().max(1_000).optional(),
    states: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).default({}),
    level: z.number().int().nonnegative().optional(),
  })
  .strict();

export const SemanticProjectionSchema = z
  .object({
    visibleText: z.array(z.string().max(5_000)).max(20_000).default([]),
    nodes: z.array(SemanticNodeSchema).max(20_000).default([]),
    language: LocaleSchema.optional(),
    title: z.string().max(1_000).optional(),
  })
  .strict();

export const PrivacyCategorySchema = z.enum([
  'password',
  'token',
  'private-key',
  'payment',
  'email',
  'phone',
  'personal-data',
  'authentication',
  'custom',
]);

export const PrivacySeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'blocking']);
export const PrivacyDispositionSchema = z.enum([
  'open',
  'masked',
  'allowed',
  'false-positive',
  'quarantined',
]);

export const PrivacyFindingSchema = z
  .object({
    id: IdSchema,
    category: PrivacyCategorySchema,
    severity: PrivacySeveritySchema,
    confidence: z.number().min(0).max(1),
    source: z.enum(['text', 'url', 'semantic', 'ocr', 'field', 'custom']),
    path: z.string().min(1).max(2_000),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    fingerprint: Sha256Schema,
    preview: z.string().max(200).optional(),
    region: NormalizedRectSchema.optional(),
    ruleId: IdSchema,
    message: z.string().min(1).max(1_000),
    disposition: PrivacyDispositionSchema.default('open'),
  })
  .strict()
  .superRefine((finding, context) => {
    if ((finding.start === undefined) !== (finding.end === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'start and end must be supplied together',
        path: ['start'],
      });
    }
    if (finding.start !== undefined && finding.end !== undefined && finding.end <= finding.start) {
      context.addIssue({
        code: 'custom',
        message: 'end must be greater than start',
        path: ['end'],
      });
    }
  });

export const PrivacySummarySchema = z
  .object({
    status: z.enum(['unknown', 'clear', 'warning', 'blocked', 'quarantined']),
    scannedAt: IsoDateTimeSchema,
    scannerVersion: z.string().min(1).max(100),
    counts: z
      .object({
        info: z.number().int().nonnegative().default(0),
        low: z.number().int().nonnegative().default(0),
        medium: z.number().int().nonnegative().default(0),
        high: z.number().int().nonnegative().default(0),
        blocking: z.number().int().nonnegative().default(0),
      })
      .strict(),
    findings: z.array(PrivacyFindingSchema).default([]),
  })
  .strict()
  .superRefine((summary, context) => {
    const actual = {
      info: summary.findings.filter((finding) => finding.severity === 'info').length,
      low: summary.findings.filter((finding) => finding.severity === 'low').length,
      medium: summary.findings.filter((finding) => finding.severity === 'medium').length,
      high: summary.findings.filter((finding) => finding.severity === 'high').length,
      blocking: summary.findings.filter((finding) => finding.severity === 'blocking').length,
    };
    for (const severity of ['info', 'low', 'medium', 'high', 'blocking'] as const) {
      if (summary.counts[severity] !== actual[severity]) {
        context.addIssue({
          code: 'custom',
          message: `Privacy count for ${severity} does not match findings`,
          path: ['counts', severity],
        });
      }
    }
    const unresolved = summary.findings.filter((finding) => finding.disposition === 'open');
    if (summary.status === 'clear' && unresolved.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'A clear privacy summary cannot contain unresolved findings',
        path: ['status'],
      });
    }
    if (
      summary.status === 'blocked' &&
      !unresolved.some(
        (finding) =>
          finding.severity === 'medium' ||
          finding.severity === 'high' ||
          finding.severity === 'blocking',
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A blocked privacy summary requires an unresolved high or blocking finding',
        path: ['status'],
      });
    }
  });

export type AssetRef = z.infer<typeof AssetRefSchema>;
export type JsonObject = Record<string, JsonValue>;
export type NormalizedPoint = z.infer<typeof NormalizedPointSchema>;
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>;
export type PixelRect = z.infer<typeof PixelRectSchema>;
export type PrivacyCategory = z.infer<typeof PrivacyCategorySchema>;
export type PrivacyFinding = z.infer<typeof PrivacyFindingSchema>;
export type PrivacySeverity = z.infer<typeof PrivacySeveritySchema>;
export type PrivacySummary = z.infer<typeof PrivacySummarySchema>;
export type RepositoryRevision = z.infer<typeof RepositoryRevisionSchema>;
export type SemanticProjection = z.infer<typeof SemanticProjectionSchema>;
export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type Viewport = z.infer<typeof ViewportSchema>;
