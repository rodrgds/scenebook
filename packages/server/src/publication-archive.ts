import { createHash } from 'node:crypto';

import { MAX_PUBLICATION_FILES, type PublicationInventory } from '@scenebook/schema';
import { Unzip, UnzipInflate } from 'fflate';

const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const MAX_PUBLICATION_PATH_BYTES = 1_024;
const MAX_CENTRAL_DIRECTORY_BYTES =
  MAX_PUBLICATION_FILES * (CENTRAL_HEADER_BYTES + MAX_PUBLICATION_PATH_BYTES) +
  END_OF_CENTRAL_DIRECTORY_BYTES;
const DETERMINISTIC_FLAGS = 0x000a;
const DETERMINISTIC_COMPRESSION = 8;
const DETERMINISTIC_DOS_TIME = 0;
const DETERMINISTIC_DOS_DATE = 33;
const DETERMINISTIC_VERSION = 20;
const DETERMINISTIC_UNIX_MODE = 0o100644;
const DETERMINISTIC_EXTERNAL_ATTRIBUTES = (DETERMINISTIC_UNIX_MODE << 16) >>> 0;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class PublicationArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationArchiveIntegrityError';
  }
}

function fail(message: string): never {
  throw new PublicationArchiveIntegrityError(message);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

class BoundedTail {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const copy = bytes.slice();
    this.chunks.push(copy);
    this.length += copy.byteLength;
    while (this.length > MAX_CENTRAL_DIRECTORY_BYTES && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.length - MAX_CENTRAL_DIRECTORY_BYTES;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.length -= first.byteLength;
      } else {
        this.chunks[0] = first.slice(excess);
        this.length -= excess;
      }
    }
  }

  bytes(): Uint8Array {
    const value = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      value.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return value;
  }
}

interface VerifiedMember {
  readonly path: string;
  readonly byteLength: number;
  readonly crc32: number;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(
    0,
    bytes.byteLength - END_OF_CENTRAL_DIRECTORY_BYTES - MAX_ZIP_COMMENT_BYTES,
  );
  for (
    let offset = bytes.byteLength - END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= minimum;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return fail('Publication archive has no valid end-of-central-directory record');
}

function verifyCentralDirectory(
  tail: Uint8Array,
  archiveByteLength: number,
  inventory: PublicationInventory,
  members: readonly VerifiedMember[],
): void {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const eocd = findEndOfCentralDirectory(tail);
  if (eocd + END_OF_CENTRAL_DIRECTORY_BYTES !== tail.byteLength) {
    fail('Publication archive has a comment or trailing bytes');
  }
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries !== inventory.files.length ||
    totalEntries !== members.length ||
    commentLength !== 0 ||
    centralSize > MAX_CENTRAL_DIRECTORY_BYTES ||
    centralOffset + centralSize + END_OF_CENTRAL_DIRECTORY_BYTES !== archiveByteLength
  ) {
    fail('Publication archive central-directory bounds or counts are invalid');
  }
  const tailOffset = archiveByteLength - tail.byteLength;
  const centralStart = centralOffset - tailOffset;
  if (centralStart < 0 || centralStart + centralSize !== eocd) {
    fail('Publication archive central directory exceeds the bounded verifier window');
  }

  let cursor = centralStart;
  let expectedLocalOffset = 0;
  for (const [index, expected] of inventory.files.entries()) {
    if (cursor + CENTRAL_HEADER_BYTES > eocd || view.getUint32(cursor, true) !== 0x02014b50) {
      fail('Publication archive contains a malformed central-directory entry');
    }
    const madeBy = view.getUint16(cursor + 4, true);
    const versionNeeded = view.getUint16(cursor + 6, true);
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const modifiedTime = view.getUint16(cursor + 12, true);
    const modifiedDate = view.getUint16(cursor + 14, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const originalSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const internalAttributes = view.getUint16(cursor + 36, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const end = cursor + CENTRAL_HEADER_BYTES + nameLength + extraLength + entryCommentLength;
    if (end > eocd) fail('Publication archive central-directory entry exceeds its bounds');
    let name: string;
    try {
      name = utf8.decode(
        tail.subarray(cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength),
      );
    } catch {
      return fail('Publication archive member path is not valid UTF-8');
    }
    const member = members[index];
    if (
      madeBy >>> 8 !== 3 ||
      (madeBy & 0xff) !== DETERMINISTIC_VERSION ||
      versionNeeded !== DETERMINISTIC_VERSION ||
      flags !== DETERMINISTIC_FLAGS ||
      compression !== DETERMINISTIC_COMPRESSION ||
      modifiedTime !== DETERMINISTIC_DOS_TIME ||
      modifiedDate !== DETERMINISTIC_DOS_DATE ||
      extraLength !== 0 ||
      entryCommentLength !== 0 ||
      diskStart !== 0 ||
      internalAttributes !== 0 ||
      externalAttributes !== DETERMINISTIC_EXTERNAL_ATTRIBUTES ||
      localOffset !== expectedLocalOffset ||
      name !== expected.path ||
      originalSize !== expected.byteLength ||
      member?.path !== expected.path ||
      member.byteLength !== expected.byteLength ||
      member.crc32 !== crc32
    ) {
      fail(`Publication archive member metadata is not deterministic: ${expected.path}`);
    }
    expectedLocalOffset = localOffset + 30 + nameLength + compressedSize + 16;
    cursor = end;
  }
  if (cursor !== eocd || expectedLocalOffset !== centralOffset) {
    fail('Publication archive local and central directory boundaries do not match');
  }
}

/**
 * Streams and verifies the exact deterministic ZIP emitted by the hosted CLI.
 * No member bytes are retained: only per-member hashes and the bounded central
 * directory tail remain in memory.
 */
export async function verifyPublicationArchive(
  source: AsyncIterable<Uint8Array>,
  inventory: PublicationInventory,
): Promise<void> {
  const tail = new BoundedTail();
  const members: VerifiedMember[] = [];
  let archiveByteLength = 0;
  let totalUncompressedBytes = 0;
  let failure: PublicationArchiveIntegrityError | undefined;
  const unzip = new Unzip((file) => {
    if (failure) return;
    const expected = inventory.files[members.length];
    if (
      !expected ||
      file.name !== expected.path ||
      file.compression !== DETERMINISTIC_COMPRESSION ||
      (file.originalSize !== undefined && file.originalSize !== expected.byteLength)
    ) {
      failure = new PublicationArchiveIntegrityError(
        `Publication archive member does not match inventory order: ${file.name}`,
      );
      file.terminate();
      return;
    }
    const digest = createHash('sha256');
    let byteLength = 0;
    let crc32 = 0xffffffff;
    file.ondata = (error, bytes, final) => {
      if (failure) return;
      if (error) {
        failure = new PublicationArchiveIntegrityError(
          `Publication archive member could not be decoded: ${file.name}`,
        );
        return;
      }
      byteLength += bytes.byteLength;
      totalUncompressedBytes += bytes.byteLength;
      if (byteLength > expected.byteLength || totalUncompressedBytes > inventory.byteLength) {
        failure = new PublicationArchiveIntegrityError(
          `Publication archive member exceeds its declared size: ${file.name}`,
        );
        file.terminate();
        return;
      }
      digest.update(bytes);
      crc32 = updateCrc32(crc32, bytes);
      if (final) {
        const actualDigest = digest.digest('hex');
        if (byteLength !== expected.byteLength || actualDigest !== expected.sha256) {
          failure = new PublicationArchiveIntegrityError(
            `Publication archive member bytes do not match inventory: ${file.name}`,
          );
          return;
        }
        members.push({ path: file.name, byteLength, crc32: (crc32 ^ 0xffffffff) >>> 0 });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for await (const chunk of source) {
    archiveByteLength += chunk.byteLength;
    tail.push(chunk);
    try {
      unzip.push(chunk, false);
    } catch {
      throw new PublicationArchiveIntegrityError('Publication archive could not be decoded');
    }
    if (failure) throw failure;
  }
  try {
    unzip.push(new Uint8Array(), true);
  } catch {
    throw new PublicationArchiveIntegrityError('Publication archive could not be decoded');
  }
  if (failure) throw failure;
  if (
    members.length !== inventory.files.length ||
    totalUncompressedBytes !== inventory.byteLength
  ) {
    fail('Publication archive does not contain the exact inventory member set');
  }
  verifyCentralDirectory(tail.bytes(), archiveByteLength, inventory, members);
}
