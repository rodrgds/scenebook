import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeFileAtomically } from '../src/atomic-write.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-atomic-write-'));
  directories.push(root);
  return root;
}

describe('CLI atomic file writes', () => {
  it('replaces complete bytes with exact private permissions and no temporary residue', async () => {
    const root = await fixture();
    const path = join(root, 'nested', 'baseline.json');
    await writeFileAtomically(path, 'old');
    await chmod(path, 0o644);

    await writeFileAtomically(path, '{"status":"passed"}\n');

    expect(await readFile(path, 'utf8')).toBe('{"status":"passed"}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700);
    expect((await readdir(join(root, 'nested'))).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it('never exposes mixed contents under concurrent replacement', async () => {
    const root = await fixture();
    const path = join(root, 'result.json');
    const first = 'a'.repeat(128 * 1024);
    const second = 'b'.repeat(128 * 1024);

    await Promise.all([writeFileAtomically(path, first), writeFileAtomically(path, second)]);

    expect([first, second]).toContain(await readFile(path, 'utf8'));
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes an exclusive temporary file when writing fails before promotion', async () => {
    const root = await fixture();
    const path = join(root, 'result.json');
    await writeFile(path, 'preserve');

    await expect(writeFileAtomically(path, null as unknown as string)).rejects.toThrow();

    expect(await readFile(path, 'utf8')).toBe('preserve');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
