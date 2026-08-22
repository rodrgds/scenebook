import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, lstat, link, mkdir, readFile, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { assertPathInside } from '@scenebook/core';

import {
  isAllowedObjectMediaType,
  ObjectMediaPolicyError,
  ObjectMediaStreamValidator,
} from './media-policy.js';

export interface StoredObject {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export class ObjectIntegrityError extends Error {
  constructor(
    readonly kind: 'length' | 'digest',
    message: string,
  ) {
    super(message);
    this.name = 'ObjectIntegrityError';
  }
}

export interface ImmutableObjectStore {
  health(): Promise<void>;
  putStaged(
    uploadId: string,
    expectedHash: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<StoredObject>;
  putStagedStream(
    uploadId: string,
    expectedHash: string,
    source: AsyncIterable<Uint8Array>,
    expectedByteLength: number,
    mediaType: string,
  ): Promise<StoredObject>;
  verify(object: StoredObject): Promise<boolean>;
  promote(staged: StoredObject, workspaceId: string): Promise<StoredObject>;
  /** Integrity-validating bounded-memory read used for large publication archives. */
  readStream?(object: StoredObject): AsyncIterable<Uint8Array>;
  read(object: StoredObject): Promise<Uint8Array>;
  deleteStaged(object: StoredObject): Promise<void>;
}

/**
 * Deliberately separate capability for final-object erasure. The ordinary
 * immutable store never exposes this operation, so its runtime credential can
 * remain read/write-staging + read-final only.
 */
export interface FinalObjectDeleter {
  health(): Promise<void>;
  deleteFinal(object: StoredObject, signal?: AbortSignal): Promise<void>;
}

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function* validatedObjectStream(
  source: AsyncIterable<Uint8Array>,
  expectedHash: string,
  expectedByteLength: number,
  mediaType: string,
): AsyncGenerator<Uint8Array> {
  const validator = new ObjectMediaStreamValidator(mediaType, expectedByteLength);
  const digest = createHash('sha256');
  let total = 0;
  for await (const value of source) {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > expectedByteLength) {
      throw new ObjectIntegrityError('length', 'Object exceeds its declared byte length');
    }
    validator.write(chunk);
    digest.update(chunk);
    yield chunk;
  }
  if (total !== expectedByteLength) {
    throw new ObjectIntegrityError('length', 'Object byte length does not match its declaration');
  }
  validator.finish();
  const actualHash = digest.digest('hex');
  if (actualHash !== expectedHash) {
    throw new ObjectIntegrityError(
      'digest',
      `Object digest mismatch: expected ${expectedHash}, received ${actualHash}`,
    );
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error('Object-store write made no progress');
    offset += bytesWritten;
  }
}

async function verifyFile(path: string, object: StoredObject): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size !== object.byteLength) return false;
    const validator = new ObjectMediaStreamValidator(object.mediaType, object.byteLength);
    const digest = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < object.byteLength) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.byteLength, object.byteLength - offset),
        offset,
      );
      if (bytesRead === 0) return false;
      const value = chunk.subarray(0, bytesRead);
      validator.write(value);
      digest.update(value);
      offset += bytesRead;
    }
    const final = await handle.stat();
    if (final.size !== initial.size) return false;
    validator.finish();
    return digest.digest('hex') === object.sha256;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateIdentifier(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function validateHash(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError('Invalid SHA-256 digest');
  return value;
}

function mediaPathIdentity(mediaType: string): string {
  if (!isAllowedObjectMediaType(mediaType)) {
    throw new ObjectMediaPolicyError(`Object media type is not allowed: ${mediaType}`);
  }
  return Buffer.from(mediaType, 'utf8').toString('base64url');
}

/** Returns the deterministic, media-bound key used before promotion. */
export function stagingObjectKey(uploadId: string, hash: string, mediaType: string): string {
  validateIdentifier(uploadId, 'upload ID');
  validateHash(hash);
  // Keep the media-bound form beside the legacy digest-only key rather than
  // beneath it, so rolling upgrades can still delete a legacy staged file.
  return `staging/${uploadId}/${hash}.${mediaPathIdentity(mediaType)}`;
}

/**
 * The digest identifies bytes, not their interpretation. Keep the media type in
 * the immutable identity so the same safe bytes can be retained as, for
 * example, both application/json and text/plain without mutating metadata used
 * by an older Release.
 */
export function immutableObjectKey(workspaceId: string, hash: string, mediaType: string): string {
  validateIdentifier(workspaceId, 'workspace ID');
  validateHash(hash);
  return `workspaces/${workspaceId}/objects/${hash}/${mediaPathIdentity(mediaType)}`;
}

function validateKey(value: string): string {
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new TypeError('Object key must be a safe relative POSIX path');
  }
  return value;
}

function hasErrnoCode<T>(error: T, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }
}

export class FileSystemObjectStore implements ImmutableObjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    return assertPathInside(this.root, join(this.root, validateKey(key)));
  }

  async health(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const probe = this.path(`.health-${randomUUID()}`);
    const handle = await open(probe, 'wx', 0o600);
    await handle.close();
    await rm(probe, { force: true });
  }

  async putStaged(
    uploadId: string,
    expectedHash: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<StoredObject> {
    return this.putStagedStream(
      uploadId,
      expectedHash,
      singleChunk(bytes),
      bytes.byteLength,
      mediaType,
    );
  }

  async putStagedStream(
    uploadId: string,
    expectedHash: string,
    source: AsyncIterable<Uint8Array>,
    expectedByteLength: number,
    mediaType: string,
  ): Promise<StoredObject> {
    validateIdentifier(uploadId, 'upload ID');
    validateHash(expectedHash);
    const key = stagingObjectKey(uploadId, expectedHash, mediaType);
    const destination = this.path(key);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = this.path(`staging/${uploadId}/.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      for await (const chunk of validatedObjectStream(
        source,
        expectedHash,
        expectedByteLength,
        mediaType,
      )) {
        await writeAll(handle, chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, destination);
      } catch (error) {
        if (!hasErrnoCode(error, 'EEXIST')) throw error;
      }
      const object = {
        key,
        sha256: expectedHash,
        byteLength: expectedByteLength,
        mediaType,
      };
      if (!(await verifyFile(destination, object))) {
        throw new Error(`Could not create immutable staged object ${key}`);
      }
      return object;
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async verify(object: StoredObject): Promise<boolean> {
    try {
      const path = this.path(object.key);
      if (!(await regularFile(path))) return false;
      return verifyFile(path, object);
    } catch {
      return false;
    }
  }

  async promote(staged: StoredObject, workspaceId: string): Promise<StoredObject> {
    if (!(await this.verify(staged)))
      throw new Error(`Staged object failed integrity verification: ${staged.key}`);
    const key = immutableObjectKey(workspaceId, staged.sha256, staged.mediaType);
    const destination = this.path(key);
    await mkdir(dirname(destination), { recursive: true });
    if (!(await regularFile(destination))) {
      try {
        await link(this.path(staged.key), destination);
      } catch (error) {
        if (!hasErrnoCode(error, 'EEXIST')) throw error;
      }
    }
    const promoted = { ...staged, key };
    if (!(await this.verify(promoted)))
      throw new Error(`Final object failed integrity verification: ${key}`);
    return promoted;
  }

  async read(object: StoredObject): Promise<Uint8Array> {
    if (!(await this.verify(object)))
      throw new Error(`Object failed integrity verification: ${object.key}`);
    return new Uint8Array(await readFile(this.path(object.key)));
  }

  async *readStream(object: StoredObject): AsyncGenerator<Uint8Array> {
    const path = this.path(object.key);
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const initial = await handle.stat();
      if (!initial.isFile() || initial.size !== object.byteLength) {
        throw new ObjectIntegrityError(
          'length',
          'Object byte length does not match its declaration',
        );
      }
      const validator = new ObjectMediaStreamValidator(object.mediaType, object.byteLength);
      const digest = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < object.byteLength) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, object.byteLength - offset),
          offset,
        );
        if (bytesRead === 0) {
          throw new ObjectIntegrityError('length', 'Object ended before its declared byte length');
        }
        const value = buffer.subarray(0, bytesRead);
        validator.write(value);
        digest.update(value);
        offset += bytesRead;
        // The backing read buffer is reused; expose a stable chunk to consumers.
        yield value.slice();
      }
      const final = await handle.stat();
      if (final.size !== initial.size) {
        throw new ObjectIntegrityError('length', 'Object changed while it was being read');
      }
      validator.finish();
      if (digest.digest('hex') !== object.sha256) {
        throw new ObjectIntegrityError('digest', 'Object digest does not match its declaration');
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async deleteStaged(object: StoredObject): Promise<void> {
    if (!object.key.startsWith('staging/')) throw new Error('Only staged objects can be deleted');
    await rm(this.path(object.key), { force: true });
  }
}

export class FileSystemFinalObjectDeleter implements FinalObjectDeleter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    return assertPathInside(this.root, join(this.root, validateKey(key)));
  }

  async health(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async deleteFinal(object: StoredObject, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const expected = immutableObjectKey(
      object.key.split('/')[1] ?? '',
      object.sha256,
      object.mediaType,
    );
    if (object.key !== expected) throw new Error('Final delete key does not match object identity');
    await rm(this.path(object.key), { force: true });
  }
}

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  readonly region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  readonly forcePathStyle?: boolean;
}

type RemoteBody =
  | AsyncIterable<Uint8Array | Buffer | string>
  | { readonly transformToByteArray: () => Promise<Uint8Array> };

function isStringChunk(chunk: Uint8Array | Buffer | string): chunk is string {
  return typeof chunk === 'string';
}

function isAsyncIterableBody(
  body: RemoteBody,
): body is AsyncIterable<Uint8Array | Buffer | string> {
  return (
    typeof body === 'object' &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === 'function'
  );
}

async function* remoteBodyChunks(body: RemoteBody): AsyncGenerator<Uint8Array> {
  if (isAsyncIterableBody(body)) {
    for await (const chunk of body) {
      yield isStringChunk(chunk) ? Buffer.from(chunk) : new Uint8Array(chunk);
    }
    return;
  }
  yield new Uint8Array(await body.transformToByteArray());
}

function s3ClientConfig(options: S3ObjectStoreOptions): S3ClientConfig {
  const config: S3ClientConfig = {
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.forcePathStyle,
  };
  if (options.accessKeyId && options.secretAccessKey) {
    config.credentials = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    };
  }
  return config;
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

interface AwsServiceError {
  readonly $metadata: { readonly httpStatusCode: number };
}

function isAwsServiceError<T>(error: T): error is T & AwsServiceError {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    typeof error.$metadata === 'object' &&
    error.$metadata !== null &&
    'httpStatusCode' in error.$metadata &&
    typeof error.$metadata.httpStatusCode === 'number'
  );
}

function conditionalStatus<T>(error: T): number | undefined {
  return isAwsServiceError(error) ? error.$metadata.httpStatusCode : undefined;
}

function isConditionalWriteConflict<T>(error: T): boolean {
  const status = conditionalStatus(error);
  if (status === 409 || status === 412) return true;
  if (!(error instanceof Error)) return false;
  return ['ConditionalRequestConflict', 'PreconditionFailed'].includes(error.name);
}

export class S3ObjectStore implements ImmutableObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly options: S3ObjectStoreOptions,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client(s3ClientConfig(options));
  }

  async health(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
  }

  async putStaged(
    uploadId: string,
    expectedHash: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<StoredObject> {
    return this.putStagedStream(
      uploadId,
      expectedHash,
      singleChunk(bytes),
      bytes.byteLength,
      mediaType,
    );
  }

  async putStagedStream(
    uploadId: string,
    expectedHash: string,
    source: AsyncIterable<Uint8Array>,
    expectedByteLength: number,
    mediaType: string,
  ): Promise<StoredObject> {
    validateIdentifier(uploadId, 'upload ID');
    validateHash(expectedHash);
    const key = stagingObjectKey(uploadId, expectedHash, mediaType);
    const temporaryKey = `staging/${uploadId}/.${randomUUID()}.tmp`;
    try {
      const temporary = await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: temporaryKey,
          Body: Readable.from(
            validatedObjectStream(source, expectedHash, expectedByteLength, mediaType),
          ),
          ContentLength: expectedByteLength,
          ContentType: mediaType,
          Metadata: { sha256: expectedHash },
        }),
      );
      if (!temporary.ETag) throw new Error(`S3 did not return an ETag for ${temporaryKey}`);
      const object = { key, sha256: expectedHash, byteLength: expectedByteLength, mediaType };
      await this.copyImmutable(temporaryKey, temporary.ETag, object);
      return object;
    } finally {
      await this.client
        .send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: temporaryKey }))
        .catch(() => undefined);
    }
  }

  async verify(object: StoredObject): Promise<boolean> {
    return (await this.verifiedObject(object)) !== undefined;
  }

  private async verifiedObject(
    object: StoredObject,
  ): Promise<{ readonly etag: string } | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: validateKey(object.key) }),
      );
      if (!response.Body || !response.ETag) return undefined;
      if (
        response.ContentType?.trim().toLowerCase() !== object.mediaType ||
        response.Metadata?.sha256 !== object.sha256
      ) {
        return undefined;
      }
      const digest = createHash('sha256');
      const validator = new ObjectMediaStreamValidator(object.mediaType, object.byteLength);
      for await (const chunk of remoteBodyChunks(response.Body)) {
        validator.write(chunk);
        digest.update(chunk);
      }
      validator.finish();
      return digest.digest('hex') === object.sha256 ? { etag: response.ETag } : undefined;
    } catch {
      return undefined;
    }
  }

  private async copyImmutable(
    sourceKey: string,
    sourceEtag: string,
    destination: StoredObject,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.client.send(
          new CopyObjectCommand({
            Bucket: this.options.bucket,
            Key: destination.key,
            CopySource: copySource(this.options.bucket, sourceKey),
            CopySourceIfMatch: sourceEtag,
            IfNoneMatch: '*',
            ContentType: destination.mediaType,
            Metadata: { sha256: destination.sha256 },
            MetadataDirective: 'REPLACE',
          }),
        );
        if (!(await this.verify(destination))) {
          throw new Error(`S3 immutable object failed verification: ${destination.key}`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (!isConditionalWriteConflict(error)) throw error;
        if (await this.verify(destination)) return;
        if (conditionalStatus(error) === 409 && attempt < 3) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10 * 2 ** attempt));
          continue;
        }
        break;
      }
    }
    throw new Error(
      `Immutable S3 object conflict at ${destination.key}; refusing to overwrite existing content or metadata`,
      { cause: lastError },
    );
  }

  async promote(staged: StoredObject, workspaceId: string): Promise<StoredObject> {
    const verified = await this.verifiedObject(staged);
    if (!verified) throw new Error(`Staged object failed integrity verification: ${staged.key}`);
    const key = immutableObjectKey(workspaceId, staged.sha256, staged.mediaType);
    const promoted = { ...staged, key };
    await this.copyImmutable(staged.key, verified.etag, promoted);
    return promoted;
  }

  async read(object: StoredObject): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: validateKey(object.key) }),
    );
    if (!response.Body) throw new Error(`S3 object has no body: ${object.key}`);
    if (
      response.ContentType?.trim().toLowerCase() !== object.mediaType ||
      response.Metadata?.sha256 !== object.sha256
    ) {
      throw new Error(`S3 object metadata failed integrity verification: ${object.key}`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of remoteBodyChunks(response.Body)) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const validator = new ObjectMediaStreamValidator(object.mediaType, object.byteLength);
    validator.write(bytes);
    validator.finish();
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== object.sha256)
      throw new Error(`S3 object failed integrity verification: ${object.key}`);
    return bytes;
  }

  async *readStream(object: StoredObject): AsyncGenerator<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: validateKey(object.key) }),
    );
    if (!response.Body) throw new Error(`S3 object has no body: ${object.key}`);
    if (
      response.ContentType?.trim().toLowerCase() !== object.mediaType ||
      response.Metadata?.sha256 !== object.sha256 ||
      (response.ContentLength !== undefined && response.ContentLength !== object.byteLength)
    ) {
      throw new Error(`S3 object metadata failed integrity verification: ${object.key}`);
    }
    const validator = new ObjectMediaStreamValidator(object.mediaType, object.byteLength);
    const digest = createHash('sha256');
    let total = 0;
    for await (const chunk of remoteBodyChunks(response.Body)) {
      total += chunk.byteLength;
      if (total > object.byteLength) {
        throw new ObjectIntegrityError('length', 'Object exceeds its declared byte length');
      }
      validator.write(chunk);
      digest.update(chunk);
      yield chunk;
    }
    if (total !== object.byteLength) {
      throw new ObjectIntegrityError('length', 'Object byte length does not match its declaration');
    }
    validator.finish();
    if (digest.digest('hex') !== object.sha256) {
      throw new ObjectIntegrityError('digest', 'Object digest does not match its declaration');
    }
  }

  async deleteStaged(object: StoredObject): Promise<void> {
    if (!object.key.startsWith('staging/')) throw new Error('Only staged objects can be deleted');
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: object.key }),
    );
  }
}

/** S3 client backed by a distinct credential that only needs final-object DeleteObject. */
export class S3FinalObjectDeleter implements FinalObjectDeleter {
  private readonly client: S3Client;

  constructor(
    private readonly options: S3ObjectStoreOptions,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client(s3ClientConfig(options));
  }

  async health(): Promise<void> {
    // Delete-only IAM policies intentionally cannot HeadBucket. Configuration
    // is validated by a bounded, identity-exact deletion when a claim exists.
  }

  async deleteFinal(object: StoredObject, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const workspaceId = object.key.split('/')[1] ?? '';
    if (object.key !== immutableObjectKey(workspaceId, object.sha256, object.mediaType)) {
      throw new Error('Final delete key does not match object identity');
    }
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: validateKey(object.key) }),
      { abortSignal: signal },
    );
  }
}
