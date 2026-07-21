import { canonicalJsonHash, sha256 } from '@scenebook/core';
import { PublicationInventorySchema, type PublicationFile } from '@scenebook/schema';
import { Zip, ZipDeflate } from 'fflate';
import { describe, expect, it } from 'vitest';

import { verifyPublicationArchive } from '../src/publication-archive.js';

function deterministicArchive(
  files: readonly PublicationFile[],
  bytesByPath: ReadonlyMap<string, Uint8Array>,
  mode = 0o100644,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let failure: unknown;
  const zip = new Zip((error, bytes) => {
    if (error) failure = error;
    else chunks.push(bytes);
  });
  for (const file of files) {
    const entry = new ZipDeflate(file.path, { level: 9 });
    entry.mtime = new Date(1980, 0, 1, 0, 0, 0, 0);
    entry.os = 3;
    entry.attrs = (mode << 16) >>> 0;
    zip.add(entry);
    entry.push(bytesByPath.get(file.path)!, true);
  }
  zip.end();
  if (failure) throw failure;
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 7) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + 7));
  }
}

function fixture() {
  const bytesByPath = new Map<string, Uint8Array>([
    ['manifest.json', new TextEncoder().encode('{"format":"scenebook-catalog"}\n')],
    ['scenes/demo/index.html', new TextEncoder().encode('<!doctype html><p>Demo</p>\n')],
  ]);
  const files = [...bytesByPath.entries()]
    .map(([path, bytes]) => ({
      path,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      mediaType: path.endsWith('.json') ? 'application/json' : 'text/html',
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const archive = deterministicArchive(files, bytesByPath);
  const inventory = PublicationInventorySchema.parse({
    format: 'scenebook-publication-archive',
    version: 1,
    archive: {
      sha256: sha256(archive),
      byteLength: archive.byteLength,
      mediaType: 'application/zip',
    },
    treeHash: canonicalJsonHash({ files }),
    byteLength: files.reduce((total, file) => total + file.byteLength, 0),
    compilerManifest: files.find((file) => file.path === 'manifest.json'),
    files,
  });
  return { archive, bytesByPath, files, inventory };
}

describe('streaming publication archive verification', () => {
  it('accepts the exact deterministic regular-file ZIP in small chunks', async () => {
    const value = fixture();
    await expect(verifyPublicationArchive(chunks(value.archive), value.inventory)).resolves.toBe(
      undefined,
    );
  });

  it('rejects an archive member whose bytes differ from its inventory digest', async () => {
    const value = fixture();
    const tampered = new Map(value.bytesByPath);
    tampered.set('scenes/demo/index.html', new TextEncoder().encode('<p>Replaced</p>\n'));
    const archive = deterministicArchive(value.files, tampered);
    await expect(verifyPublicationArchive(chunks(archive), value.inventory)).rejects.toThrow(
      /member bytes do not match inventory/u,
    );
  });

  it('rejects symlink-mode entries even when their bytes match the inventory', async () => {
    const value = fixture();
    const archive = deterministicArchive(value.files, value.bytesByPath, 0o120777);
    await expect(verifyPublicationArchive(chunks(archive), value.inventory)).rejects.toThrow(
      /metadata is not deterministic/u,
    );
  });

  it('preserves object-store stream failures for the API availability boundary', async () => {
    const value = fixture();
    const outage = new Error('object store unavailable');
    const source = async function* (): AsyncGenerator<Uint8Array> {
      throw outage;
    };

    await expect(verifyPublicationArchive(source(), value.inventory)).rejects.toBe(outage);
  });
});
