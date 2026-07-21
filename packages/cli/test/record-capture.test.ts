import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureSanitizedPlaywrightRecording,
  extractLatestPlaywrightProgram,
  sanitizePlaywrightRecording,
} from '../src/record-capture.js';

const header = `import { test, expect } from '@playwright/test';`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function program(body: string): string {
  return `${header}\n\ntest('test', async ({ page }) => {\n${body}\n});\n`;
}

describe('private Playwright recorder source handling', () => {
  it('selects only the final complete snapshot emitted through the private pipe', () => {
    const first = program(`  await page.goto('https://example.test/first');`);
    const last = program(`  await page.goto('https://example.test/final');`);
    expect(extractLatestPlaywrightProgram(first + last)).toBe(last);
  });

  it('removes every scalar data-entry value, assertion echo, and navigation URL', () => {
    const source = program(`  await page.goto('https://example.test/start');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByLabel('Token').pressSequentially('ghp_secret_canary_123456789');
  await page.getByLabel('Role').selectOption({ label: 'Workspace owner', index: 2 });
  await page.setInputFiles(['private/customer-list.csv', 'private/contracts.csv']);
  page.on('dialog', dialog => dialog.accept('private prompt response'));
  await expect(page.getByLabel('Status')).toHaveValue('private echoed response');
  await page.waitForURL('https://example.test/callback?token=ghp_secret_canary_123456789');`);

    const sanitized = sanitizePlaywrightRecording(source);

    for (const secret of [
      'correct horse battery staple',
      'ghp_secret_canary_123456789',
      'Workspace owner',
      'private/customer-list.csv',
      'private/contracts.csv',
      'private prompt response',
      'private echoed response',
      'https://example.test',
    ]) {
      expect(sanitized.source).not.toContain(secret);
    }
    expect(sanitized.source).toContain(`scenebookRecordingNumber('SCENEBOOK_INPUT_004')`);
    expect(sanitized.source).toContain(`SCENEBOOK_INPUT_008`);
    expect(sanitized.source).toContain(`SCENEBOOK_URL_002`);
    expect(sanitized.source).toContain('Missing required sanitized recording fixture');
    expect(sanitized.placeholders).toHaveLength(10);
    expect(sanitized.placeholders.map((placeholder) => placeholder.name)).toEqual([
      'SCENEBOOK_URL_001',
      'SCENEBOOK_INPUT_001',
      'SCENEBOOK_INPUT_002',
      'SCENEBOOK_INPUT_003',
      'SCENEBOOK_INPUT_004',
      'SCENEBOOK_INPUT_005',
      'SCENEBOOK_INPUT_006',
      'SCENEBOOK_INPUT_007',
      'SCENEBOOK_INPUT_008',
      'SCENEBOOK_URL_002',
    ]);
  });

  it('replaces unsupported data expressions as one explicit fixture', () => {
    const sanitized = sanitizePlaywrightRecording(
      program(`  await page.getByLabel('Account').fill(loadPrivateAccount());`),
    );
    expect(sanitized.source).not.toContain('loadPrivateAccount');
    expect(sanitized.source).toContain(`fill(scenebookRecordingValue('SCENEBOOK_INPUT_001'))`);
  });

  it('fails closed when an entered value is repeated outside its input call', () => {
    const source = program(`  await page.getByLabel('Search').fill('unclassified private canary');
  await page.getByText('Result: unclassified private canary').click();`);
    expect(() => sanitizePlaywrightRecording(source)).toThrow(
      'data-entry value was repeated elsewhere',
    );
  });

  it('fails closed when private material survives outside data-entry calls', () => {
    const source = program(
      `  await page.getByText('ghp_abcdefghijklmnopqrstuvwxyz123456').click();`,
    );
    expect(() => sanitizePlaywrightRecording(source)).toThrow(
      'sanitized recording still contains private data',
    );
  });

  it('rejects extra top-level source, truncated output, and non-Playwright output', () => {
    expect(() => sanitizePlaywrightRecording(`${program('')}\nrunUntrustedSource();\n`)).toThrow(
      'unsupported top-level source',
    );
    expect(() => extractLatestPlaywrightProgram('')).toThrow('complete TypeScript test');
    expect(() => extractLatestPlaywrightProgram(`${header}\ntest(`)).toThrow(
      'invalid TypeScript recording',
    );
  });

  it('frames real descriptor snapshots, isolates child state, strips env, and cleans recovery data', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'scenebook-record-capture-test-'));
    roots.push(root);
    const command = join(root, 'fake-codegen.cjs');
    const auditPath = join(root, 'audit.json');
    const childErrorPath = join(root, 'child-error.txt');
    const script = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
process.on('uncaughtException', error => {
  writeFileSync(${JSON.stringify(childErrorPath)}, error.stack || String(error));
  process.exit(1);
});
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const output = option('--output');
const profile = option('--user-data-dir');
const secret = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, 'recoverable-session.txt'), secret);
writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env }));
const header = ${JSON.stringify(header)};
const snapshot = body => header + "\\n\\ntest('test', async ({ page }) => {\\n" + body + "\\n});\\n";
writeFileSync(output, snapshot("  await page.getByText('discarded snapshot').click();"));
writeFileSync(output, snapshot("  await page.goto('https://example.test/callback?token=" + secret + "');\\n  await page.getByLabel('Token').fill('" + secret + "');"));
process.stdout.write(secret);
process.stderr.write(secret);
`;
    await writeFile(command, script, { mode: 0o700 });
    await chmod(command, 0o700);

    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const captured = await captureSanitizedPlaywrightRecording({
      command,
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: `--title=${secret}`,
        UNRELATED_CANARY: secret,
      },
      targetHref: 'https://example.test/start',
    }).catch(async (error: unknown) => {
      const detail = await readFile(childErrorPath, 'utf8').catch(() => 'no child detail');
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`);
    });

    expect(captured.source).not.toContain(secret);
    expect(captured.source).not.toContain('discarded snapshot');
    expect(captured.source).not.toContain('https://example.test');
    expect(captured.source).toContain('SCENEBOOK_INPUT_001');
    expect(captured.source).toContain('SCENEBOOK_URL_001');

    const audit = JSON.parse(await readFile(auditPath, 'utf8')) as {
      readonly args: string[];
      readonly cwd: string;
      readonly env: Record<string, string>;
    };
    expect(audit.args.slice(0, 6)).toEqual([
      'codegen',
      '--target',
      'playwright-test',
      '--user-data-dir',
      join(dirname(audit.env.HOME ?? ''), 'profile'),
      '--output',
    ]);
    expect(audit.args[6]).toMatch(/\.scenebook-codegen-[\da-f-]+\.pipe$/u);
    expect(dirname(audit.args[6] ?? '')).toBe(dirname(audit.env.HOME ?? ''));
    expect(audit.args.at(-1)).toBe('https://example.test/start');
    expect(audit.env.UNRELATED_CANARY).toBeUndefined();
    expect(audit.env.NODE_OPTIONS).toBeUndefined();
    expect(audit.env.HOME).toBe(join(dirname(audit.env.HOME ?? ''), 'home'));
    expect(audit.env.TMPDIR).toBe(join(dirname(audit.env.HOME ?? ''), 'tmp'));
    await expect(
      readFile(join(audit.cwd, 'profile/recoverable-session.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(audit.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(command, 'utf8')).not.toContain(secret);
    expect(await readFile(auditPath, 'utf8')).not.toContain(secret);
  });
});
