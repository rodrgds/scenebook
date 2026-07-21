import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { replaceDirectoryAtomically } from '../src/atomic.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('atomic directory replacement', () => {
  it('keeps a committed publication successful and reports post-commit backup cleanup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-atomic-directory-'));
    directories.push(root);
    const destination = join(root, 'publication');
    await mkdir(destination);
    await writeFile(join(destination, 'old.txt'), 'previous release');

    const result = await replaceDirectoryAtomically(
      destination,
      async (staging) => {
        await writeFile(join(staging, 'new.txt'), 'current release');
      },
      true,
      {
        removeDirectory: async () => {
          throw new Error('simulated cleanup denial');
        },
      },
    );

    expect(await readFile(join(destination, 'new.txt'), 'utf8')).toBe('current release');
    expect(result).toMatchObject({
      committed: true,
      cleanup: {
        status: 'pending',
        warning: expect.stringContaining('simulated cleanup denial'),
      },
    });
    if (result.cleanup.status !== 'pending') throw new Error('Expected pending cleanup result.');
    expect(basename(result.cleanup.backupDirectory)).toMatch(/^\.publication\.backup-/u);
    expect(await readFile(join(result.cleanup.backupDirectory, 'old.txt'), 'utf8')).toBe(
      'previous release',
    );
    expect((await readdir(root)).filter((name) => name.includes('.staging-'))).toEqual([]);
  });

  it('rolls the previous directory back when promotion fails before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-atomic-rollback-'));
    directories.push(root);
    const destination = join(root, 'publication');
    await mkdir(destination);
    await writeFile(join(destination, 'old.txt'), 'previous release');

    await expect(
      replaceDirectoryAtomically(destination, async () => {
        throw new Error('build failed');
      }),
    ).rejects.toThrow('build failed');

    expect(await readFile(join(destination, 'old.txt'), 'utf8')).toBe('previous release');
    expect((await readdir(root)).filter((name) => name.includes('.staging-'))).toEqual([]);
    expect((await readdir(root)).filter((name) => name.includes('.backup-'))).toEqual([]);
  });
});
