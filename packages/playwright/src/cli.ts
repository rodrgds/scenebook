import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Resolve the Playwright CLI owned by this package. Callers can launch it directly with
 * `process.execPath`, avoiding package-manager downloads and project-local executable spoofing.
 */
export function playwrightCliPath(): string {
  return require.resolve('@playwright/test/cli');
}
