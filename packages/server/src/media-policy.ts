const utf8 = new TextDecoder('utf-8', { fatal: true });

export const ALLOWED_OBJECT_MEDIA_TYPES = [
  'application/json',
  'application/pdf',
  'application/zip',
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/markdown',
  'text/plain',
  'video/mp4',
  'video/webm',
] as const;

export type AllowedObjectMediaType = (typeof ALLOWED_OBJECT_MEDIA_TYPES)[number];

const allowedMediaTypes = new Set<string>(ALLOWED_OBJECT_MEDIA_TYPES);
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM_SIGNATURE = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);
const STREAM_PREFIX_BYTES = 4_096;
const STREAM_TAIL_BYTES = 1_024;
export const MAX_BUFFERED_TEXT_OBJECT_BYTES = 8 * 1024 * 1024;

export class ObjectMediaPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectMediaPolicyError';
  }
}

export function isAllowedObjectMediaType(value: string): value is AllowedObjectMediaType {
  return allowedMediaTypes.has(value);
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start = 0, end = bytes.byteLength): string {
  return Buffer.from(bytes.subarray(start, end)).toString('ascii');
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isPng(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, PNG_SIGNATURE)) return false;
  const data = view(bytes);
  let offset = PNG_SIGNATURE.byteLength;
  let first = true;
  while (offset + 12 <= bytes.byteLength) {
    const length = data.getUint32(offset, false);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) return false;
    const type = ascii(bytes, offset + 4, offset + 8);
    if (first && (type !== 'IHDR' || length !== 13)) return false;
    first = false;
    if (type === 'IEND') return length === 0 && end === bytes.byteLength;
    offset = end;
  }
  return false;
}

function isJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.byteLength - 2] === 0xff &&
    bytes[bytes.byteLength - 1] === 0xd9
  );
}

function isWebp(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 20 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 12) !== 'WEBP' ||
    !['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 16))
  ) {
    return false;
  }
  return view(bytes).getUint32(4, true) + 8 === bytes.byteLength;
}

function isGif(bytes: Uint8Array): boolean {
  const header = ascii(bytes, 0, 6);
  return (
    bytes.byteLength >= 14 &&
    (header === 'GIF87a' || header === 'GIF89a') &&
    bytes[bytes.byteLength - 1] === 0x3b
  );
}

function isoBmffBrands(bytes: Uint8Array): ReadonlySet<string> | undefined {
  const brands = new Set<string>();
  const data = view(bytes);
  let offset = 0;
  let foundFileType = false;
  while (offset + 8 <= bytes.byteLength) {
    const size32 = data.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, offset + 8);
    let headerLength = 8;
    let size: number;
    if (size32 === 0) {
      size = bytes.byteLength - offset;
    } else if (size32 === 1) {
      if (offset + 16 > bytes.byteLength) return undefined;
      const extended = data.getBigUint64(offset + 8, false);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      size = Number(extended);
      headerLength = 16;
    } else {
      size = size32;
    }
    if (size < headerLength || offset + size > bytes.byteLength) return undefined;
    if (type === 'ftyp') {
      if (foundFileType || size < headerLength + 8) return undefined;
      foundFileType = true;
      for (let cursor = offset + headerLength; cursor + 4 <= offset + size; cursor += 4) {
        if (cursor === offset + headerLength + 4) continue;
        brands.add(ascii(bytes, cursor, cursor + 4));
      }
    }
    offset += size;
  }
  return foundFileType && offset === bytes.byteLength ? brands : undefined;
}

function isAvif(bytes: Uint8Array): boolean {
  const brands = isoBmffBrands(bytes);
  return brands?.has('avif') === true || brands?.has('avis') === true;
}

function isMp4(bytes: Uint8Array): boolean {
  const brands = isoBmffBrands(bytes);
  if (!brands || brands.has('avif') || brands.has('avis')) return false;
  return ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].some((brand) =>
    brands.has(brand),
  );
}

function isWebm(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, WEBM_SIGNATURE) &&
    ascii(bytes, 0, Math.min(bytes.byteLength, 4_096)).toLowerCase().includes('webm')
  );
}

function isPdf(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 5) !== '%PDF-') return false;
  const tail = ascii(bytes, Math.max(0, bytes.byteLength - 1_024));
  return /%EOF[\x00\t\n\f\r ]*$/u.test(tail);
}

function isZip(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || ascii(bytes, 0, 2) !== 'PK') return false;
  const marker = `${bytes[2]?.toString(16).padStart(2, '0')}${bytes[3]
    ?.toString(16)
    .padStart(2, '0')}`;
  return marker === '0304' || marker === '0506' || marker === '0708';
}

function safeText(bytes: Uint8Array): string | undefined {
  try {
    const value = utf8.decode(bytes);
    return value.includes('\0') ? undefined : value;
  } catch {
    return undefined;
  }
}

function isActiveMarkup(value: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<\?xml\b)/iu.test(value) || /<\/?[a-z][^>]*>/iu.test(value);
}

function isJson(bytes: Uint8Array): boolean {
  const value = safeText(bytes);
  if (value === undefined) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isSafeText(bytes: Uint8Array): boolean {
  const value = safeText(bytes);
  return value !== undefined && !isActiveMarkup(value);
}

function mediaMatches(bytes: Uint8Array, mediaType: AllowedObjectMediaType): boolean {
  switch (mediaType) {
    case 'application/json':
      return isJson(bytes);
    case 'application/pdf':
      return isPdf(bytes);
    case 'application/zip':
      return isZip(bytes);
    case 'image/avif':
      return isAvif(bytes);
    case 'image/gif':
      return isGif(bytes);
    case 'image/jpeg':
      return isJpeg(bytes);
    case 'image/png':
      return isPng(bytes);
    case 'image/webp':
      return isWebp(bytes);
    case 'text/markdown':
    case 'text/plain':
      return isSafeText(bytes);
    case 'video/mp4':
      return isMp4(bytes);
    case 'video/webm':
      return isWebm(bytes);
  }
}

export function assertAllowedObjectMedia(
  bytes: Uint8Array,
  mediaType: string,
): asserts mediaType is AllowedObjectMediaType {
  if (!isAllowedObjectMediaType(mediaType)) {
    throw new ObjectMediaPolicyError(`Object media type is not allowed: ${mediaType}`);
  }
  if (!mediaMatches(bytes, mediaType)) {
    throw new ObjectMediaPolicyError(
      `Object bytes do not match the declared safe media type: ${mediaType}`,
    );
  }
}

function appendTail(current: Uint8Array, chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  if (chunk.byteLength >= STREAM_TAIL_BYTES) {
    const output = new Uint8Array(STREAM_TAIL_BYTES);
    output.set(chunk.subarray(chunk.byteLength - STREAM_TAIL_BYTES));
    return output;
  }
  const keep = Math.min(current.byteLength, STREAM_TAIL_BYTES - chunk.byteLength);
  const output = new Uint8Array(keep + chunk.byteLength);
  output.set(current.subarray(current.byteLength - keep));
  output.set(chunk, keep);
  return output;
}

class PngStreamValidator {
  private phase: 'signature' | 'header' | 'body' | 'done' = 'signature';
  private header = new Uint8Array(8);
  private headerBytes = 0;
  private bodyBytes = 0;
  private first = true;
  private iend = false;

  write(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.phase === 'done') throw new ObjectMediaPolicyError('PNG has bytes after IEND');
      if (this.phase === 'body') {
        const consumed = Math.min(this.bodyBytes, chunk.byteLength - offset);
        this.bodyBytes -= consumed;
        offset += consumed;
        if (this.bodyBytes === 0) {
          this.phase = this.iend ? 'done' : 'header';
          this.headerBytes = 0;
        }
        continue;
      }
      const needed = 8 - this.headerBytes;
      const consumed = Math.min(needed, chunk.byteLength - offset);
      this.header.set(chunk.subarray(offset, offset + consumed), this.headerBytes);
      this.headerBytes += consumed;
      offset += consumed;
      if (this.headerBytes !== 8) continue;
      if (this.phase === 'signature') {
        if (!startsWith(this.header, PNG_SIGNATURE)) {
          throw new ObjectMediaPolicyError('PNG signature is invalid');
        }
        this.phase = 'header';
        this.headerBytes = 0;
        continue;
      }
      const length = view(this.header).getUint32(0, false);
      const type = ascii(this.header, 4, 8);
      if (this.first && (type !== 'IHDR' || length !== 13)) {
        throw new ObjectMediaPolicyError('PNG must begin with a 13-byte IHDR chunk');
      }
      this.first = false;
      this.iend = type === 'IEND';
      if (this.iend && length !== 0) throw new ObjectMediaPolicyError('PNG IEND is invalid');
      this.bodyBytes = length + 4;
      this.phase = 'body';
    }
  }

  finish(): void {
    if (this.phase !== 'done') throw new ObjectMediaPolicyError('PNG is truncated or lacks IEND');
  }

  get bufferedByteLength(): number {
    return this.header.byteLength;
  }
}

class IsoBmffStreamValidator {
  private header = new Uint8Array(16);
  private headerBytes = 0;
  private headerTarget = 8;
  private processed = 0;
  private bodyBytes = 0;
  private ftyp = false;
  private ftypPosition = 0;
  private brand = new Uint8Array(4);
  private brandBytes = 0;
  private foundFtyp = false;
  readonly brands = new Set<string>();

  constructor(private readonly expectedBytes: number) {}

  private ftypBytes(chunk: Uint8Array): void {
    for (const byte of chunk) {
      const position = this.ftypPosition++;
      if (position >= 4 && position < 8) continue;
      this.brand[this.brandBytes++] = byte;
      if (this.brandBytes === 4) {
        this.brands.add(ascii(this.brand));
        this.brandBytes = 0;
      }
    }
  }

  write(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.bodyBytes > 0) {
        const consumed = Math.min(this.bodyBytes, chunk.byteLength - offset);
        if (this.ftyp) this.ftypBytes(chunk.subarray(offset, offset + consumed));
        this.bodyBytes -= consumed;
        this.processed += consumed;
        offset += consumed;
        if (this.bodyBytes === 0) {
          if (this.ftyp && (this.ftypPosition < 8 || this.brandBytes !== 0)) {
            throw new ObjectMediaPolicyError('ISO BMFF ftyp payload is malformed');
          }
          this.ftyp = false;
          this.headerBytes = 0;
          this.headerTarget = 8;
        }
        continue;
      }
      const consumed = Math.min(this.headerTarget - this.headerBytes, chunk.byteLength - offset);
      this.header.set(chunk.subarray(offset, offset + consumed), this.headerBytes);
      this.headerBytes += consumed;
      this.processed += consumed;
      offset += consumed;
      if (this.headerBytes !== this.headerTarget) continue;
      const size32 = view(this.header).getUint32(0, false);
      if (this.headerTarget === 8 && size32 === 1) {
        this.headerTarget = 16;
        continue;
      }
      const type = ascii(this.header, 4, 8);
      const headerLength = this.headerTarget;
      const start = this.processed - headerLength;
      let size: number;
      if (size32 === 0) size = this.expectedBytes - start;
      else if (size32 === 1) {
        const extended = view(this.header).getBigUint64(8, false);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ObjectMediaPolicyError('ISO BMFF box size is unsupported');
        }
        size = Number(extended);
      } else size = size32;
      if (size < headerLength || start + size > this.expectedBytes) {
        throw new ObjectMediaPolicyError('ISO BMFF box boundary is invalid');
      }
      this.bodyBytes = size - headerLength;
      this.ftyp = type === 'ftyp';
      if (this.ftyp) {
        if (this.foundFtyp || this.bodyBytes < 8) {
          throw new ObjectMediaPolicyError('ISO BMFF ftyp box is invalid');
        }
        this.foundFtyp = true;
        this.ftypPosition = 0;
        this.brandBytes = 0;
      }
      if (this.bodyBytes === 0) {
        this.headerBytes = 0;
        this.headerTarget = 8;
      }
    }
  }

  finish(): void {
    if (
      !this.foundFtyp ||
      this.processed !== this.expectedBytes ||
      this.bodyBytes !== 0 ||
      this.headerBytes !== 0
    ) {
      throw new ObjectMediaPolicyError('ISO BMFF object is incomplete');
    }
  }

  get bufferedByteLength(): number {
    return this.header.byteLength + this.brand.byteLength;
  }
}

/** Incremental MIME validation with constant binary buffering and bounded text buffering. */
export class ObjectMediaStreamValidator {
  private readonly prefix = new Uint8Array(STREAM_PREFIX_BYTES);
  private prefixBytes = 0;
  private tail = new Uint8Array();
  private readonly textChunks: Uint8Array[] = [];
  private readonly png?: PngStreamValidator;
  private readonly iso?: IsoBmffStreamValidator;
  private total = 0;

  constructor(
    readonly mediaType: string,
    readonly expectedBytes: number,
  ) {
    if (!isAllowedObjectMediaType(mediaType)) {
      throw new ObjectMediaPolicyError(`Object media type is not allowed: ${mediaType}`);
    }
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      throw new ObjectMediaPolicyError('Object byte length must be a positive safe integer');
    }
    if (
      ['application/json', 'text/markdown', 'text/plain'].includes(mediaType) &&
      expectedBytes > MAX_BUFFERED_TEXT_OBJECT_BYTES
    ) {
      throw new ObjectMediaPolicyError(
        `${mediaType} objects may not exceed ${MAX_BUFFERED_TEXT_OBJECT_BYTES} bytes`,
      );
    }
    if (mediaType === 'image/png') this.png = new PngStreamValidator();
    if (mediaType === 'image/avif' || mediaType === 'video/mp4') {
      this.iso = new IsoBmffStreamValidator(expectedBytes);
    }
  }

  write(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) throw new ObjectMediaPolicyError('Invalid object chunk');
    this.total += chunk.byteLength;
    if (this.total > this.expectedBytes) {
      throw new ObjectMediaPolicyError('Object exceeds its declared byte length');
    }
    const prefixLength = Math.min(chunk.byteLength, this.prefix.byteLength - this.prefixBytes);
    if (prefixLength > 0) {
      this.prefix.set(chunk.subarray(0, prefixLength), this.prefixBytes);
      this.prefixBytes += prefixLength;
    }
    this.tail = appendTail(this.tail, chunk);
    if (['application/json', 'text/markdown', 'text/plain'].includes(this.mediaType)) {
      this.textChunks.push(chunk.slice());
    }
    try {
      this.png?.write(chunk);
      this.iso?.write(chunk);
    } catch (error) {
      if (error instanceof ObjectMediaPolicyError) this.mismatch();
      throw error;
    }
  }

  finish(): void {
    if (this.total !== this.expectedBytes) {
      throw new ObjectMediaPolicyError('Object byte length does not match its declaration');
    }
    try {
      this.png?.finish();
      this.iso?.finish();
    } catch (error) {
      if (error instanceof ObjectMediaPolicyError) this.mismatch();
      throw error;
    }
    const prefix = this.prefix.subarray(0, this.prefixBytes);
    let matches = true;
    // SAFETY: the constructor validates mediaType against AllowedObjectMediaType.
    switch (this.mediaType as AllowedObjectMediaType) {
      case 'application/json':
      case 'text/markdown':
      case 'text/plain': {
        const bytes = Buffer.concat(this.textChunks.map((chunk) => Buffer.from(chunk)));
        matches = this.mediaType === 'application/json' ? isJson(bytes) : isSafeText(bytes);
        break;
      }
      case 'application/pdf':
        matches =
          ascii(prefix, 0, 5) === '%PDF-' && /%EOF[\x00\t\n\f\r ]*$/u.test(ascii(this.tail));
        break;
      case 'application/zip':
        matches = isZip(prefix);
        break;
      case 'image/avif':
        matches = this.iso?.brands.has('avif') === true || this.iso?.brands.has('avis') === true;
        break;
      case 'image/gif':
        matches = isGif(new Uint8Array([...prefix.subarray(0, 13), ...this.tail.slice(-1)]));
        break;
      case 'image/jpeg':
        matches =
          prefix.byteLength >= 2 &&
          prefix[0] === 0xff &&
          prefix[1] === 0xd8 &&
          this.tail.at(-2) === 0xff &&
          this.tail.at(-1) === 0xd9;
        break;
      case 'image/png':
        matches = true;
        break;
      case 'image/webp':
        matches =
          prefix.byteLength >= 20 &&
          ascii(prefix, 0, 4) === 'RIFF' &&
          ascii(prefix, 8, 12) === 'WEBP' &&
          ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(prefix, 12, 16)) &&
          view(prefix).getUint32(4, true) + 8 === this.total;
        break;
      case 'video/mp4':
        matches =
          this.iso !== undefined &&
          !this.iso.brands.has('avif') &&
          !this.iso.brands.has('avis') &&
          ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].some((brand) =>
            this.iso?.brands.has(brand),
          );
        break;
      case 'video/webm':
        matches =
          startsWith(prefix, WEBM_SIGNATURE) && ascii(prefix).toLowerCase().includes('webm');
        break;
    }
    if (!matches) this.mismatch();
  }

  private mismatch(): never {
    throw new ObjectMediaPolicyError(
      `Object bytes do not match the declared safe media type: ${this.mediaType}`,
    );
  }

  get bufferedByteLength(): number {
    return (
      this.prefixBytes +
      this.tail.byteLength +
      this.textChunks.reduce((total, chunk) => total + chunk.byteLength, 0) +
      (this.png?.bufferedByteLength ?? 0) +
      (this.iso?.bufferedByteLength ?? 0)
    );
  }
}
