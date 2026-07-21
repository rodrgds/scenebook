import { serve } from '@hono/node-server';
import { createControlPlaneRuntime } from '@scenebook/server';

const runtime = await createControlPlaneRuntime();
runtime.webhookWorker.start();
runtime.uploadGarbageCollector.start();
runtime.evidenceRetention?.start();
runtime.verificationScheduleWorker.start();

const server = serve(
  {
    fetch: runtime.app.fetch,
    hostname: runtime.config.host,
    port: runtime.config.port,
  },
  (info) =>
    runtime.logger.info('Scenebook control plane listening', {
      address: info.address,
      port: info.port,
    }),
);

let closing = false;
const CLOSE_DEADLINE_MS = 30_000;

function forceCloseConnections(): void {
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
}

function closeIdleConnections(): void {
  (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    const deadline = setTimeout(() => {
      runtime.logger.warn('Forcing remaining HTTP connections closed at shutdown deadline');
      forceCloseConnections();
      finish();
    }, CLOSE_DEADLINE_MS);
    deadline.unref();
    server.close((error) => finish(error));
    closeIdleConnections();
  });
}

const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  runtime.logger.info('Shutting down Scenebook control plane', { signal });
  runtime.webhookWorker.stop();
  runtime.uploadGarbageCollector.stop();
  const retentionStop = runtime.evidenceRetention?.stop();
  runtime.verificationScheduleWorker.stop();
  try {
    await Promise.all([closeHttpServer(), retentionStop]);
    await runtime.close();
    runtime.logger.info('Scenebook control plane shutdown complete', { signal });
  } catch (error) {
    forceCloseConnections();
    await runtime.close().catch(() => undefined);
    runtime.logger.error('Scenebook control plane shutdown failed', {
      signal,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
    process.exitCode = 1;
  }
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
