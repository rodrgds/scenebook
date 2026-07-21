import { z } from 'zod';

import { IdentityTokenService, MAX_PREVIOUS_IDENTITY_VERIFICATION_KEYS } from './auth.js';
import { normalizeCustomDomainHostname } from './custom-domains.js';

const WebhookConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u),
    url: z.string().url(),
    secret: z.string().min(32),
    timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  })
  .strict();

const CustomDomainHostnameSchema = z.string().transform((value, context) => {
  try {
    return normalizeCustomDomainHostname(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid custom-domain hostname',
    });
    return z.NEVER;
  }
});

const CustomDomainsConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('disabled') }).strict(),
  z
    .object({
      kind: z.literal('http'),
      routingTarget: CustomDomainHostnameSchema,
      provisionerUrl: z.string().url(),
      provisionerSecret: z.string().min(32),
      timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
    })
    .strict(),
]);

const GitHubAppConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('disabled') }).strict(),
  z
    .object({
      kind: z.literal('enabled'),
      appId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
      privateKeyPem: z
        .string()
        .min(128)
        .refine(
          (value) =>
            (value.includes('-----BEGIN PRIVATE KEY-----') &&
              value.includes('-----END PRIVATE KEY-----')) ||
            (value.includes('-----BEGIN RSA PRIVATE KEY-----') &&
              value.includes('-----END RSA PRIVATE KEY-----')),
          'GitHub App key must be an unencrypted PEM private key',
        ),
      apiBaseUrl: z.string().url().default('https://api.github.com'),
      allowedEnterpriseApiOrigins: z.array(z.string().url()).max(20).default([]),
      timeoutMs: z.number().int().min(1_000).max(30_000).default(15_000),
      changeLeaseSeconds: z.number().int().min(30).max(900).default(120),
    })
    .strict(),
]);

const ServerConfigSchema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('production'),
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().min(1).max(65_535).default(4310),
    publicBaseUrl: z.string().url(),
    publicationBaseUrl: z.string().url(),
    databaseUrl: z.string().min(1),
    adminToken: z.string().min(32),
    uploadTokenSecret: z.string().min(32),
    identityTokenSecret: z.string().min(32),
    identitySigningPrivateKey: z.string().min(40),
    identityVerificationPublicKey: z.string().min(40),
    identityPreviousVerificationPublicKeys: z
      .array(z.string().min(40))
      .max(MAX_PREVIOUS_IDENTITY_VERIFICATION_KEYS)
      .default([]),
    runnerTokenSecret: z.string().min(32),
    analyticsHashSecret: z.string().min(32),
    ctaEncryptionKey: z.string().min(43),
    objectStore: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('filesystem'), root: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal('s3'),
          bucket: z.string().min(3),
          region: z.string().min(1),
          endpoint: z.string().url().optional(),
          accessKeyId: z.string().min(1).optional(),
          secretAccessKey: z.string().min(1).optional(),
          forcePathStyle: z.boolean().default(false),
        })
        .strict(),
    ]),
    github: z
      .object({
        issuer: z.string().url().default('https://token.actions.githubusercontent.com'),
        jwksUrl: z
          .string()
          .url()
          .default('https://token.actions.githubusercontent.com/.well-known/jwks'),
        audience: z.string().min(1).default('scenebook'),
        uploadTokenTtlSeconds: z.number().int().min(60).max(900).default(300),
      })
      .strict(),
    githubApp: GitHubAppConfigSchema.default({ kind: 'disabled' }),
    identity: z
      .object({
        sessionTtlSeconds: z.number().int().min(300).max(86_400).default(28_800),
        apiTokenMaxTtlSeconds: z.number().int().min(3_600).max(31_536_000).default(7_776_000),
        shareLinkMaxTtlSeconds: z.number().int().min(300).max(2_592_000).default(604_800),
      })
      .strict(),
    publicationLogin: z
      .object({
        exchangeSecret: z.string().min(32),
        handoffTtlSeconds: z.number().int().min(15).max(300).default(60),
      })
      .strict(),
    scheduling: z
      .object({
        workerIntervalMs: z.number().int().min(1_000).max(300_000).default(5_000),
        workerBatchSize: z.number().int().min(1).max(10_000).default(100),
        runnerLeaseSeconds: z.number().int().min(30).max(900).default(120),
      })
      .strict(),
    customDomains: CustomDomainsConfigSchema.default({ kind: 'disabled' }),
    maxJsonBytes: z
      .number()
      .int()
      .min(1_024)
      .max(10 * 1024 * 1024)
      .default(512 * 1024),
    maxObjectBytes: z
      .number()
      .int()
      .min(1_024)
      .max(2 * 1024 * 1024 * 1024)
      .default(250 * 1024 * 1024),
    uploadLimits: z
      .object({
        maxObjectsPerUpload: z.number().int().min(1).max(10_000).default(512),
        maxBytesPerUpload: z
          .number()
          .int()
          .min(1_024)
          .max(64 * 1024 * 1024 * 1024)
          .default(2 * 1024 * 1024 * 1024),
        maxActiveUploadsPerTenant: z.number().int().min(1).max(100_000).default(32),
        maxActiveUploadsGlobal: z.number().int().min(1).max(1_000_000).default(2_048),
        maxActiveBytesPerTenant: z
          .number()
          .int()
          .min(1_024)
          .max(1024 * 1024 * 1024 * 1024)
          .default(8 * 1024 * 1024 * 1024),
        maxActiveBytesGlobal: z
          .number()
          .int()
          .min(1_024)
          .max(Number.MAX_SAFE_INTEGER)
          .default(256 * 1024 * 1024 * 1024),
        maxConcurrentObjectsPerTenant: z.number().int().min(1).max(10_000).default(4),
        maxConcurrentObjectsGlobal: z.number().int().min(1).max(100_000).default(64),
        maxConcurrentBytesPerTenant: z
          .number()
          .int()
          .min(1_024)
          .max(64 * 1024 * 1024 * 1024)
          .default(512 * 1024 * 1024),
        maxConcurrentBytesGlobal: z
          .number()
          .int()
          .min(1_024)
          .max(1024 * 1024 * 1024 * 1024)
          .default(8 * 1024 * 1024 * 1024),
        gcIntervalMs: z
          .number()
          .int()
          .min(1_000)
          .max(24 * 60 * 60 * 1_000)
          .default(60_000),
        gcBatchSize: z.number().int().min(1).max(10_000).default(100),
        gcClaimTtlSeconds: z.number().int().min(30).max(3_600).default(300),
      })
      .strict(),
    evidenceRetention: z
      .object({
        enabled: z.boolean().default(false),
        standardGraceSeconds: z.number().int().min(86_400).max(31_536_000).default(7_776_000),
        diagnosticGraceSeconds: z.number().int().min(3_600).max(2_592_000).default(604_800),
        workerIntervalMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
        batchSize: z.number().int().min(1).max(1_000).default(50),
        claimTtlSeconds: z.number().int().min(30).max(3_600).default(300),
        deleteCredential: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('disabled') }).strict(),
          z.object({ kind: z.literal('filesystem') }).strict(),
          z
            .object({
              kind: z.literal('s3'),
              accessKeyId: z.string().min(1),
              secretAccessKey: z.string().min(1),
            })
            .strict(),
        ]),
      })
      .strict(),
    workspaceExport: z
      .object({
        maxRecords: z.number().int().min(100).max(1_000_000).default(100_000),
        maxAssetBytes: z
          .number()
          .int()
          .min(1_024)
          .max(Number.MAX_SAFE_INTEGER)
          .default(4 * 1024 * 1024 * 1024),
        maxAssets: z.number().int().min(1).max(100_000).default(10_000),
        maxMetadataBytes: z
          .number()
          .int()
          .min(1_024)
          .max(Number.MAX_SAFE_INTEGER)
          .default(64 * 1024 * 1024),
        maxTotalBytes: z.number().int().min(1_024).max(0xffff_ffff).default(0xffff_ffff),
      })
      .strict(),
    rateLimit: z
      .object({
        windowMs: z.number().int().min(1_000).default(60_000),
        requests: z.number().int().positive().default(120),
        aggregateRequests: z.number().int().positive().default(300),
      })
      .strict(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    allowHttpWebhooks: z.boolean().default(false),
    webhooks: z.array(WebhookConfigSchema).max(100).default([]),
    autoMigrate: z.boolean().default(true),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      new IdentityTokenService({
        apiTokenHashSecret: config.identityTokenSecret,
        signingPrivateKey: config.identitySigningPrivateKey,
        verificationPublicKey: config.identityVerificationPublicKey,
        previousVerificationPublicKeys: config.identityPreviousVerificationPublicKeys,
      });
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['identityVerificationPublicKey'],
        message: error instanceof Error ? error.message : 'Identity key configuration is invalid',
      });
    }
    if (config.nodeEnv === 'production' && new URL(config.publicBaseUrl).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        message: 'Production public URL must use HTTPS',
        path: ['publicBaseUrl'],
      });
    }
    const publicationUrl = new URL(config.publicationBaseUrl);
    if (
      publicationUrl.pathname !== '/' ||
      publicationUrl.search ||
      publicationUrl.hash ||
      publicationUrl.username ||
      publicationUrl.password
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Publication URL must be an origin without credentials, a path, query, or fragment',
        path: ['publicationBaseUrl'],
      });
    }
    if (config.nodeEnv === 'production' && publicationUrl.protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        message: 'Production publication URL must use HTTPS',
        path: ['publicationBaseUrl'],
      });
    }
    if (publicationUrl.origin === new URL(config.publicBaseUrl).origin) {
      context.addIssue({
        code: 'custom',
        message: 'Publication and control-plane URLs must use distinct origins',
        path: ['publicationBaseUrl'],
      });
    }
    if (config.nodeEnv === 'production' && config.allowHttpWebhooks) {
      context.addIssue({
        code: 'custom',
        message: 'Production webhook delivery must use HTTPS',
        path: ['allowHttpWebhooks'],
      });
    }
    if (config.customDomains.kind === 'http') {
      const provisionerUrl = new URL(config.customDomains.provisionerUrl);
      if (provisionerUrl.username || provisionerUrl.password || provisionerUrl.hash) {
        context.addIssue({
          code: 'custom',
          message: 'Custom-domain provisioner URL cannot contain credentials or a fragment',
          path: ['customDomains', 'provisionerUrl'],
        });
      }
      if (config.nodeEnv === 'production' && provisionerUrl.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          message: 'Production custom-domain provisioning must use HTTPS',
          path: ['customDomains', 'provisionerUrl'],
        });
      }
      const controlPlaneHostname = new URL(config.publicBaseUrl).hostname.toLowerCase();
      if (config.customDomains.routingTarget === controlPlaneHostname) {
        context.addIssue({
          code: 'custom',
          message: 'Custom-domain routing target must not be the control-plane origin',
          path: ['customDomains', 'routingTarget'],
        });
      }
    }
    if (config.githubApp.kind === 'enabled') {
      const api = new URL(config.githubApp.apiBaseUrl);
      const allowedOrigins: string[] = [];
      for (const [index, raw] of config.githubApp.allowedEnterpriseApiOrigins.entries()) {
        const candidate = new URL(raw);
        if (
          candidate.protocol !== 'https:' ||
          candidate.pathname !== '/' ||
          candidate.search ||
          candidate.hash ||
          candidate.username ||
          candidate.password
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Enterprise GitHub API allowlist entries must be credential-free HTTPS origins',
            path: ['githubApp', 'allowedEnterpriseApiOrigins', index],
          });
        }
        allowedOrigins.push(candidate.origin);
      }
      if (
        api.protocol !== 'https:' ||
        api.pathname !== '/' ||
        api.search ||
        api.hash ||
        api.username ||
        api.password
      ) {
        context.addIssue({
          code: 'custom',
          message: 'GitHub App API URL must be a credential-free HTTPS origin',
          path: ['githubApp', 'apiBaseUrl'],
        });
      } else if (api.origin !== 'https://api.github.com' && !allowedOrigins.includes(api.origin)) {
        context.addIssue({
          code: 'custom',
          message: 'Enterprise GitHub API origin is not present in the operator allowlist',
          path: ['githubApp', 'apiBaseUrl'],
        });
      }
    }
    const independentSecrets = [
      config.adminToken,
      config.uploadTokenSecret,
      config.identityTokenSecret,
      config.runnerTokenSecret,
      config.analyticsHashSecret,
      config.ctaEncryptionKey,
      config.publicationLogin.exchangeSecret,
      ...(config.customDomains.kind === 'http' ? [config.customDomains.provisionerSecret] : []),
      ...(config.evidenceRetention.deleteCredential.kind === 's3'
        ? [config.evidenceRetention.deleteCredential.secretAccessKey]
        : []),
      ...(config.objectStore.kind === 's3' && config.objectStore.secretAccessKey
        ? [config.objectStore.secretAccessKey]
        : []),
    ];
    if (
      config.nodeEnv === 'production' &&
      new Set(independentSecrets).size !== independentSecrets.length
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Admin, upload, identity, runner, analytics, CTA, publication-login, and provisioner credentials must use independent secrets',
        path: ['runnerTokenSecret'],
      });
    }
    if (
      config.objectStore.kind === 's3' &&
      (config.objectStore.accessKeyId === undefined) !==
        (config.objectStore.secretAccessKey === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'S3 access key ID and secret access key must be configured together',
        path: ['objectStore'],
      });
    }
    if (config.evidenceRetention.enabled) {
      if (config.evidenceRetention.deleteCredential.kind === 'disabled') {
        context.addIssue({
          code: 'custom',
          message: 'Enabled evidence retention requires a distinct final-delete capability',
          path: ['evidenceRetention', 'deleteCredential'],
        });
      }
      if (
        config.objectStore.kind === 's3' &&
        config.evidenceRetention.deleteCredential.kind !== 's3'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'S3 evidence retention requires separate S3 final-delete credentials',
          path: ['evidenceRetention', 'deleteCredential'],
        });
      }
      if (
        config.objectStore.kind === 'filesystem' &&
        config.evidenceRetention.deleteCredential.kind !== 'filesystem'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Filesystem evidence retention requires the filesystem delete capability',
          path: ['evidenceRetention', 'deleteCredential'],
        });
      }
      if (
        config.objectStore.kind === 's3' &&
        config.evidenceRetention.deleteCredential.kind === 's3' &&
        config.objectStore.accessKeyId &&
        config.objectStore.accessKeyId === config.evidenceRetention.deleteCredential.accessKeyId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Final-delete and ordinary object-store credentials must be distinct',
          path: ['evidenceRetention', 'deleteCredential', 'accessKeyId'],
        });
      }
      if (
        config.evidenceRetention.diagnosticGraceSeconds >=
        config.evidenceRetention.standardGraceSeconds
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Diagnostic evidence grace must be shorter than standard evidence grace',
          path: ['evidenceRetention', 'diagnosticGraceSeconds'],
        });
      }
    }
    if (
      config.uploadLimits.maxActiveUploadsPerTenant > config.uploadLimits.maxActiveUploadsGlobal
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Tenant active-upload limit cannot exceed the global limit',
        path: ['uploadLimits', 'maxActiveUploadsPerTenant'],
      });
    }
    if (config.uploadLimits.maxActiveBytesPerTenant > config.uploadLimits.maxActiveBytesGlobal) {
      context.addIssue({
        code: 'custom',
        message: 'Tenant active-byte limit cannot exceed the global limit',
        path: ['uploadLimits', 'maxActiveBytesPerTenant'],
      });
    }
    if (
      config.uploadLimits.maxConcurrentObjectsPerTenant >
      config.uploadLimits.maxConcurrentObjectsGlobal
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Tenant concurrent-object limit cannot exceed the global limit',
        path: ['uploadLimits', 'maxConcurrentObjectsPerTenant'],
      });
    }
    if (
      config.uploadLimits.maxConcurrentBytesPerTenant > config.uploadLimits.maxConcurrentBytesGlobal
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Tenant concurrent-byte limit cannot exceed the global limit',
        path: ['uploadLimits', 'maxConcurrentBytesPerTenant'],
      });
    }
  });

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

function jsonStringArray(env: NodeJS.ProcessEnv, key: string): string[] {
  const raw = env[key];
  if (raw === undefined || raw === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${key} must be a JSON array of strings`);
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be a JSON array of strings`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${key} must be true/false or 1/0`);
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const storeKind = env.SCENEBOOK_OBJECT_STORE ?? 'filesystem';
  if (storeKind !== 'filesystem' && storeKind !== 's3') {
    throw new Error('SCENEBOOK_OBJECT_STORE must be filesystem or s3');
  }
  const objectStore =
    storeKind === 's3'
      ? {
          kind: 's3' as const,
          bucket: required(env, 'SCENEBOOK_S3_BUCKET'),
          region: env.SCENEBOOK_S3_REGION ?? 'us-east-1',
          endpoint: env.SCENEBOOK_S3_ENDPOINT,
          accessKeyId: env.SCENEBOOK_S3_ACCESS_KEY_ID,
          secretAccessKey: env.SCENEBOOK_S3_SECRET_ACCESS_KEY,
          forcePathStyle: boolean(env, 'SCENEBOOK_S3_FORCE_PATH_STYLE', false),
        }
      : {
          kind: 'filesystem' as const,
          root: env.SCENEBOOK_STORAGE_ROOT ?? '/var/lib/scenebook/objects',
        };
  let webhooks: unknown = [];
  if (env.SCENEBOOK_WEBHOOKS_JSON) {
    try {
      webhooks = JSON.parse(env.SCENEBOOK_WEBHOOKS_JSON) as unknown;
    } catch (error) {
      throw new Error('SCENEBOOK_WEBHOOKS_JSON must be valid JSON', { cause: error });
    }
  }
  const customDomainValues = [
    env.SCENEBOOK_CUSTOM_DOMAIN_ROUTING_TARGET,
    env.SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_URL,
    env.SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_SECRET,
  ].map((value) => (value?.trim() ? value : undefined));
  const customDomains = customDomainValues.every((value) => value === undefined)
    ? ({ kind: 'disabled' } as const)
    : {
        kind: 'http' as const,
        routingTarget: required(env, 'SCENEBOOK_CUSTOM_DOMAIN_ROUTING_TARGET'),
        provisionerUrl: required(env, 'SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_URL'),
        provisionerSecret: required(env, 'SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_SECRET'),
        timeoutMs: integer(env, 'SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_TIMEOUT_MS', 10_000),
      };
  const githubAppValues = [env.SCENEBOOK_GITHUB_APP_ID, env.SCENEBOOK_GITHUB_APP_PRIVATE_KEY].map(
    (value) => (value?.trim() ? value : undefined),
  );
  const githubApp = githubAppValues.every((value) => value === undefined)
    ? ({ kind: 'disabled' } as const)
    : {
        kind: 'enabled' as const,
        appId: required(env, 'SCENEBOOK_GITHUB_APP_ID'),
        privateKeyPem: required(env, 'SCENEBOOK_GITHUB_APP_PRIVATE_KEY').replace(/\\n/gu, '\n'),
        apiBaseUrl: env.SCENEBOOK_GITHUB_APP_API_URL ?? 'https://api.github.com',
        allowedEnterpriseApiOrigins: (env.SCENEBOOK_GITHUB_APP_ALLOWED_API_ORIGINS ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        timeoutMs: integer(env, 'SCENEBOOK_GITHUB_APP_TIMEOUT_MS', 15_000),
        changeLeaseSeconds: integer(env, 'SCENEBOOK_GITHUB_CHANGE_LEASE_SECONDS', 120),
      };
  const retentionEnabled = boolean(env, 'SCENEBOOK_EVIDENCE_RETENTION_ENABLED', false);
  const deleteCredential = !retentionEnabled
    ? ({ kind: 'disabled' } as const)
    : storeKind === 's3'
      ? {
          kind: 's3' as const,
          accessKeyId: required(env, 'SCENEBOOK_S3_FINAL_DELETE_ACCESS_KEY_ID'),
          secretAccessKey: required(env, 'SCENEBOOK_S3_FINAL_DELETE_SECRET_ACCESS_KEY'),
        }
      : ({ kind: 'filesystem' } as const);
  return ServerConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: integer(env, 'PORT', 4310),
    publicBaseUrl: required(env, 'SCENEBOOK_PUBLIC_URL'),
    publicationBaseUrl: required(env, 'SCENEBOOK_PUBLICATION_URL'),
    databaseUrl: required(env, 'DATABASE_URL'),
    adminToken: required(env, 'SCENEBOOK_ADMIN_TOKEN'),
    uploadTokenSecret: required(env, 'SCENEBOOK_UPLOAD_TOKEN_SECRET'),
    identityTokenSecret: required(env, 'SCENEBOOK_IDENTITY_TOKEN_SECRET'),
    identitySigningPrivateKey: required(env, 'SCENEBOOK_IDENTITY_SIGNING_PRIVATE_KEY'),
    identityVerificationPublicKey: required(env, 'SCENEBOOK_IDENTITY_VERIFICATION_PUBLIC_KEY'),
    identityPreviousVerificationPublicKeys: jsonStringArray(
      env,
      'SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON',
    ),
    runnerTokenSecret: required(env, 'SCENEBOOK_RUNNER_TOKEN_SECRET'),
    analyticsHashSecret: required(env, 'SCENEBOOK_ANALYTICS_HASH_SECRET'),
    ctaEncryptionKey: required(env, 'SCENEBOOK_CTA_ENCRYPTION_KEY'),
    objectStore,
    github: {
      issuer: env.SCENEBOOK_GITHUB_OIDC_ISSUER,
      jwksUrl: env.SCENEBOOK_GITHUB_OIDC_JWKS_URL,
      audience: env.SCENEBOOK_GITHUB_OIDC_AUDIENCE,
      uploadTokenTtlSeconds: integer(env, 'SCENEBOOK_UPLOAD_TOKEN_TTL_SECONDS', 300),
    },
    githubApp,
    identity: {
      sessionTtlSeconds: integer(env, 'SCENEBOOK_SESSION_TTL_SECONDS', 28_800),
      apiTokenMaxTtlSeconds: integer(env, 'SCENEBOOK_API_TOKEN_MAX_TTL_SECONDS', 7_776_000),
      shareLinkMaxTtlSeconds: integer(env, 'SCENEBOOK_SHARE_LINK_MAX_TTL_SECONDS', 604_800),
    },
    publicationLogin: {
      exchangeSecret: required(env, 'SCENEBOOK_GATEWAY_EXCHANGE_SECRET'),
      handoffTtlSeconds: integer(env, 'SCENEBOOK_PUBLICATION_LOGIN_TTL_SECONDS', 60),
    },
    scheduling: {
      workerIntervalMs: integer(env, 'SCENEBOOK_SCHEDULER_INTERVAL_MS', 5_000),
      workerBatchSize: integer(env, 'SCENEBOOK_SCHEDULER_BATCH_SIZE', 100),
      runnerLeaseSeconds: integer(env, 'SCENEBOOK_RUNNER_LEASE_SECONDS', 120),
    },
    customDomains,
    maxJsonBytes: integer(env, 'SCENEBOOK_MAX_JSON_BYTES', 512 * 1024),
    maxObjectBytes: integer(env, 'SCENEBOOK_MAX_OBJECT_BYTES', 250 * 1024 * 1024),
    uploadLimits: {
      maxObjectsPerUpload: integer(env, 'SCENEBOOK_MAX_UPLOAD_OBJECTS', 512),
      maxBytesPerUpload: integer(env, 'SCENEBOOK_MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024),
      maxActiveUploadsPerTenant: integer(env, 'SCENEBOOK_MAX_ACTIVE_UPLOADS_TENANT', 32),
      maxActiveUploadsGlobal: integer(env, 'SCENEBOOK_MAX_ACTIVE_UPLOADS_GLOBAL', 2_048),
      maxActiveBytesPerTenant: integer(
        env,
        'SCENEBOOK_MAX_ACTIVE_UPLOAD_BYTES_TENANT',
        8 * 1024 * 1024 * 1024,
      ),
      maxActiveBytesGlobal: integer(
        env,
        'SCENEBOOK_MAX_ACTIVE_UPLOAD_BYTES_GLOBAL',
        256 * 1024 * 1024 * 1024,
      ),
      maxConcurrentObjectsPerTenant: integer(env, 'SCENEBOOK_MAX_CONCURRENT_UPLOADS_TENANT', 4),
      maxConcurrentObjectsGlobal: integer(env, 'SCENEBOOK_MAX_CONCURRENT_UPLOADS_GLOBAL', 64),
      maxConcurrentBytesPerTenant: integer(
        env,
        'SCENEBOOK_MAX_CONCURRENT_UPLOAD_BYTES_TENANT',
        512 * 1024 * 1024,
      ),
      maxConcurrentBytesGlobal: integer(
        env,
        'SCENEBOOK_MAX_CONCURRENT_UPLOAD_BYTES_GLOBAL',
        8 * 1024 * 1024 * 1024,
      ),
      gcIntervalMs: integer(env, 'SCENEBOOK_UPLOAD_GC_INTERVAL_MS', 60_000),
      gcBatchSize: integer(env, 'SCENEBOOK_UPLOAD_GC_BATCH_SIZE', 100),
      gcClaimTtlSeconds: integer(env, 'SCENEBOOK_UPLOAD_GC_CLAIM_TTL_SECONDS', 300),
    },
    evidenceRetention: {
      enabled: retentionEnabled,
      standardGraceSeconds: integer(
        env,
        'SCENEBOOK_EVIDENCE_STANDARD_RETENTION_GRACE_SECONDS',
        7_776_000,
      ),
      diagnosticGraceSeconds: integer(
        env,
        'SCENEBOOK_EVIDENCE_DIAGNOSTIC_RETENTION_GRACE_SECONDS',
        604_800,
      ),
      workerIntervalMs: integer(env, 'SCENEBOOK_EVIDENCE_RETENTION_INTERVAL_MS', 3_600_000),
      batchSize: integer(env, 'SCENEBOOK_EVIDENCE_RETENTION_BATCH_SIZE', 50),
      claimTtlSeconds: integer(env, 'SCENEBOOK_EVIDENCE_RETENTION_CLAIM_TTL_SECONDS', 300),
      deleteCredential,
    },
    workspaceExport: {
      maxRecords: integer(env, 'SCENEBOOK_WORKSPACE_EXPORT_MAX_RECORDS', 100_000),
      maxAssetBytes: integer(
        env,
        'SCENEBOOK_WORKSPACE_EXPORT_MAX_ASSET_BYTES',
        4 * 1024 * 1024 * 1024,
      ),
      maxAssets: integer(env, 'SCENEBOOK_WORKSPACE_EXPORT_MAX_ASSETS', 10_000),
      maxMetadataBytes: integer(
        env,
        'SCENEBOOK_WORKSPACE_EXPORT_MAX_METADATA_BYTES',
        64 * 1024 * 1024,
      ),
      maxTotalBytes: integer(env, 'SCENEBOOK_WORKSPACE_EXPORT_MAX_TOTAL_BYTES', 0xffff_ffff),
    },
    rateLimit: {
      windowMs: integer(env, 'SCENEBOOK_RATE_WINDOW_MS', 60_000),
      requests: integer(env, 'SCENEBOOK_RATE_REQUESTS', 120),
      aggregateRequests: integer(env, 'SCENEBOOK_RATE_AGGREGATE_REQUESTS', 300),
    },
    logLevel: env.SCENEBOOK_LOG_LEVEL,
    allowHttpWebhooks: boolean(env, 'SCENEBOOK_ALLOW_HTTP_WEBHOOKS', false),
    webhooks,
    autoMigrate: boolean(env, 'SCENEBOOK_AUTO_MIGRATE', true),
  });
}

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
