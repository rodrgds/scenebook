import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type SafeFileReadFailure =
  | 'missing'
  | 'unsafe-path'
  | 'symlink'
  | 'not-regular'
  | 'size'
  | 'changed';

export class SafeFileReadError extends Error {
  constructor(
    readonly reason: SafeFileReadFailure,
    readonly path: string,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'SafeFileReadError';
  }
}

/** Hooks exist only to make race regressions deterministic. */
export interface SafeFileReadHooks {
  readonly afterOpen?: (path: string) => void | Promise<void>;
  readonly afterRead?: (path: string) => void | Promise<void>;
}

export interface SafeFileReadOptions {
  readonly maximumBytes: number;
  readonly minimumBytes?: number;
  /** @internal */
  readonly hooks?: SafeFileReadHooks;
}

export interface SafeFileReadResult {
  readonly bytes: Uint8Array;
  readonly path: string;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function systemCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function changed(path: string, cause?: unknown): SafeFileReadError {
  return new SafeFileReadError(
    'changed',
    path,
    `File changed while its exact bytes were being read: ${path}`,
    cause === undefined ? {} : { cause },
  );
}

async function boundedDescriptorRead(
  handle: FileHandle,
  byteLength: number,
  path: string,
): Promise<Uint8Array> {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const read = await handle.read(bytes, offset, byteLength - offset, offset);
    if (read.bytesRead === 0) throw changed(path);
    offset += read.bytesRead;
  }
  const probe = Buffer.allocUnsafe(1);
  if ((await handle.read(probe, 0, 1, offset)).bytesRead !== 0) throw changed(path);
  return bytes;
}

/**
 * Read a bounded regular file through one O_NOFOLLOW descriptor. Logical and
 * physical containment, descriptor identity, size, and content timestamps are
 * rechecked after the read so path replacement cannot silently change truth.
 */
export async function readBoundedRegularFile(
  root: string,
  reference: string,
  options: SafeFileReadOptions,
): Promise<SafeFileReadResult> {
  const minimumBytes = options.minimumBytes ?? 0;
  if (
    !Number.isSafeInteger(minimumBytes) ||
    minimumBytes < 0 ||
    !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes < minimumBytes
  ) {
    throw new TypeError('Safe file byte bounds must be non-negative safe integers');
  }
  if (!reference || isAbsolute(reference)) {
    throw new SafeFileReadError('unsafe-path', reference, `File reference is unsafe: ${reference}`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (systemCode(error) === 'ENOENT') {
      throw new SafeFileReadError('missing', root, `File root does not exist: ${root}`, {
        cause: error,
      });
    }
    throw error;
  }
  const candidate = resolve(canonicalRoot, reference);
  if (!inside(canonicalRoot, candidate) || candidate === canonicalRoot) {
    throw new SafeFileReadError(
      'unsafe-path',
      candidate,
      `File reference escapes its configured root: ${reference}`,
    );
  }

  let pathStatus;
  try {
    pathStatus = await lstat(candidate);
  } catch (error) {
    if (systemCode(error) === 'ENOENT') {
      throw new SafeFileReadError('missing', candidate, `File does not exist: ${candidate}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (pathStatus.isSymbolicLink()) {
    throw new SafeFileReadError('symlink', candidate, `File cannot be a symlink: ${candidate}`);
  }
  if (!pathStatus.isFile()) {
    throw new SafeFileReadError(
      'not-regular',
      candidate,
      `File must be a regular file: ${candidate}`,
    );
  }
  const physicalPath = await realpath(candidate);
  if (physicalPath !== candidate || !inside(canonicalRoot, physicalPath)) {
    throw new SafeFileReadError(
      'unsafe-path',
      candidate,
      `File resolves through a symlink or outside its configured root: ${candidate}`,
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = systemCode(error);
    if (code === 'ENOENT') throw changed(candidate, error);
    if (code === 'ELOOP') {
      throw new SafeFileReadError('symlink', candidate, `File cannot be a symlink: ${candidate}`, {
        cause: error,
      });
    }
    throw error;
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new SafeFileReadError(
        'not-regular',
        candidate,
        `File descriptor is not a regular file: ${candidate}`,
      );
    }
    if (before.size < BigInt(minimumBytes) || before.size > BigInt(options.maximumBytes)) {
      throw new SafeFileReadError('size', candidate, `File has an unsupported size: ${candidate}`);
    }
    await options.hooks?.afterOpen?.(candidate);
    const bytes = await boundedDescriptorRead(handle, Number(before.size), candidate);
    await options.hooks?.afterRead?.(candidate);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw changed(candidate);
    }

    let finalPathStatus;
    let finalPhysicalPath: string;
    try {
      [finalPathStatus, finalPhysicalPath] = await Promise.all([
        lstat(candidate, { bigint: true }),
        realpath(candidate),
      ]);
    } catch (error) {
      throw changed(candidate, error);
    }
    if (
      finalPathStatus.isSymbolicLink() ||
      !finalPathStatus.isFile() ||
      finalPathStatus.dev !== after.dev ||
      finalPathStatus.ino !== after.ino ||
      finalPhysicalPath !== candidate ||
      !inside(canonicalRoot, finalPhysicalPath)
    ) {
      throw changed(candidate);
    }
    return { bytes, path: candidate };
  } finally {
    await handle.close();
  }
}

export function readBoundedRegularFileAtPath(
  path: string,
  options: SafeFileReadOptions,
): Promise<SafeFileReadResult> {
  const absolute = resolve(path);
  return readBoundedRegularFile(dirname(absolute), basename(absolute), options);
}
