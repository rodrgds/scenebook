import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { assertPathInside, sha256 } from '@scenebook/core';
import { AssetRefSchema, type AssetRef } from '@scenebook/schema';

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/html': 'html',
  'text/markdown': 'md',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export interface PutAssetOptions {
  readonly mediaType: string;
  readonly role?: AssetRef['role'];
  readonly extension?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

export interface ContentAddressedStoreOptions {
  readonly publicPathPrefix?: string;
  readonly fsync?: boolean;
}

function safeExtension(mediaType: string, extension?: string): string {
  const value = (extension ?? MEDIA_EXTENSIONS[mediaType] ?? 'bin')
    .toLowerCase()
    .replace(/^\./u, '');
  if (!/^[a-z0-9]{1,12}$/u.test(value))
    throw new TypeError(`Unsafe asset extension: ${JSON.stringify(value)}`);
  return value;
}

export class ContentAddressedStore {
  readonly root: string;
  readonly publicPathPrefix: string;
  readonly fsync: boolean;

  constructor(root: string, options: ContentAddressedStoreOptions = {}) {
    this.root = resolve(root);
    this.publicPathPrefix = (options.publicPathPrefix ?? 'assets').replace(/^\/+|\/+$/gu, '');
    if (
      !this.publicPathPrefix ||
      this.publicPathPrefix.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw new TypeError('publicPathPrefix must be a safe relative POSIX path');
    }
    this.fsync = options.fsync !== false;
  }

  private filePathFor(ref: Pick<AssetRef, 'path' | 'sha256'>): string {
    const filename = basename(ref.path);
    if (!filename.startsWith(ref.sha256) || !/^[a-f0-9]{64}\.[a-z0-9]{1,12}$/u.test(filename)) {
      throw new TypeError('Asset path is not content-addressed');
    }
    return assertPathInside(this.root, join(this.root, filename));
  }

  async put(data: string | Uint8Array, options: PutAssetOptions): Promise<AssetRef> {
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
    const digest = sha256(bytes);
    const extension = safeExtension(options.mediaType, options.extension);
    const filename = `${digest}.${extension}`;
    const destination = assertPathInside(this.root, join(this.root, filename));
    await mkdir(this.root, { recursive: true });

    const temporary = join(this.root, `.${randomUUID()}.scenebook-asset`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      if (this.fsync) await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await lstat(destination);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`Immutable asset destination is not a regular file: ${destination}`);
        }
        const existing = await readFile(destination);
        if (sha256(existing) !== digest) {
          throw new Error(`Immutable asset collision at ${destination}`);
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }

    return AssetRefSchema.parse({
      sha256: digest,
      path: `${this.publicPathPrefix}/${filename}`,
      mediaType: options.mediaType,
      byteLength: bytes.byteLength,
      role: options.role ?? 'other',
      width: options.width,
      height: options.height,
      durationMs: options.durationMs,
    });
  }

  async has(ref: AssetRef): Promise<boolean> {
    try {
      const info = await lstat(this.filePathFor(AssetRefSchema.parse(ref)));
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async get(ref: AssetRef, options: { readonly verify?: boolean } = {}): Promise<Uint8Array> {
    const parsed = AssetRefSchema.parse(ref);
    const path = this.filePathFor(parsed);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Asset must be a regular non-symlink file: ${parsed.path}`);
    }
    const bytes = await readFile(path);
    if (options.verify !== false) {
      if (bytes.byteLength !== parsed.byteLength)
        throw new Error(`Asset byte length mismatch: ${parsed.path}`);
      if (sha256(bytes) !== parsed.sha256)
        throw new Error(`Asset integrity mismatch: ${parsed.path}`);
    }
    return new Uint8Array(bytes);
  }

  async verify(ref: AssetRef): Promise<boolean> {
    try {
      await this.get(ref, { verify: true });
      return true;
    } catch {
      return false;
    }
  }
}
