import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSceneYaml } from '@scenebook/schema';
import { importPlaywrightFile, importedSceneDraft, writeImportedScene } from '../src/importer.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Playwright importer', () => {
  it('extracts literal tests and semantic test.step blocks from TypeScript without executing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-importer-test-'));
    directories.push(root);
    const testPath = join(root, 'invite.spec.ts');
    await writeFile(
      testPath,
      `import { test } from '@playwright/test';
test('Invite a teammate', async ({ page }) => {
  await test.step('Open invitation form', async () => page.getByRole('button').click());
  await test.step('Send invitation', async () => page.getByText('Send').click());
});
const title = 'dynamic'; test(title, async () => {});
`,
    );
    const imported = await importPlaywrightFile(testPath);
    expect(imported).toHaveLength(1);
    expect(imported[0]?.steps.map((step) => step.title)).toEqual([
      'Open invitation form',
      'Send invitation',
    ]);
    const draft = importedSceneDraft(imported[0]!, root);
    expect(draft.capability).toBe('monitored');
    expect(draft.automation.linkedTest?.path).toBe('invite.spec.ts');

    const path = await writeImportedScene(imported[0]!, join(root, 'scenes'), root);
    const written = parseSceneYaml(await readFile(path, 'utf8'));
    expect(written.steps).toHaveLength(2);
    await expect(writeImportedScene(imported[0]!, join(root, 'scenes'), root)).rejects.toThrow(
      'Refusing to overwrite',
    );
  });
});
