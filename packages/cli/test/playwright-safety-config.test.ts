import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import { createJiti } from 'jiti';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectSchema, SCHEMA_VERSION, ScenebookConfigSchema } from '@scenebook/schema';

import { createPlaywrightSafetyConfig } from '../src/playwright-target.js';
import type { LoadedConfig } from '../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string): Promise<LoadedConfig> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-playwright-wrapper-'));
  roots.push(root);
  const path = join(root, 'scenebook.config.yaml');
  const playwrightPath = join(root, 'playwright.config.ts');
  await writeFile(path, 'fixture');
  await writeFile(playwrightPath, source);
  const project = ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'wrapper-project',
    name: 'Wrapper project',
    slug: 'wrapper-project',
  });
  return {
    path,
    directory: root,
    project,
    config: ScenebookConfigSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      project,
      playwright: { config: 'playwright.config.ts' },
    }),
  };
}

async function importWrapper(
  config: LoadedConfig,
  baseUrl: string,
  environmentKind: string,
): Promise<unknown> {
  const safety = await createPlaywrightSafetyConfig(config);
  const previousUrl = process.env.SCENEBOOK_BASE_URL;
  const previousKind = process.env.SCENEBOOK_ENVIRONMENT_KIND;
  process.env.SCENEBOOK_BASE_URL = baseUrl;
  process.env.SCENEBOOK_ENVIRONMENT_KIND = environmentKind;
  try {
    const jiti = createJiti(pathToFileURL(safety.path).href, { interopDefault: true });
    return await jiti.import(safety.path, { default: true });
  } finally {
    if (previousUrl === undefined) delete process.env.SCENEBOOK_BASE_URL;
    else process.env.SCENEBOOK_BASE_URL = previousUrl;
    if (previousKind === undefined) delete process.env.SCENEBOOK_ENVIRONMENT_KIND;
    else process.env.SCENEBOOK_ENVIRONMENT_KIND = previousKind;
    await safety.cleanup();
  }
}

describe('generated Playwright safety config', () => {
  it('rejects global and project baseURL disagreement', async () => {
    await expect(
      importWrapper(
        await fixture(`export default { use: { baseURL: 'https://wrong.example.test' } };`),
        'https://selected.example.test/',
        'custom',
      ),
    ).rejects.toThrow('disagrees with selected Scenebook Environment');
    await expect(
      importWrapper(
        await fixture(
          `export default { projects: [{ name: 'wrong', use: { baseURL: 'https://wrong.example.test' } }] };`,
        ),
        'https://selected.example.test/',
        'custom',
      ),
    ).rejects.toThrow('Playwright project wrong baseURL');
  });

  it('forces a matching canonical URL and rejects local web servers for remote targets', async () => {
    const configured = (await importWrapper(
      await fixture(
        `export default { use: { baseURL: 'http://127.0.0.1:4174' }, projects: [{ name: 'chromium' }] };`,
      ),
      'http://127.0.0.1:4174/',
      'local',
    )) as {
      use: { baseURL: string; screenshot: string; trace: string };
      projects: Array<{ use: { baseURL: string; screenshot: string; trace: string } }>;
    };
    expect(configured.use.baseURL).toBe('http://127.0.0.1:4174/');
    expect(configured.use).toMatchObject({ screenshot: 'on', trace: 'retain-on-failure' });
    expect(configured.projects[0]?.use.baseURL).toBe('http://127.0.0.1:4174/');
    expect(configured.projects[0]?.use).toMatchObject({
      screenshot: 'on',
      trace: 'retain-on-failure',
    });

    await expect(
      importWrapper(
        await fixture(
          `export default { use: { baseURL: 'https://selected.example.test' }, webServer: { command: 'start-local', url: 'https://selected.example.test' } };`,
        ),
        'https://selected.example.test/',
        'custom',
      ),
    ).rejects.toThrow('non-local Scenebook Environment cannot start');
  });
});
