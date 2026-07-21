import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MAX_TEMPORARY_NAME_ATTEMPTS = 8;

export interface AtomicWriteOptions {
  /** Exact permissions applied before the file is synced and promoted. */
  readonly mode?: number;
  /** Permissions used only when parent directories need to be created. */
  readonly directoryMode?: number;
}

function permissions(value: number | undefined, fallback: number, label: string): number {
  const mode = value ?? fallback;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error(`${label} must be an integer permission mode between 000 and 777.`);
  }
  return mode;
}

async function exclusiveTemporaryFile(
  path: string,
  mode: number,
): Promise<{ readonly path: string; readonly handle: Awaited<ReturnType<typeof open>> }> {
  const parent = dirname(path);
  const name = basename(path);
  for (let attempt = 0; attempt < MAX_TEMPORARY_NAME_ATTEMPTS; attempt += 1) {
    const temporary = join(parent, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      return { path: temporary, handle: await open(temporary, 'wx', mode) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not allocate an exclusive temporary file for ${path}.`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replaces one local file without exposing partial contents. Temporary files are random,
 * create-exclusive, data-synced, permission-bounded, and removed on every pre-commit failure.
 */
export async function writeFileAtomically(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = permissions(options.mode, 0o600, 'Atomic file mode');
  const directoryMode = permissions(options.directoryMode, 0o700, 'Atomic directory mode');
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: directoryMode });

  const temporary = await exclusiveTemporaryFile(path, mode);
  let promoted = false;
  try {
    await temporary.handle.writeFile(contents);
    await temporary.handle.chmod(mode);
    await temporary.handle.sync();
    await temporary.handle.close();
    await rename(temporary.path, path);
    promoted = true;
    await syncDirectory(parent);
  } catch (error) {
    await temporary.handle.close().catch(() => undefined);
    if (!promoted) await rm(temporary.path, { force: true }).catch(() => undefined);
    throw error;
  }
}
