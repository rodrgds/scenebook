import { serve } from '@hono/node-server';
import { createPublicationGatewayRuntime } from '@scenebook/gateway';

const runtime = await createPublicationGatewayRuntime();
const server = serve(
  {
    fetch: runtime.app.fetch,
    hostname: runtime.config.host,
    port: runtime.config.port,
  },
  (info) =>
    runtime.logger.info('Scenebook publication gateway listening', {
      address: info.address,
      port: info.port,
    }),
);

let closing = false;
const close = (signal: string): void => {
  if (closing) return;
  closing = true;
  runtime.logger.info('Shutting down Scenebook publication gateway', { signal });
  server.close(async (error) => {
    await runtime.close().catch(() => undefined);
    if (error) {
      runtime.logger.error('Publication gateway shutdown failed', {
        signal,
        error: { name: error.name, message: error.message },
      });
      process.exitCode = 1;
    }
  });
  (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  const deadline = setTimeout(() => {
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  }, 30_000);
  deadline.unref();
};

process.once('SIGTERM', () => close('SIGTERM'));
process.once('SIGINT', () => close('SIGINT'));
