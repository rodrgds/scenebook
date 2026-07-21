import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.SCENEBOOK_BASE_URL ?? 'http://127.0.0.1:4174';
const localExecution = (process.env.SCENEBOOK_ENVIRONMENT_KIND ?? 'local') === 'local';

export default defineConfig({
  testDir: './scenes',
  testMatch: '**/automation/replay.ts',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['@scenebook/playwright/reporter', { outputDirectory: '.scenebook/runs' }]],
  use: {
    baseURL,
    colorScheme: 'light',
    locale: 'en-US',
    contextOptions: { reducedMotion: 'reduce' },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  ...(localExecution
    ? {
        webServer: {
          command: 'bun run --cwd ../../apps/example dev',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
        },
      }
    : {}),
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
