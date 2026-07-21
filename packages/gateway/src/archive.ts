import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJsonHash } from '@scenebook/core';
import {
  immutableObjectKey,
  type HostedPublicationRecord,
  type ImmutableObjectStore,
  type StoredObject,
} from '@scenebook/server';
import {
  PublicationInventorySchema,
  type PublicationFile,
  type PublicationInventory,
  type ReleasePublication,
} from '@scenebook/schema';
import { Unzip, UnzipInflate } from 'fflate';

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class PublicationUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublicationUnavailableError';
  }
}

function sameObject(
  left: { readonly sha256: string; readonly byteLength: number; readonly mediaType: string },
  right: { readonly sha256: string; readonly byteLength: number; readonly mediaType: string },
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength &&
    left.mediaType === right.mediaType
  );
}

function storedObject(
  workspaceId: string,
  value: { readonly sha256: string; readonly byteLength: number; readonly mediaType: string },
): StoredObject {
  return {
    ...value,
    key: immutableObjectKey(workspaceId, value.sha256, value.mediaType),
  };
}

export interface BoundPublication {
  readonly route: HostedPublicationRecord;
  readonly publication: ReleasePublication;
  readonly inventory: PublicationInventory;
  readonly archiveObject: StoredObject;
  readonly files: ReadonlyMap<string, PublicationFile>;
}

export function assertCurrentPublication(route: HostedPublicationRecord): ReleasePublication {
  const { channel, release } = route;
  if (
    (channel.kind !== 'public-catalog' && channel.kind !== 'private-portal') ||
    !channel.currentReleaseId ||
    !release ||
    release.workspaceId !== channel.workspaceId ||
    release.projectId !== channel.projectId ||
    release.release.id !== channel.currentReleaseId ||
    release.release.channelId !== channel.id ||
    release.release.sequence !== channel.sequence ||
    release.release.status !== 'published' ||
    !release.release.publication
  ) {
    throw new PublicationUnavailableError('Hosted route has no consistent current publication');
  }
  if (route.customDomain) {
    const domain = route.customDomain;
    const provisioning = domain.provisioning;
    if (
      domain.status !== 'active' ||
      domain.workspaceId !== channel.workspaceId ||
      domain.projectId !== channel.projectId ||
      domain.channelId !== channel.id ||
      domain.dnsProof.status !== 'verified' ||
      !provisioning ||
      provisioning.desiredState !== 'active' ||
      provisioning.certificate !== 'ready' ||
      provisioning.routing !== 'ready'
    ) {
      throw new PublicationUnavailableError('Custom domain is not fully active');
    }
  }
  return release.release.publication;
}

export async function loadBoundPublication(
  objectStore: ImmutableObjectStore,
  route: HostedPublicationRecord,
): Promise<BoundPublication> {
  const publication = assertCurrentPublication(route);
  const inventoryObject = storedObject(route.workspace.id, publication.inventory);
  let bytes: Uint8Array;
  try {
    bytes = await objectStore.read(inventoryObject);
  } catch (error) {
    throw new PublicationUnavailableError('Publication inventory failed immutable storage checks', {
      cause: error,
    });
  }
  let inventory: PublicationInventory;
  try {
    inventory = PublicationInventorySchema.parse(JSON.parse(utf8.decode(bytes)));
  } catch (error) {
    throw new PublicationUnavailableError('Publication inventory is invalid', { cause: error });
  }
  const inventoryManifest = {
    sha256: inventory.compilerManifest.sha256,
    byteLength: inventory.compilerManifest.byteLength,
    mediaType: inventory.compilerManifest.mediaType,
  };
  if (
    !sameObject(inventory.archive, publication.archive) ||
    !sameObject(inventoryManifest, publication.compilerManifest) ||
    inventory.treeHash !== publication.treeHash ||
    canonicalJsonHash({ files: inventory.files }) !== inventory.treeHash
  ) {
    throw new PublicationUnavailableError(
      'Publication inventory does not match the current Release',
    );
  }
  return {
    route,
    publication,
    inventory,
    archiveObject: storedObject(route.workspace.id, publication.archive),
    files: new Map(inventory.files.map((file) => [file.path, file])),
  };
}

export interface ExtractedPublicationMember {
  readonly path: string;
  readonly descriptor: PublicationFile;
  dispose(): Promise<void>;
}

function sourceFor(
  objectStore: ImmutableObjectStore,
  object: StoredObject,
): AsyncIterable<Uint8Array> {
  if (objectStore.readStream) return objectStore.readStream(object);
  return (async function* () {
    yield await objectStore.read(object);
  })();
}

/**
 * Extracts exactly one inventory-owned regular member into a private temporary
 * file. Every archive member is streamed, bounded, and hash-checked first, so
 * corrupt bytes are never placed on the HTTP response stream.
 */
export async function extractPublicationMember(
  objectStore: ImmutableObjectStore,
  bound: BoundPublication,
  memberPath: string,
  options: { readonly temporaryRoot: string; readonly maxMemberBytes: number },
): Promise<ExtractedPublicationMember> {
  const descriptor = bound.files.get(memberPath);
  if (!descriptor) throw new PublicationUnavailableError('Publication member is not inventoried');
  if (bound.inventory.files.some((file) => file.byteLength > options.maxMemberBytes)) {
    throw new PublicationUnavailableError('Publication member exceeds the gateway serving limit');
  }

  const root = resolve(options.temporaryRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'member-'));
  const outputPath = join(directory, 'payload');
  const handle = await open(
    outputPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  let outputOpen = true;
  let failure: unknown;
  let nextMember = 0;
  let totalBytes = 0;
  let targetSeen = false;
  const unzip = new Unzip((file) => {
    if (failure) return;
    const expected = bound.inventory.files[nextMember];
    if (
      !expected ||
      file.name !== expected.path ||
      file.compression !== 8 ||
      (file.originalSize !== undefined && file.originalSize !== expected.byteLength)
    ) {
      failure = new PublicationUnavailableError('Publication archive member set is inconsistent');
      file.terminate();
      return;
    }
    const digest = createHash('sha256');
    let length = 0;
    file.ondata = (error, bytes, final) => {
      if (failure) return;
      if (error) {
        failure = new PublicationUnavailableError('Publication archive could not be decoded');
        return;
      }
      try {
        length += bytes.byteLength;
        totalBytes += bytes.byteLength;
        if (length > expected.byteLength || totalBytes > bound.inventory.byteLength) {
          throw new PublicationUnavailableError('Publication archive exceeds inventory bounds');
        }
        digest.update(bytes);
        if (expected.path === memberPath && bytes.byteLength > 0) {
          let offset = 0;
          while (offset < bytes.byteLength) {
            const written = writeSync(handle.fd, bytes, offset, bytes.byteLength - offset);
            if (written === 0) throw new Error('Temporary publication write made no progress');
            offset += written;
          }
        }
        if (final) {
          if (length !== expected.byteLength || digest.digest('hex') !== expected.sha256) {
            throw new PublicationUnavailableError(
              'Publication archive member failed integrity checks',
            );
          }
          if (expected.path === memberPath) targetSeen = true;
          nextMember += 1;
        }
      } catch (caught) {
        failure = caught;
        file.terminate();
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of sourceFor(objectStore, bound.archiveObject)) {
      try {
        unzip.push(chunk, false);
      } catch (error) {
        throw new PublicationUnavailableError('Publication archive could not be decoded', {
          cause: error,
        });
      }
      if (failure) throw failure;
    }
    try {
      unzip.push(new Uint8Array(), true);
    } catch (error) {
      throw new PublicationUnavailableError('Publication archive could not be decoded', {
        cause: error,
      });
    }
    if (failure) throw failure;
    if (
      !targetSeen ||
      nextMember !== bound.inventory.files.length ||
      totalBytes !== bound.inventory.byteLength
    ) {
      throw new PublicationUnavailableError('Publication archive does not match its inventory');
    }
    await handle.close();
    outputOpen = false;
    return {
      path: outputPath,
      descriptor,
      dispose: async () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (outputOpen) {
      await handle.close().catch(() => undefined);
      outputOpen = false;
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function createExactFileStream(
  file: ExtractedPublicationMember,
  start: number,
  endInclusive: number,
  onDone: () => void,
): Promise<ReadableStream<Uint8Array>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size !== file.descriptor.byteLength) {
      throw new PublicationUnavailableError('Extracted publication member changed before serving');
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await file.dispose().catch(() => undefined);
    onDone();
    if (error instanceof PublicationUnavailableError) throw error;
    throw new PublicationUnavailableError('Extracted publication member could not be opened', {
      cause: error,
    });
  }
  if (!handle) {
    await file.dispose().catch(() => undefined);
    onDone();
    throw new PublicationUnavailableError('Extracted publication member could not be opened');
  }
  let offset = start;
  let closed = false;
  const finish = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
    await file.dispose().catch(() => undefined);
    onDone();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset > endInclusive) {
        controller.close();
        await finish();
        return;
      }
      try {
        const size = Math.min(64 * 1024, endInclusive - offset + 1);
        const buffer = new Uint8Array(size);
        const { bytesRead } = await handle.read(buffer, 0, size, offset);
        if (bytesRead === 0) throw new Error('Extracted publication member ended early');
        offset += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        controller.error(error);
        await finish();
      }
    },
    async cancel() {
      await finish();
    },
  });
}

export async function readExactPublicationFile(
  file: ExtractedPublicationMember,
  onDone: () => void,
): Promise<Uint8Array<ArrayBuffer>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size !== file.descriptor.byteLength) {
      throw new PublicationUnavailableError('Extracted publication member changed before serving');
    }
    const bytes = new Uint8Array(file.descriptor.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) {
        throw new PublicationUnavailableError('Extracted publication member ended early');
      }
      offset += bytesRead;
    }
    const final = await handle.stat();
    if (
      !final.isFile() ||
      final.size !== file.descriptor.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== file.descriptor.sha256
    ) {
      throw new PublicationUnavailableError('Extracted publication member failed integrity checks');
    }
    return bytes;
  } catch (error) {
    if (error instanceof PublicationUnavailableError) throw error;
    throw new PublicationUnavailableError('Extracted publication member could not be read', {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
    await file.dispose().catch(() => undefined);
    onDone();
  }
}

interface PublicationCacheEntry {
  readonly key: string;
  readonly directory: string;
  readonly byteLength: number;
  readonly files: ReadonlyMap<string, string>;
  references: number;
  lastUsed: number;
}

async function materializePublicationArchive(
  objectStore: ImmutableObjectStore,
  bound: BoundPublication,
  root: string,
  key: string,
  maximumMemberBytes: number,
): Promise<PublicationCacheEntry> {
  if (bound.inventory.files.some((file) => file.byteLength > maximumMemberBytes)) {
    throw new PublicationUnavailableError('Publication member exceeds the gateway serving limit');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'cache-'));
  const paths = new Map<string, string>();
  let failure: unknown;
  let nextMember = 0;
  let totalBytes = 0;
  let currentDescriptor: number | undefined;
  const unzip = new Unzip((file) => {
    if (failure) return;
    const index = nextMember;
    const expected = bound.inventory.files[index];
    if (
      !expected ||
      file.name !== expected.path ||
      file.compression !== 8 ||
      (file.originalSize !== undefined && file.originalSize !== expected.byteLength)
    ) {
      failure = new PublicationUnavailableError('Publication archive member set is inconsistent');
      file.terminate();
      return;
    }
    const outputPath = join(directory, `${String(index).padStart(6, '0')}-${expected.sha256}`);
    try {
      currentDescriptor = openSync(
        outputPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      failure = error;
      file.terminate();
      return;
    }
    const digest = createHash('sha256');
    let length = 0;
    file.ondata = (error, bytes, final) => {
      if (failure) return;
      try {
        if (error)
          throw new PublicationUnavailableError('Publication archive could not be decoded');
        length += bytes.byteLength;
        totalBytes += bytes.byteLength;
        if (length > expected.byteLength || totalBytes > bound.inventory.byteLength) {
          throw new PublicationUnavailableError('Publication archive exceeds inventory bounds');
        }
        digest.update(bytes);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(currentDescriptor!, bytes, offset, bytes.byteLength - offset);
          if (written === 0) throw new Error('Publication cache write made no progress');
          offset += written;
        }
        if (final) {
          if (length !== expected.byteLength || digest.digest('hex') !== expected.sha256) {
            throw new PublicationUnavailableError(
              'Publication archive member failed integrity checks',
            );
          }
          closeSync(currentDescriptor!);
          currentDescriptor = undefined;
          paths.set(expected.path, outputPath);
          nextMember += 1;
        }
      } catch (caught) {
        failure = caught;
        if (currentDescriptor !== undefined) {
          closeSync(currentDescriptor);
          currentDescriptor = undefined;
        }
        file.terminate();
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of sourceFor(objectStore, bound.archiveObject)) {
      try {
        unzip.push(chunk, false);
      } catch (error) {
        throw new PublicationUnavailableError('Publication archive could not be decoded', {
          cause: error,
        });
      }
      if (failure) throw failure;
    }
    try {
      unzip.push(new Uint8Array(), true);
    } catch (error) {
      throw new PublicationUnavailableError('Publication archive could not be decoded', {
        cause: error,
      });
    }
    if (failure) throw failure;
    if (
      nextMember !== bound.inventory.files.length ||
      paths.size !== bound.inventory.files.length ||
      totalBytes !== bound.inventory.byteLength
    ) {
      throw new PublicationUnavailableError('Publication archive does not match its inventory');
    }
    return {
      key,
      directory,
      byteLength: bound.inventory.byteLength,
      files: paths,
      references: 0,
      lastUsed: 0,
    };
  } catch (error) {
    if (currentDescriptor !== undefined) closeSync(currentDescriptor);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Bounded process-local LRU of fully verified uncompressed archives. Files are
 * named by index and digest, never by archive paths. Authorization and current
 * Release resolution happen before every lookup, so cached bytes cannot grant
 * access or preserve a revoked/old Channel pointer.
 */
export class PublicationArchiveCache {
  private readonly entries = new Map<string, PublicationCacheEntry>();
  private readonly inflight = new Map<string, Promise<PublicationCacheEntry | undefined>>();
  private byteLength = 0;
  private reservedBytes = 0;
  private clock = 0;

  constructor(
    private readonly temporaryRoot: string,
    private readonly maximumBytes: number,
    private readonly maximumMemberBytes: number,
  ) {}

  private async reserve(bytes: number): Promise<boolean> {
    if (bytes > this.maximumBytes) return false;
    const evicted: PublicationCacheEntry[] = [];
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.references === 0)
      .sort((left, right) => left.lastUsed - right.lastUsed);
    while (this.byteLength + this.reservedBytes + bytes > this.maximumBytes) {
      const entry = candidates.shift();
      if (!entry) return false;
      if (!this.entries.delete(entry.key)) continue;
      this.byteLength -= entry.byteLength;
      evicted.push(entry);
    }
    this.reservedBytes += bytes;
    await Promise.all(
      evicted.map((entry) => rm(entry.directory, { recursive: true, force: true })),
    );
    return true;
  }

  private async create(
    objectStore: ImmutableObjectStore,
    bound: BoundPublication,
    key: string,
  ): Promise<PublicationCacheEntry | undefined> {
    if (bound.inventory.files.some((file) => file.byteLength > this.maximumMemberBytes)) {
      return undefined;
    }
    const bytes = bound.inventory.byteLength;
    if (!(await this.reserve(bytes))) return undefined;
    try {
      const entry = await materializePublicationArchive(
        objectStore,
        bound,
        resolve(this.temporaryRoot),
        key,
        this.maximumMemberBytes,
      );
      this.reservedBytes -= bytes;
      this.byteLength += bytes;
      this.entries.set(key, entry);
      return entry;
    } catch (error) {
      this.reservedBytes -= bytes;
      throw error;
    }
  }

  async acquire(
    objectStore: ImmutableObjectStore,
    bound: BoundPublication,
    memberPath: string,
  ): Promise<ExtractedPublicationMember | undefined> {
    const descriptor = bound.files.get(memberPath);
    if (!descriptor) return undefined;
    if (bound.inventory.files.some((file) => file.byteLength > this.maximumMemberBytes)) {
      return undefined;
    }
    const key = `${bound.route.workspace.id}\0${bound.archiveObject.sha256}\0${bound.inventory.treeHash}`;
    let entry = this.entries.get(key);
    if (!entry) {
      let pending = this.inflight.get(key);
      if (!pending) {
        pending = this.create(objectStore, bound, key);
        this.inflight.set(key, pending);
        void pending.then(
          () => this.inflight.delete(key),
          () => this.inflight.delete(key),
        );
      }
      entry = await pending;
    }
    if (!entry) return undefined;
    const path = entry.files.get(memberPath);
    if (!path) throw new PublicationUnavailableError('Cached publication inventory is incomplete');
    entry.references += 1;
    entry.lastUsed = ++this.clock;
    let disposed = false;
    return {
      path,
      descriptor,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        entry!.references -= 1;
        entry!.lastUsed = ++this.clock;
      },
    };
  }
}

export class PublicationResponsePool {
  private active = 0;

  constructor(private readonly maximum: number) {}

  acquire(): (() => void) | undefined {
    if (this.active >= this.maximum) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}
