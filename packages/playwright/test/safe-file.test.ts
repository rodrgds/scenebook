import { appendFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readBoundedRegularFile } from '../src/safe-file.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'scenebook-safe-read-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('bounded descriptor file reads', () => {
  it('reads one exact regular file through a bounded descriptor', async () => {
    const directory = await root();
    await writeFile(join(directory, 'evidence.json'), 'exact evidence');

    const value = await readBoundedRegularFile(directory, 'evidence.json', {
      maximumBytes: 64,
      minimumBytes: 1,
    });

    expect(Buffer.from(value.bytes).toString('utf8')).toBe('exact evidence');
  });

  it('rejects a final symlink without following it', async () => {
    const directory = await root();
    await writeFile(join(directory, 'outside.json'), 'secret');
    await symlink(join(directory, 'outside.json'), join(directory, 'evidence.json'));

    await expect(
      readBoundedRegularFile(directory, 'evidence.json', { maximumBytes: 64 }),
    ).rejects.toMatchObject({ reason: 'symlink' });
  });

  it('rejects a file that already exceeds its descriptor read bound', async () => {
    const directory = await root();
    await writeFile(join(directory, 'evidence.json'), 'too large');

    await expect(
      readBoundedRegularFile(directory, 'evidence.json', { maximumBytes: 3 }),
    ).rejects.toMatchObject({ reason: 'size' });
  });

  it('detects a size race after opening the descriptor', async () => {
    const directory = await root();
    const path = join(directory, 'evidence.json');
    await writeFile(path, 'four');

    await expect(
      readBoundedRegularFile(directory, 'evidence.json', {
        maximumBytes: 4,
        hooks: { afterOpen: () => appendFile(path, ' more') },
      }),
    ).rejects.toMatchObject({ reason: 'changed' });
  });

  it('detects same-size content replacement before the post-read descriptor stat', async () => {
    const directory = await root();
    const path = join(directory, 'evidence.json');
    await writeFile(path, 'first');

    await expect(
      readBoundedRegularFile(directory, 'evidence.json', {
        maximumBytes: 5,
        hooks: { afterRead: () => writeFile(path, 'other') },
      }),
    ).rejects.toMatchObject({ reason: 'changed' });
  });
});
