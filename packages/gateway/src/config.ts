import { z } from 'zod';
import { IdentityTokenVerifier, MAX_PREVIOUS_IDENTITY_VERIFICATION_KEYS } from '@scenebook/server';

const ObjectStoreConfigSchema = z.discriminatedUnion('kind', [
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
]);

export const PublicationGatewayConfigSchema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('production'),
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().min(1).max(65_535).default(4320),
    publicationBaseUrl: z.string().url(),
    controlPlaneBaseUrl: z.string().url(),
    controlPlaneInternalBaseUrl: z.string().url(),
    databaseUrl: z.string().min(1),
    identityVerificationPublicKey: z.string().min(40),
    identityPreviousVerificationPublicKeys: z
      .array(z.string().min(40))
      .max(MAX_PREVIOUS_IDENTITY_VERIFICATION_KEYS)
      .default([]),
    sessionSecret: z.string().min(32),
    bootstrapExchangeSecret: z.string().min(32),
    bootstrapTimeoutMs: z.number().int().min(500).max(30_000).default(5_000),
    sessionTtlSeconds: z.number().int().min(300).max(86_400).default(28_800),
    maxJsonBytes: z
      .number()
      .int()
      .min(1_024)
      .max(1024 * 1024)
      .default(16 * 1024),
    maxMemberBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(2 * 1024 * 1024 * 1024)
      .default(512 * 1024 * 1024),
    maxCacheBytes: z
      .number()
      .int()
      .min(16 * 1024 * 1024)
      .max(16 * 1024 * 1024 * 1024)
      .default(512 * 1024 * 1024),
    maxConcurrentResponses: z.number().int().min(1).max(128).default(4),
    temporaryRoot: z.string().min(1).default('/tmp/scenebook-publication-gateway'),
    objectStore: ObjectStoreConfigSchema,
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .strict()
  .superRefine((config, context) => {
    try {
      new IdentityTokenVerifier({
        activeVerificationPublicKey: config.identityVerificationPublicKey,
        previousVerificationPublicKeys: config.identityPreviousVerificationPublicKeys,
      });
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['identityVerificationPublicKey'],
        message: error instanceof Error ? error.message : 'Identity key configuration is invalid',
      });
    }
    const publication = new URL(config.publicationBaseUrl);
    const control = new URL(config.controlPlaneBaseUrl);
    const internalControl = new URL(config.controlPlaneInternalBaseUrl);
    for (const [key, value] of [
      ['publicationBaseUrl', publication],
      ['controlPlaneBaseUrl', control],
    ] as const) {
      if (
        value.pathname !== '/' ||
        value.search ||
        value.hash ||
        value.username ||
        value.password
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Service URL must be an origin without credentials, path, query, or fragment',
          path: [key],
        });
      }
      if (config.nodeEnv === 'production' && value.protocol !== 'https:') {
        context.addIssue({ code: 'custom', message: 'Production URL must use HTTPS', path: [key] });
      }
    }
    if (publication.origin === control.origin) {
      context.addIssue({
        code: 'custom',
        message: 'Publication and control-plane origins must be distinct',
        path: ['publicationBaseUrl'],
      });
    }
    if (
      (internalControl.protocol !== 'http:' && internalControl.protocol !== 'https:') ||
      internalControl.pathname !== '/' ||
      internalControl.search ||
      internalControl.hash ||
      internalControl.username ||
      internalControl.password
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Internal control-plane URL must be an HTTP(S), credential-free origin',
        path: ['controlPlaneInternalBaseUrl'],
      });
    }
    if (
      config.nodeEnv === 'production' &&
      config.sessionSecret === config.bootstrapExchangeSecret
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Gateway-session and bootstrap-exchange secrets must be independent',
        path: ['bootstrapExchangeSecret'],
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

export function loadPublicationGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): PublicationGatewayConfig {
  const kind = env.SCENEBOOK_OBJECT_STORE ?? 'filesystem';
  if (kind !== 'filesystem' && kind !== 's3') {
    throw new Error('SCENEBOOK_OBJECT_STORE must be filesystem or s3');
  }
  const objectStore =
    kind === 's3'
      ? {
          kind,
          bucket: required(env, 'SCENEBOOK_S3_BUCKET'),
          region: env.SCENEBOOK_S3_REGION ?? 'us-east-1',
          endpoint: env.SCENEBOOK_S3_ENDPOINT,
          accessKeyId: env.SCENEBOOK_S3_ACCESS_KEY_ID,
          secretAccessKey: env.SCENEBOOK_S3_SECRET_ACCESS_KEY,
          forcePathStyle: boolean(env, 'SCENEBOOK_S3_FORCE_PATH_STYLE', false),
        }
      : { kind, root: env.SCENEBOOK_STORAGE_ROOT ?? '/var/lib/scenebook/objects' };
  return PublicationGatewayConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: integer(env, 'PORT', 4320),
    publicationBaseUrl: required(env, 'SCENEBOOK_PUBLICATION_URL'),
    controlPlaneBaseUrl: required(env, 'SCENEBOOK_PUBLIC_URL'),
    controlPlaneInternalBaseUrl: required(env, 'SCENEBOOK_CONTROL_PLANE_INTERNAL_URL'),
    databaseUrl: required(env, 'DATABASE_URL'),
    identityVerificationPublicKey: required(env, 'SCENEBOOK_IDENTITY_VERIFICATION_PUBLIC_KEY'),
    identityPreviousVerificationPublicKeys: jsonStringArray(
      env,
      'SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON',
    ),
    sessionSecret: required(env, 'SCENEBOOK_GATEWAY_SESSION_SECRET'),
    bootstrapExchangeSecret: required(env, 'SCENEBOOK_GATEWAY_EXCHANGE_SECRET'),
    bootstrapTimeoutMs: integer(env, 'SCENEBOOK_GATEWAY_EXCHANGE_TIMEOUT_MS', 5_000),
    sessionTtlSeconds: integer(env, 'SCENEBOOK_GATEWAY_SESSION_TTL_SECONDS', 28_800),
    maxJsonBytes: integer(env, 'SCENEBOOK_GATEWAY_MAX_JSON_BYTES', 16 * 1024),
    maxMemberBytes: integer(env, 'SCENEBOOK_GATEWAY_MAX_MEMBER_BYTES', 512 * 1024 * 1024),
    maxCacheBytes: integer(env, 'SCENEBOOK_GATEWAY_MAX_CACHE_BYTES', 512 * 1024 * 1024),
    maxConcurrentResponses: integer(env, 'SCENEBOOK_GATEWAY_MAX_RESPONSES', 4),
    temporaryRoot: env.SCENEBOOK_GATEWAY_TEMPORARY_ROOT ?? '/tmp/scenebook-publication-gateway',
    objectStore,
    logLevel: env.SCENEBOOK_LOG_LEVEL,
  });
}

export type PublicationGatewayConfig = z.infer<typeof PublicationGatewayConfigSchema>;
