import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { loadServerConfig } from '../src/config.js';
import { runMigrations } from '../src/migrations.js';

const roots: string[] = [];
const identityKeyPair = generateKeyPairSync('ed25519');
const IDENTITY_PRIVATE_KEY = identityKeyPair.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64');
const IDENTITY_PUBLIC_KEY = identityKeyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
const previousIdentityKeyPair = generateKeyPairSync('ed25519');
const PREVIOUS_IDENTITY_PUBLIC_KEY = previousIdentityKeyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    SCENEBOOK_PUBLIC_URL: 'https://scenebook.example.com',
    SCENEBOOK_PUBLICATION_URL: 'https://publish.scenebook.example.com',
    DATABASE_URL: 'postgresql://scenebook@example/scenebook',
    SCENEBOOK_ADMIN_TOKEN: 'a'.repeat(64),
    SCENEBOOK_UPLOAD_TOKEN_SECRET: 'b'.repeat(64),
    SCENEBOOK_IDENTITY_TOKEN_SECRET: 'd'.repeat(64),
    SCENEBOOK_IDENTITY_SIGNING_PRIVATE_KEY: IDENTITY_PRIVATE_KEY,
    SCENEBOOK_IDENTITY_VERIFICATION_PUBLIC_KEY: IDENTITY_PUBLIC_KEY,
    SCENEBOOK_GATEWAY_EXCHANGE_SECRET: 'x'.repeat(64),
    SCENEBOOK_RUNNER_TOKEN_SECRET: 'e'.repeat(64),
    SCENEBOOK_ANALYTICS_HASH_SECRET: 'c'.repeat(64),
    SCENEBOOK_CTA_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64url'),
    ...overrides,
  };
}

describe('server configuration', () => {
  it('requires HTTPS for the production public origin', () => {
    expect(() =>
      loadServerConfig(environment({ SCENEBOOK_PUBLIC_URL: 'http://example.com' })),
    ).toThrow('Production public URL must use HTTPS');
    expect(loadServerConfig(environment()).publicBaseUrl).toBe('https://scenebook.example.com');
    expect(loadServerConfig(environment()).publicationBaseUrl).toBe(
      'https://publish.scenebook.example.com',
    );
    expect(() =>
      loadServerConfig(environment({ SCENEBOOK_PUBLICATION_URL: 'https://scenebook.example.com' })),
    ).toThrow('distinct origins');
  });

  it('requires independent service secrets and loads bounded identity lifetimes', () => {
    expect(() =>
      loadServerConfig(environment({ SCENEBOOK_IDENTITY_TOKEN_SECRET: 'b'.repeat(64) })),
    ).toThrow('must use independent secrets');
    expect(() =>
      loadServerConfig(environment({ SCENEBOOK_RUNNER_TOKEN_SECRET: 'b'.repeat(64) })),
    ).toThrow('must use independent secrets');
    expect(() =>
      loadServerConfig(environment({ SCENEBOOK_ANALYTICS_HASH_SECRET: 'e'.repeat(64) })),
    ).toThrow('must use independent secrets');
    const config = loadServerConfig(
      environment({
        SCENEBOOK_SESSION_TTL_SECONDS: '3600',
        SCENEBOOK_API_TOKEN_MAX_TTL_SECONDS: '86400',
        SCENEBOOK_SHARE_LINK_MAX_TTL_SECONDS: '7200',
      }),
    );
    expect(config.identity).toEqual({
      sessionTtlSeconds: 3600,
      apiTokenMaxTtlSeconds: 86400,
      shareLinkMaxTtlSeconds: 7200,
    });
    expect(config.publicationLogin).toEqual({
      exchangeSecret: 'x'.repeat(64),
      handoffTtlSeconds: 60,
    });
    expect(config.identityPreviousVerificationPublicKeys).toEqual([]);
    expect(
      loadServerConfig(
        environment({
          SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON: JSON.stringify([
            PREVIOUS_IDENTITY_PUBLIC_KEY,
          ]),
        }),
      ).identityPreviousVerificationPublicKeys,
    ).toEqual([PREVIOUS_IDENTITY_PUBLIC_KEY]);
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON: JSON.stringify([
            IDENTITY_PUBLIC_KEY,
          ]),
        }),
      ),
    ).toThrow('unique derived key IDs');
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON: JSON.stringify([
            'not-a-valid-public-key'.padEnd(64, 'x'),
          ]),
        }),
      ),
    ).toThrow('base64-encoded SPKI');
  });

  it('loads bounded scheduler coordination settings', () => {
    const config = loadServerConfig(
      environment({
        SCENEBOOK_SCHEDULER_INTERVAL_MS: '3000',
        SCENEBOOK_SCHEDULER_BATCH_SIZE: '25',
        SCENEBOOK_RUNNER_LEASE_SECONDS: '90',
      }),
    );
    expect(config.scheduling).toEqual({
      workerIntervalMs: 3000,
      workerBatchSize: 25,
      runnerLeaseSeconds: 90,
    });
    expect(() => loadServerConfig(environment({ SCENEBOOK_RUNNER_LEASE_SECONDS: '10' }))).toThrow();
  });

  it('rejects unknown object-store modes and partial static S3 credentials', () => {
    expect(() => loadServerConfig(environment({ SCENEBOOK_OBJECT_STORE: 'typo' }))).toThrow(
      'must be filesystem or s3',
    );
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_OBJECT_STORE: 's3',
          SCENEBOOK_S3_BUCKET: 'scenebook',
          SCENEBOOK_S3_ACCESS_KEY_ID: 'access-only',
        }),
      ),
    ).toThrow('configured together');
  });

  it('keeps final evidence deletion disabled by default and requires an independent capability', () => {
    expect(loadServerConfig(environment()).evidenceRetention).toMatchObject({
      enabled: false,
      deleteCredential: { kind: 'disabled' },
      diagnosticGraceSeconds: 604_800,
      standardGraceSeconds: 7_776_000,
    });
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_OBJECT_STORE: 's3',
          SCENEBOOK_S3_BUCKET: 'scenebook',
          SCENEBOOK_S3_ACCESS_KEY_ID: 'ordinary',
          SCENEBOOK_S3_SECRET_ACCESS_KEY: 'ordinary-secret',
          SCENEBOOK_EVIDENCE_RETENTION_ENABLED: 'true',
          SCENEBOOK_S3_FINAL_DELETE_ACCESS_KEY_ID: 'ordinary',
          SCENEBOOK_S3_FINAL_DELETE_SECRET_ACCESS_KEY: 'delete-secret',
        }),
      ),
    ).toThrow('must be distinct');
    const configured = loadServerConfig(
      environment({
        SCENEBOOK_OBJECT_STORE: 's3',
        SCENEBOOK_S3_BUCKET: 'scenebook',
        SCENEBOOK_S3_ACCESS_KEY_ID: 'ordinary',
        SCENEBOOK_S3_SECRET_ACCESS_KEY: 'ordinary-secret',
        SCENEBOOK_EVIDENCE_RETENTION_ENABLED: 'true',
        SCENEBOOK_S3_FINAL_DELETE_ACCESS_KEY_ID: 'delete-only',
        SCENEBOOK_S3_FINAL_DELETE_SECRET_ACCESS_KEY: 'delete-secret',
        SCENEBOOK_EVIDENCE_DIAGNOSTIC_RETENTION_GRACE_SECONDS: '86400',
        SCENEBOOK_EVIDENCE_STANDARD_RETENTION_GRACE_SECONDS: '604800',
      }),
    );
    expect(configured.evidenceRetention).toMatchObject({
      enabled: true,
      diagnosticGraceSeconds: 86_400,
      standardGraceSeconds: 604_800,
      deleteCredential: { kind: 's3', accessKeyId: 'delete-only' },
    });
  });

  it('keeps custom domains disabled by default and requires an all-or-none provider contract', () => {
    expect(loadServerConfig(environment()).customDomains).toEqual({ kind: 'disabled' });
    expect(() =>
      loadServerConfig(
        environment({ SCENEBOOK_CUSTOM_DOMAIN_ROUTING_TARGET: 'customers.scenebook.cloud' }),
      ),
    ).toThrow('SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_URL');

    const config = loadServerConfig(
      environment({
        SCENEBOOK_CUSTOM_DOMAIN_ROUTING_TARGET: 'Customers.Scenebook.Cloud.',
        SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_URL: 'https://provisioner.acme.com/reconcile',
        SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_SECRET: 'f'.repeat(64),
        SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_TIMEOUT_MS: '5000',
      }),
    );
    expect(config.customDomains).toEqual({
      kind: 'http',
      routingTarget: 'customers.scenebook.cloud',
      provisionerUrl: 'https://provisioner.acme.com/reconcile',
      provisionerSecret: 'f'.repeat(64),
      timeoutMs: 5_000,
    });
  });

  it('rejects insecure production custom-domain provider configuration', () => {
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_CUSTOM_DOMAIN_ROUTING_TARGET: 'customers.scenebook.cloud',
          SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_URL: 'http://provisioner.acme.com/reconcile',
          SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_SECRET: 'f'.repeat(64),
        }),
      ),
    ).toThrow('must use HTTPS');
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_CUSTOM_DOMAIN_ROUTING_TARGET: 'scenebook.example.com',
          SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_URL: 'https://provisioner.acme.com/reconcile',
          SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_SECRET: 'f'.repeat(64),
        }),
      ),
    ).toThrow('must not be the control-plane origin');
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_CUSTOM_DOMAIN_ROUTING_TARGET: 'customers.scenebook.cloud',
          SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_URL: 'https://provisioner.acme.com/reconcile',
          SCENEBOOK_CUSTOM_DOMAIN_PROVISIONER_SECRET: 'e'.repeat(64),
        }),
      ),
    ).toThrow('must use independent secrets');
  });

  it('loads aggregate rate, upload quota, concurrency, and garbage-collection limits', () => {
    const config = loadServerConfig(
      environment({
        SCENEBOOK_RATE_WINDOW_MS: '2000',
        SCENEBOOK_RATE_REQUESTS: '40',
        SCENEBOOK_RATE_AGGREGATE_REQUESTS: '90',
        SCENEBOOK_MAX_OBJECT_BYTES: '2048',
        SCENEBOOK_MAX_UPLOAD_OBJECTS: '12',
        SCENEBOOK_MAX_UPLOAD_BYTES: '8192',
        SCENEBOOK_MAX_ACTIVE_UPLOADS_TENANT: '3',
        SCENEBOOK_MAX_ACTIVE_UPLOADS_GLOBAL: '9',
        SCENEBOOK_MAX_ACTIVE_UPLOAD_BYTES_TENANT: '4096',
        SCENEBOOK_MAX_ACTIVE_UPLOAD_BYTES_GLOBAL: '16384',
        SCENEBOOK_MAX_CONCURRENT_UPLOADS_TENANT: '2',
        SCENEBOOK_MAX_CONCURRENT_UPLOADS_GLOBAL: '6',
        SCENEBOOK_MAX_CONCURRENT_UPLOAD_BYTES_TENANT: '2048',
        SCENEBOOK_MAX_CONCURRENT_UPLOAD_BYTES_GLOBAL: '12288',
        SCENEBOOK_UPLOAD_GC_INTERVAL_MS: '5000',
        SCENEBOOK_UPLOAD_GC_BATCH_SIZE: '25',
        SCENEBOOK_UPLOAD_GC_CLAIM_TTL_SECONDS: '45',
      }),
    );

    expect(config.rateLimit).toEqual({
      windowMs: 2000,
      requests: 40,
      aggregateRequests: 90,
    });
    expect(config.maxObjectBytes).toBe(2048);
    expect(config.uploadLimits).toEqual({
      maxObjectsPerUpload: 12,
      maxBytesPerUpload: 8192,
      maxActiveUploadsPerTenant: 3,
      maxActiveUploadsGlobal: 9,
      maxActiveBytesPerTenant: 4096,
      maxActiveBytesGlobal: 16384,
      maxConcurrentObjectsPerTenant: 2,
      maxConcurrentObjectsGlobal: 6,
      maxConcurrentBytesPerTenant: 2048,
      maxConcurrentBytesGlobal: 12288,
      gcIntervalMs: 5000,
      gcBatchSize: 25,
      gcClaimTtlSeconds: 45,
    });
  });

  it('rejects tenant resource ceilings above their global ceilings', () => {
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_MAX_ACTIVE_UPLOADS_TENANT: '10',
          SCENEBOOK_MAX_ACTIVE_UPLOADS_GLOBAL: '9',
        }),
      ),
    ).toThrow('Tenant active-upload limit cannot exceed the global limit');
    expect(() =>
      loadServerConfig(
        environment({
          SCENEBOOK_MAX_CONCURRENT_UPLOAD_BYTES_TENANT: '8192',
          SCENEBOOK_MAX_CONCURRENT_UPLOAD_BYTES_GLOBAL: '4096',
        }),
      ),
    ).toThrow('Tenant concurrent-byte limit cannot exceed the global limit');
  });
});

describe('checksummed migrations', () => {
  it('applies each migration once and rejects edited migration history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-migrations-'));
    roots.push(directory);
    const migration = join(directory, '0001_test.sql');
    await writeFile(migration, 'SELECT 1;\n');
    const applied = new Map<string, string>();
    const client = {
      async query(sql: string, parameters: readonly unknown[] = []) {
        if (sql.startsWith('SELECT checksum FROM schema_migrations')) {
          const checksum = applied.get(String(parameters[0]));
          return { rows: checksum ? [{ checksum }] : [], rowCount: checksum ? 1 : 0 };
        }
        if (sql.startsWith('INSERT INTO schema_migrations')) {
          applied.set(String(parameters[0]), String(parameters[1]));
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    expect(await runMigrations(pool, directory)).toHaveLength(1);
    expect(await runMigrations(pool, directory)).toEqual([]);
    await writeFile(migration, 'SELECT 2;\n');
    await expect(runMigrations(pool, directory)).rejects.toThrow(
      'Migration checksum changed after application',
    );
  });

  it('ships database-level append-only and immutable Release guards', async () => {
    const sql = await readFile(
      new URL('../migrations/0001_control_plane.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain('audit_events_append_only');
    expect(sql).toContain('scene_revisions_append_only');
    expect(sql).toContain('release_content_immutable');
    expect(sql).toContain('oidc_token_uses_expiry_idx');
    const evidenceSql = await readFile(
      new URL('../migrations/0002_release_evidence.sql', import.meta.url),
      'utf8',
    );
    expect(evidenceSql).toContain('verification_runs_append_only');
    expect(evidenceSql).toContain('verification_builds_append_only');
    expect(evidenceSql).toContain('verification_baselines_append_only');
    expect(evidenceSql).toContain('review_approvals_append_only');
    expect(evidenceSql).toContain('release_evidence_immutable');
  });

  it('ships bounded, claim-safe abandoned-upload garbage collection state', async () => {
    const uploadSql = await readFile(
      new URL('../migrations/0003_upload_gc.sql', import.meta.url),
      'utf8',
    );
    expect(uploadSql).toContain('gc_claim_id');
    expect(uploadSql).toContain('gc_claimed_until');
    expect(uploadSql).toContain('gc_completed_at');
    expect(uploadSql).toContain('artifact_uploads_active_quota_idx');
    expect(uploadSql).toContain('artifact_uploads_gc_claim_idx');

    const repositorySource = await readFile(new URL('../src/postgres.ts', import.meta.url), 'utf8');
    expect(repositorySource).toContain('FOR UPDATE SKIP LOCKED');
    expect(repositorySource).toContain("status <> 'finalized'");
  });

  it('migrates legacy Review states to the exact artifact-schema vocabulary', async () => {
    const reviewSql = await readFile(
      new URL('../migrations/0004_review_change_state.sql', import.meta.url),
      'utf8',
    );
    expect(reviewSql).toContain("change_state = 'passed'");
    expect(reviewSql).toContain("change_state = 'blocked'");
    expect(reviewSql).toContain(
      "CHECK (change_state IN ('passed', 'changed', 'broken', 'blocked'))",
    );
    expect(reviewSql).toContain("'{changeState}'");
  });

  it('indexes finalized manifests by exact repository revision provenance', async () => {
    const uploadSql = await readFile(
      new URL('../migrations/0005_upload_provenance_lookup.sql', import.meta.url),
      'utf8',
    );
    expect(uploadSql).toContain('artifact_uploads_finalized_provenance_idx');
    expect(uploadSql).toContain('lower(repository)');
    expect(uploadSql).toContain('commit_sha');
    expect(uploadSql).toContain('manifest_hash');
    expect(uploadSql).toContain("WHERE status = 'finalized'");
  });

  it('migrates upload objects to a composite digest and media identity', async () => {
    const objectSql = await readFile(
      new URL('../migrations/0006_artifact_object_media_identity.sql', import.meta.url),
      'utf8',
    );
    expect(objectSql).toContain('DROP CONSTRAINT artifact_objects_pkey');
    expect(objectSql).toContain('PRIMARY KEY (upload_id, sha256, media_type)');
  });

  it('ships revocable tenant-scoped identity and private-portal authorization state', async () => {
    const identitySql = await readFile(
      new URL('../migrations/0007_identity_private_portal.sql', import.meta.url),
      'utf8',
    );
    expect(identitySql).toContain('workspace_memberships');
    expect(identitySql).toContain('identity_api_tokens');
    expect(identitySql).toContain('user_sessions');
    expect(identitySql).toContain(
      'source_token_id text NOT NULL REFERENCES identity_api_tokens(id)',
    );
    expect(identitySql).toContain('portal_grants');
    expect(identitySql).toContain('private_share_links');
    expect(identitySql).toContain('channels_workspace_project_id_unique');
    expect(identitySql).toContain('revoked_at IS NULL');
  });

  it('ships durable, lease-safe external-runner scheduling state and guards', async () => {
    const scheduleSql = await readFile(
      new URL('../migrations/0008_verification_schedules.sql', import.meta.url),
      'utf8',
    );
    expect(scheduleSql).toContain('verification_schedules_due_idx');
    expect(scheduleSql).toContain('verification_jobs_claim_idx');
    expect(scheduleSql).toContain('verification_jobs_expired_lease_idx');
    expect(scheduleSql).toContain('verification_runner_schedules');
    expect(scheduleSql).toContain('verification_jobs_state_guard');
    expect(scheduleSql).toContain('terminal verification jobs are immutable');
    expect(scheduleSql).toContain("'schedule:read'");
    expect(scheduleSql).toContain("'runner:admin'");

    const repositorySource = await readFile(new URL('../src/postgres.ts', import.meta.url), 'utf8');
    expect(repositorySource).toContain('FOR UPDATE OF s SKIP LOCKED');
    expect(repositorySource).toContain('FOR UPDATE OF j SKIP LOCKED');
    expect(repositorySource).toContain('expectedBuildId');
  });

  it('ships tenant-safe custom-domain uniqueness and explicit lifecycle state', async () => {
    const domainSql = await readFile(
      new URL('../migrations/0009_custom_domains.sql', import.meta.url),
      'utf8',
    );
    expect(domainSql).toContain('custom_domains_live_hostname_unique');
    expect(domainSql).toContain('custom_domains_live_channel_unique');
    expect(domainSql).toContain("WHERE status NOT IN ('pending-dns', 'removed')");
    expect(domainSql).toContain("status IN ('provisioning', 'disabling', 'removing', 'failed')");
    expect(domainSql).toContain('dns_verified_at IS NOT NULL');
  });

  it('stores only one-time publication login digests with atomic consumption state', async () => {
    const loginSql = await readFile(
      new URL('../migrations/0012_publication_login_handoffs.sql', import.meta.url),
      'utf8',
    );
    expect(loginSql).toContain('token_hash text NOT NULL UNIQUE');
    expect(loginSql).toContain('source_session_id text NOT NULL REFERENCES user_sessions(id)');
    expect(loginSql).toContain('grant_id text NOT NULL REFERENCES portal_grants(id)');
    expect(loginSql).toContain('audience_origin text NOT NULL');
    expect(loginSql).toContain('return_path text NOT NULL');
    expect(loginSql).toContain('consumed_at timestamptz');
    expect(loginSql).not.toContain('credential text');
  });

  it('persists stable CTA identity and backfills deprecated single-CTA submissions', async () => {
    const ctaSql = await readFile(
      new URL('../migrations/0013_cta_submission_identity.sql', import.meta.url),
      'utf8',
    );
    expect(ctaSql).toContain('ADD COLUMN IF NOT EXISTS cta_id text');
    expect(ctaSql).toContain("left(step_id, 124) || '-cta'");
    expect(ctaSql).toContain('ALTER COLUMN cta_id SET NOT NULL');
    expect(ctaSql).toContain('cta_submissions_cta_id_guard');
    expect(ctaSql).toContain('cta_submissions_subject_cta_idx');
  });

  it('separates hosted Studio drafts from immutable Scene and evidence truth', async () => {
    const studioSql = await readFile(
      new URL('../migrations/0014_hosted_studio.sql', import.meta.url),
      'utf8',
    );
    expect(studioSql).toContain('studio_scene_documents');
    expect(studioSql).toContain('studio_scene_versions');
    expect(studioSql).toContain('studio_project_documents');
    expect(studioSql).toContain('document_json jsonb NOT NULL');
    expect(studioSql).toContain('ON DELETE CASCADE');
  });
});
