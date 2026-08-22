import { createControlPlaneApp } from './app.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { HmacHasher, SecretBox, UploadTokenService } from './crypto.js';
import { IdentityTokenService } from './auth.js';
import { createJsonLogger } from './logger.js';
import { runMigrations } from './migrations.js';
import { MetricsRegistry } from './metrics.js';
import {
  FileSystemFinalObjectDeleter,
  FileSystemObjectStore,
  S3FinalObjectDeleter,
  S3ObjectStore,
  type FinalObjectDeleter,
  type S3ObjectStoreOptions,
  type ImmutableObjectStore,
} from './object-store.js';
import { RemoteGitHubOidcVerifier } from './oidc.js';
import { PostgresControlPlaneRepository } from './postgres.js';
import { validateWebhookUrl, WebhookDispatcher } from './webhook.js';
import { WebhookWorker } from './webhook-worker.js';
import { UploadGarbageCollector } from './upload-gc.js';
import { RunnerTokenService } from './runner-token.js';
import { VerificationScheduleWorker } from './schedule-worker.js';
import { HttpCustomDomainProvisioner, NodeCustomDomainDnsResolver } from './custom-domains.js';
import { EvidenceRetentionWorker } from './evidence-retention.js';
import { DisabledGitHubSourceClient, RemoteGitHubAppSourceClient } from './github-app.js';

export async function createControlPlaneRuntime(config: ServerConfig = loadServerConfig()) {
  const logger = createJsonLogger(config.logLevel);
  const repository = new PostgresControlPlaneRepository(config.databaseUrl);
  if (config.autoMigrate) await runMigrations(repository.pool);

  let objectStore: ImmutableObjectStore;
  if (config.objectStore.kind === 'filesystem') {
    objectStore = new FileSystemObjectStore(config.objectStore.root);
  } else {
    const s3Options: S3ObjectStoreOptions = {
      bucket: config.objectStore.bucket,
      region: config.objectStore.region,
      forcePathStyle: config.objectStore.forcePathStyle,
    };
    if (config.objectStore.endpoint) s3Options.endpoint = config.objectStore.endpoint;
    if (config.objectStore.accessKeyId) {
      s3Options.accessKeyId = config.objectStore.accessKeyId;
    }
    if (config.objectStore.secretAccessKey) {
      s3Options.secretAccessKey = config.objectStore.secretAccessKey;
    }
    objectStore = new S3ObjectStore(s3Options);
  }
  let finalDeleter: FinalObjectDeleter | undefined;
  if (config.evidenceRetention.enabled) {
    if (
      config.objectStore.kind === 'filesystem' &&
      config.evidenceRetention.deleteCredential.kind === 'filesystem'
    ) {
      finalDeleter = new FileSystemFinalObjectDeleter(config.objectStore.root);
    } else if (
      config.objectStore.kind === 's3' &&
      config.evidenceRetention.deleteCredential.kind === 's3'
    ) {
      finalDeleter = new S3FinalObjectDeleter({
        bucket: config.objectStore.bucket,
        region: config.objectStore.region,
        endpoint: config.objectStore.endpoint,
        accessKeyId: config.evidenceRetention.deleteCredential.accessKeyId,
        secretAccessKey: config.evidenceRetention.deleteCredential.secretAccessKey,
        forcePathStyle: config.objectStore.forcePathStyle,
      });
    }
    if (!finalDeleter) throw new Error('Evidence retention delete capability is inconsistent');
  }

  for (const webhook of config.webhooks) {
    await validateWebhookUrl(webhook.url, { allowHttp: config.allowHttpWebhooks });
  }
  const dispatcher = new WebhookDispatcher(config.webhooks, config.allowHttpWebhooks);
  const secretBox = new SecretBox(config.ctaEncryptionKey);
  const metrics = new MetricsRegistry();
  const customDomains =
    config.customDomains.kind === 'http'
      ? {
          enabled: true,
          routingTarget: config.customDomains.routingTarget,
          dnsResolver: new NodeCustomDomainDnsResolver(),
          provisioner: new HttpCustomDomainProvisioner({
            url: config.customDomains.provisionerUrl,
            secret: config.customDomains.provisionerSecret,
            timeoutMs: config.customDomains.timeoutMs,
          }),
        }
      : { enabled: false };
  const evidenceRetention = finalDeleter
    ? new EvidenceRetentionWorker({
        repository,
        finalDeleter,
        metrics,
        logger,
        intervalMs: config.evidenceRetention.workerIntervalMs,
        batchSize: config.evidenceRetention.batchSize,
        claimTtlSeconds: config.evidenceRetention.claimTtlSeconds,
        standardGraceSeconds: config.evidenceRetention.standardGraceSeconds,
        diagnosticGraceSeconds: config.evidenceRetention.diagnosticGraceSeconds,
      })
    : undefined;
  const githubSource =
    config.githubApp.kind === 'enabled'
      ? new RemoteGitHubAppSourceClient({
          appId: config.githubApp.appId,
          privateKeyPem: config.githubApp.privateKeyPem,
          apiBaseUrl: config.githubApp.apiBaseUrl,
          timeoutMs: config.githubApp.timeoutMs,
        })
      : new DisabledGitHubSourceClient();
  const appOptions: Parameters<typeof createControlPlaneApp>[0] = {
    repository,
    objectStore,
    oidcVerifier: new RemoteGitHubOidcVerifier(
      config.github.jwksUrl,
      config.github.issuer,
      config.github.audience,
    ),
    uploadTokens: new UploadTokenService(config.uploadTokenSecret),
    identityTokens: new IdentityTokenService({
      apiTokenHashSecret: config.identityTokenSecret,
      signingPrivateKey: config.identitySigningPrivateKey,
      verificationPublicKey: config.identityVerificationPublicKey,
      previousVerificationPublicKeys: config.identityPreviousVerificationPublicKeys,
    }),
    runnerTokens: new RunnerTokenService(config.runnerTokenSecret),
    hasher: new HmacHasher(config.analyticsHashSecret),
    secretBox,
    webhooks: dispatcher,
    logger,
    metrics,
    adminToken: config.adminToken,
    publicBaseUrl: config.publicBaseUrl,
    publicationBaseUrl: config.publicationBaseUrl,
    maxJsonBytes: config.maxJsonBytes,
    maxObjectBytes: config.maxObjectBytes,
    uploadLimits: config.uploadLimits,
    uploadTokenTtlSeconds: config.github.uploadTokenTtlSeconds,
    identity: config.identity,
    publicationLogin: config.publicationLogin,
    runnerLeaseSeconds: config.scheduling.runnerLeaseSeconds,
    rateLimit: config.rateLimit,
    customDomains,
    githubSource,
    githubChangeLeaseSeconds:
      config.githubApp.kind === 'enabled' ? config.githubApp.changeLeaseSeconds : 120,
    githubCheckReconcileTimeoutMs:
      config.githubApp.kind === 'enabled'
        ? Math.min(60_000, config.githubApp.timeoutMs * 4)
        : 60_000,
    workspaceExport: config.workspaceExport,
  };
  if (evidenceRetention) appOptions.evidenceRetention = evidenceRetention;
  const app = createControlPlaneApp(appOptions);
  const webhookWorker = new WebhookWorker({ repository, dispatcher, secretBox, logger });
  const uploadGarbageCollector = new UploadGarbageCollector({
    repository,
    objectStore,
    metrics,
    logger,
    intervalMs: config.uploadLimits.gcIntervalMs,
    batchSize: config.uploadLimits.gcBatchSize,
    claimTtlSeconds: config.uploadLimits.gcClaimTtlSeconds,
  });
  const verificationScheduleWorker = new VerificationScheduleWorker({
    repository,
    logger,
    metrics,
    intervalMs: config.scheduling.workerIntervalMs,
    batchSize: config.scheduling.workerBatchSize,
  });

  return {
    app,
    config,
    logger,
    repository,
    objectStore,
    metrics,
    webhookWorker,
    uploadGarbageCollector,
    verificationScheduleWorker,
    evidenceRetention,
    async close(): Promise<void> {
      webhookWorker.stop();
      uploadGarbageCollector.stop();
      verificationScheduleWorker.stop();
      await evidenceRetention?.stop();
      await repository.close();
    },
  };
}

export type ControlPlaneRuntime = Awaited<ReturnType<typeof createControlPlaneRuntime>>;
