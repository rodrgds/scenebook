import {
  createJsonLogger,
  FileSystemObjectStore,
  IdentityTokenVerifier,
  PostgresControlPlaneRepository,
  S3ObjectStore,
  type ImmutableObjectStore,
} from '@scenebook/server';

import { createPublicationGatewayApp } from './app.js';
import { HttpPublicationBootstrapClient } from './bootstrap.js';
import { loadPublicationGatewayConfig, type PublicationGatewayConfig } from './config.js';
import { PortalSessionService } from './session.js';

export async function createPublicationGatewayRuntime(
  config: PublicationGatewayConfig = loadPublicationGatewayConfig(),
) {
  const logger = createJsonLogger(config.logLevel);
  const repository = new PostgresControlPlaneRepository(config.databaseUrl);
  let objectStore: ImmutableObjectStore;
  if (config.objectStore.kind === 'filesystem') {
    objectStore = new FileSystemObjectStore(config.objectStore.root);
  } else {
    objectStore = new S3ObjectStore({
      bucket: config.objectStore.bucket,
      region: config.objectStore.region,
      ...(config.objectStore.endpoint ? { endpoint: config.objectStore.endpoint } : {}),
      ...(config.objectStore.accessKeyId ? { accessKeyId: config.objectStore.accessKeyId } : {}),
      ...(config.objectStore.secretAccessKey
        ? { secretAccessKey: config.objectStore.secretAccessKey }
        : {}),
      forcePathStyle: config.objectStore.forcePathStyle,
    });
  }
  const app = createPublicationGatewayApp({
    repository,
    objectStore,
    identityVerifier: new IdentityTokenVerifier({
      activeVerificationPublicKey: config.identityVerificationPublicKey,
      previousVerificationPublicKeys: config.identityPreviousVerificationPublicKeys,
    }),
    portalSessions: new PortalSessionService(config.sessionSecret),
    bootstrapClient: new HttpPublicationBootstrapClient(
      config.controlPlaneInternalBaseUrl,
      config.bootstrapExchangeSecret,
      config.bootstrapTimeoutMs,
    ),
    config,
  });
  return {
    app,
    config,
    logger,
    repository,
    objectStore,
    async close(): Promise<void> {
      await repository.close();
    },
  };
}

export type PublicationGatewayRuntime = Awaited<ReturnType<typeof createPublicationGatewayRuntime>>;
