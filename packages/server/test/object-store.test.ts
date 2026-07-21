import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { sha256 } from '@scenebook/core';

import {
  FileSystemObjectStore,
  immutableObjectKey,
  S3ObjectStore,
  stagingObjectKey,
} from '../src/object-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-store-'));
  roots.push(root);
  return { root, store: new FileSystemObjectStore(root) };
}

interface MemoryS3Object {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly etag: string;
}

async function requestBodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return Uint8Array.from(body);
  if (
    body &&
    typeof body === 'object' &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === 'function'
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  throw new Error('Unsupported in-memory S3 request body');
}

function conditionalError(status: 409 | 412): Error {
  return Object.assign(
    new Error(status === 409 ? 'Conditional request conflict' : 'Precondition failed'),
    {
      name: status === 409 ? 'ConditionalRequestConflict' : 'PreconditionFailed',
      $metadata: { httpStatusCode: status },
    },
  );
}

function missingObject(): Error {
  return Object.assign(new Error('Object not found'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
}

function sourceKey(value: string): string {
  const separator = value.indexOf('/');
  if (separator < 0) throw new Error('Invalid in-memory CopySource');
  return value
    .slice(separator + 1)
    .split('/')
    .map((part) => decodeURIComponent(part))
    .join('/');
}

class MemoryS3Client {
  private readonly objects = new Map<string, MemoryS3Object>();
  private readonly writes = new Map<string, number>();
  private finalCopyBarrier:
    | {
        readonly expected: number;
        waiting: number;
        readonly promise: Promise<void>;
        readonly release: () => void;
      }
    | undefined;
  private sourceReplacement:
    | {
        readonly bytes: Uint8Array;
        readonly contentType: string;
        readonly metadata: Readonly<Record<string, string>>;
      }
    | undefined;
  readonly copyRequests: Array<{
    readonly key: string;
    readonly source: string;
    readonly sourceIfMatch?: string;
    readonly ifNoneMatch?: string;
  }> = [];

  synchronizeFinalCopies(expected: number): void {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.finalCopyBarrier = { expected, waiting: 0, promise, release };
  }

  replaceSourceBeforeNextFinalCopy(
    bytes: Uint8Array,
    contentType: string,
    metadata: Readonly<Record<string, string>>,
  ): void {
    this.sourceReplacement = { bytes, contentType, metadata };
  }

  seed(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    metadata: Readonly<Record<string, string>>,
  ): void {
    this.install(key, bytes, contentType, metadata);
  }

  writeCount(key: string): number {
    return this.writes.get(key) ?? 0;
  }

  private install(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    metadata: Readonly<Record<string, string>>,
  ): MemoryS3Object {
    const value = {
      bytes: Uint8Array.from(bytes),
      contentType,
      metadata: { ...metadata },
      etag: `"${sha256(bytes)}"`,
    };
    this.objects.set(key, value);
    this.writes.set(key, this.writeCount(key) + 1);
    return value;
  }

  private async waitForFinalCopies(key: string): Promise<void> {
    const barrier = this.finalCopyBarrier;
    if (!barrier || !key.startsWith('workspaces/')) return;
    barrier.waiting += 1;
    if (barrier.waiting === barrier.expected) {
      this.finalCopyBarrier = undefined;
      barrier.release();
    }
    await barrier.promise;
  }

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      if (!key || !command.input.ContentType) throw new Error('Incomplete PutObject request');
      if (command.input.IfNoneMatch === '*' && this.objects.has(key)) throw conditionalError(412);
      const bytes = await requestBodyBytes(command.input.Body);
      const value = this.install(
        key,
        bytes,
        command.input.ContentType,
        command.input.Metadata ?? {},
      );
      return { ETag: value.etag };
    }
    if (command instanceof CopyObjectCommand) {
      const key = command.input.Key;
      const encodedSource = command.input.CopySource;
      if (!key || !encodedSource || !command.input.ContentType) {
        throw new Error('Incomplete CopyObject request');
      }
      await this.waitForFinalCopies(key);
      const source = sourceKey(encodedSource);
      if (key.startsWith('workspaces/') && this.sourceReplacement) {
        const replacement = this.sourceReplacement;
        this.sourceReplacement = undefined;
        this.install(source, replacement.bytes, replacement.contentType, replacement.metadata);
      }
      const object = this.objects.get(source);
      if (!object) throw missingObject();
      if (command.input.CopySourceIfMatch && command.input.CopySourceIfMatch !== object.etag) {
        throw conditionalError(412);
      }
      this.copyRequests.push({
        key,
        source,
        ...(command.input.CopySourceIfMatch
          ? { sourceIfMatch: command.input.CopySourceIfMatch }
          : {}),
        ...(command.input.IfNoneMatch ? { ifNoneMatch: command.input.IfNoneMatch } : {}),
      });
      if (command.input.IfNoneMatch === '*' && this.objects.has(key)) throw conditionalError(412);
      const value = this.install(
        key,
        object.bytes,
        command.input.ContentType,
        command.input.Metadata ?? {},
      );
      return { CopyObjectResult: { ETag: value.etag } };
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key;
      const object = key ? this.objects.get(key) : undefined;
      if (!object) throw missingObject();
      return {
        Body: { transformToByteArray: async () => Uint8Array.from(object.bytes) },
        ContentLength: object.bytes.byteLength,
        ContentType: object.contentType,
        Metadata: { ...object.metadata },
        ETag: object.etag,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      if (command.input.Key) this.objects.delete(command.input.Key);
      return {};
    }
    throw new Error(`Unsupported in-memory S3 command: ${String(command)}`);
  }
}

describe('filesystem immutable object store', () => {
  it('stages, verifies, promotes, reads, and safely removes content-addressed objects', async () => {
    const fixture = await store();
    const bytes = new TextEncoder().encode('immutable artifact');
    const digest = sha256(bytes);
    const staged = await fixture.store.putStaged('upload-1', digest, bytes, 'text/plain');
    expect(await fixture.store.verify(staged)).toBe(true);
    const promoted = await fixture.store.promote(staged, 'workspace-1');
    expect(promoted.key).toBe(immutableObjectKey('workspace-1', digest, 'text/plain'));
    await fixture.store.deleteStaged(staged);
    expect(new TextDecoder().decode(await fixture.store.read(promoted))).toBe('immutable artifact');
    const streamed: Uint8Array[] = [];
    for await (const chunk of fixture.store.readStream(promoted)) streamed.push(chunk.slice());
    expect(Buffer.concat(streamed.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(bytes));
    expect(new TextDecoder().decode(await readFile(join(fixture.root, promoted.key)))).toBe(
      'immutable artifact',
    );
  });

  it('rejects digest mismatches and path-like identifiers', async () => {
    const fixture = await store();
    const bytes = new TextEncoder().encode('artifact');
    await expect(
      fixture.store.putStaged('upload-1', 'a'.repeat(64), bytes, 'text/plain'),
    ).rejects.toThrow('digest mismatch');
    await expect(
      fixture.store.putStaged('../escape', sha256(bytes), bytes, 'text/plain'),
    ).rejects.toThrow('Invalid upload ID');
  });

  it('rejects active types and bytes that spoof an allowlisted media type', async () => {
    const fixture = await store();
    const html = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    await expect(
      fixture.store.putStaged('upload-1', sha256(html), html, 'image/svg+xml'),
    ).rejects.toThrow('media type is not allowed');
    await expect(
      fixture.store.putStaged('upload-1', sha256(html), html, 'image/png'),
    ).rejects.toThrow('do not match');
  });

  it('keeps historical filesystem objects readable when the same bytes change media type', async () => {
    const fixture = await store();
    const bytes = new TextEncoder().encode('{"status":"ok"}');
    const digest = sha256(bytes);
    const json = await fixture.store.putStaged('upload-shared', digest, bytes, 'application/json');
    const promotedJson = await fixture.store.promote(json, 'workspace-1');
    const plain = await fixture.store.putStaged('upload-shared', digest, bytes, 'text/plain');
    const promotedPlain = await fixture.store.promote(plain, 'workspace-1');

    expect(json.key).toBe(stagingObjectKey('upload-shared', digest, 'application/json'));
    expect(plain.key).toBe(stagingObjectKey('upload-shared', digest, 'text/plain'));
    expect(json.key).not.toBe(plain.key);
    expect(promotedJson.key).not.toBe(promotedPlain.key);
    expect(await fixture.store.read(promotedJson)).toEqual(bytes);
    expect(await fixture.store.read(promotedPlain)).toEqual(bytes);
  });

  it('stages and verifies large artifacts from bounded reusable chunks', async () => {
    const fixture = await store();
    const byteLength = 16 * 1024 * 1024;
    const chunkSize = 64 * 1024;
    const first = new Uint8Array(chunkSize);
    first.set([0x50, 0x4b, 0x03, 0x04]);
    const remaining = new Uint8Array(chunkSize).fill(0xa5);
    const digest = createHash('sha256');
    digest.update(first);
    for (let offset = chunkSize; offset < byteLength; offset += chunkSize) {
      digest.update(remaining.subarray(0, Math.min(chunkSize, byteLength - offset)));
    }
    const expectedHash = digest.digest('hex');
    let largestChunk = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      largestChunk = first.byteLength;
      yield first;
      for (let offset = chunkSize; offset < byteLength; offset += chunkSize) {
        const chunk = remaining.subarray(0, Math.min(chunkSize, byteLength - offset));
        largestChunk = Math.max(largestChunk, chunk.byteLength);
        yield chunk;
      }
    }

    const staged = await fixture.store.putStagedStream(
      'large-upload',
      expectedHash,
      source(),
      byteLength,
      'application/zip',
    );

    expect(largestChunk).toBe(chunkSize);
    expect((await stat(join(fixture.root, staged.key))).size).toBe(byteLength);
    expect(await fixture.store.verify(staged)).toBe(true);
  });

  it('will not follow a symlink planted at a staged object destination', async () => {
    const fixture = await store();
    const bytes = new TextEncoder().encode('artifact');
    const digest = sha256(bytes);
    const outside = join(fixture.root, 'outside');
    const destination = join(fixture.root, stagingObjectKey('upload-1', digest, 'text/plain'));
    await mkdir(dirname(destination), { recursive: true });
    await symlink(outside, destination);
    await expect(fixture.store.putStaged('upload-1', digest, bytes, 'text/plain')).rejects.toThrow(
      'Could not create immutable staged object',
    );
  });
});

describe('S3 immutable object store', () => {
  it('requires persisted content type and digest metadata during verification', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwO0GQAAAABJRU5ErkJggg==',
      'base64',
    );
    const digest = sha256(bytes);
    const object = {
      key: immutableObjectKey('workspace-1', digest, 'image/png'),
      sha256: digest,
      byteLength: bytes.byteLength,
      mediaType: 'image/png',
    };
    const client = (contentType: string, metadataHash = digest) =>
      ({
        send: async () => ({
          Body: { transformToByteArray: async () => bytes },
          ContentType: contentType,
          Metadata: { sha256: metadataHash },
          ETag: `"${digest}"`,
        }),
      }) as unknown as S3Client;

    expect(
      await new S3ObjectStore(
        { bucket: 'scenebook', region: 'us-east-1' },
        client('text/html'),
      ).verify(object),
    ).toBe(false);
    expect(
      await new S3ObjectStore(
        { bucket: 'scenebook', region: 'us-east-1' },
        client('image/png', 'f'.repeat(64)),
      ).verify(object),
    ).toBe(false);
    expect(
      await new S3ObjectStore(
        { bucket: 'scenebook', region: 'us-east-1' },
        client('image/png'),
      ).verify(object),
    ).toBe(true);
  });

  it('keeps identical bytes independently readable under two media identities', async () => {
    const client = new MemoryS3Client();
    const objectStore = new S3ObjectStore(
      { bucket: 'scenebook', region: 'us-east-1' },
      client as unknown as S3Client,
    );
    const bytes = new TextEncoder().encode('{"status":"ok"}');
    const digest = sha256(bytes);
    const json = await objectStore.putStaged('upload-shared', digest, bytes, 'application/json');
    const plain = await objectStore.putStaged('upload-shared', digest, bytes, 'text/plain');

    const promotedJson = await objectStore.promote(json, 'workspace-1');
    const promotedPlain = await objectStore.promote(plain, 'workspace-1');

    expect(json.key).toBe(stagingObjectKey('upload-shared', digest, 'application/json'));
    expect(plain.key).toBe(stagingObjectKey('upload-shared', digest, 'text/plain'));
    expect(json.key).not.toBe(plain.key);
    expect(promotedJson.key).not.toBe(promotedPlain.key);
    expect(promotedJson.key).toBe(immutableObjectKey('workspace-1', digest, 'application/json'));
    expect(promotedPlain.key).toBe(immutableObjectKey('workspace-1', digest, 'text/plain'));
    expect(await objectStore.read(promotedJson)).toEqual(bytes);
    expect(await objectStore.read(promotedPlain)).toEqual(bytes);
    const streamed: Uint8Array[] = [];
    for await (const chunk of objectStore.readStream(promotedJson)) streamed.push(chunk.slice());
    expect(Buffer.concat(streamed.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(bytes));
    expect(client.writeCount(promotedJson.key)).toBe(1);
    expect(client.writeCount(promotedPlain.key)).toBe(1);
    expect(
      client.copyRequests
        .filter((request) => request.key.startsWith('workspaces/'))
        .every((request) => request.ifNoneMatch === '*' && request.sourceIfMatch),
    ).toBe(true);
  });

  it('makes concurrent promotion an idempotent create without overwriting the winner', async () => {
    const client = new MemoryS3Client();
    const objectStore = new S3ObjectStore(
      { bucket: 'scenebook', region: 'us-east-1' },
      client as unknown as S3Client,
    );
    const bytes = new TextEncoder().encode('shared immutable output');
    const digest = sha256(bytes);
    const first = await objectStore.putStaged('upload-first', digest, bytes, 'text/plain');
    const second = await objectStore.putStaged('upload-second', digest, bytes, 'text/plain');
    client.synchronizeFinalCopies(2);

    const [left, right] = await Promise.all([
      objectStore.promote(first, 'workspace-1'),
      objectStore.promote(second, 'workspace-1'),
    ]);

    expect(left.key).toBe(right.key);
    expect(client.writeCount(left.key)).toBe(1);
    expect(await objectStore.read(left)).toEqual(bytes);
    expect(await objectStore.read(right)).toEqual(bytes);
  });

  it('refuses to replace an existing final object with conflicting metadata', async () => {
    const client = new MemoryS3Client();
    const objectStore = new S3ObjectStore(
      { bucket: 'scenebook', region: 'us-east-1' },
      client as unknown as S3Client,
    );
    const bytes = new TextEncoder().encode('{"status":"ok"}');
    const digest = sha256(bytes);
    const staged = await objectStore.putStaged(
      'upload-conflict',
      digest,
      bytes,
      'application/json',
    );
    const finalKey = immutableObjectKey('workspace-1', digest, 'application/json');
    client.seed(finalKey, bytes, 'text/plain', { sha256: digest });

    await expect(objectStore.promote(staged, 'workspace-1')).rejects.toThrow(
      'refusing to overwrite existing content or metadata',
    );
    expect(client.writeCount(finalKey)).toBe(1);
  });

  it('refuses promotion when the staged source changes after verification', async () => {
    const client = new MemoryS3Client();
    const objectStore = new S3ObjectStore(
      { bucket: 'scenebook', region: 'us-east-1' },
      client as unknown as S3Client,
    );
    const bytes = new TextEncoder().encode('verified source');
    const digest = sha256(bytes);
    const staged = await objectStore.putStaged('upload-source-race', digest, bytes, 'text/plain');
    const replacement = new TextEncoder().encode('changed after verification');
    client.replaceSourceBeforeNextFinalCopy(replacement, 'text/plain', {
      sha256: sha256(replacement),
    });
    const finalKey = immutableObjectKey('workspace-1', digest, 'text/plain');

    await expect(objectStore.promote(staged, 'workspace-1')).rejects.toThrow(
      'refusing to overwrite existing content or metadata',
    );
    expect(client.writeCount(finalKey)).toBe(0);
  });
});

describe('MinIO application policy', () => {
  it('limits final writes to metadata-replacing copies from staging', async () => {
    const policy = JSON.parse(
      await readFile(new URL('../../../deploy/minio-policy.json', import.meta.url), 'utf8'),
    ) as {
      readonly Statement: readonly {
        readonly Effect: string;
        readonly Action: readonly string[];
        readonly Resource: readonly string[];
        readonly Condition?: Readonly<
          Record<string, Readonly<Record<string, string | readonly string[]>>>
        >;
      }[];
    };
    const staging = 'arn:aws:s3:::scenebook/staging/*';
    const finalized = 'arn:aws:s3:::scenebook/workspaces/*/objects/*';
    const allowedWrites = policy.Statement.filter(
      (statement) => statement.Effect === 'Allow' && statement.Action.includes('s3:PutObject'),
    );

    expect(
      allowedWrites.some((statement) => statement.Resource.includes('arn:aws:s3:::scenebook/*')),
    ).toBe(false);
    expect(allowedWrites).toHaveLength(2);
    expect(
      allowedWrites.find((statement) => statement.Resource.includes(staging))?.Condition,
    ).toBeUndefined();
    expect(allowedWrites.find((statement) => statement.Resource.includes(finalized))).toMatchObject(
      {
        Condition: {
          StringEquals: { 's3:x-amz-metadata-directive': 'REPLACE' },
          StringLike: { 's3:x-amz-copy-source': 'scenebook/staging/*' },
        },
      },
    );
    expect(
      policy.Statement.some(
        (statement) =>
          statement.Effect === 'Allow' &&
          statement.Action.includes('s3:DeleteObject') &&
          statement.Resource.includes(finalized),
      ),
    ).toBe(false);
  });
});
