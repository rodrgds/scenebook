import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  readonly encoding?: BufferEncoding;
  readonly fsync?: boolean;
  readonly mode?: number;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM')
      throw error;
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteFile(
  destination: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.scenebook-tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', options.mode ?? 0o600);
    if (typeof data === 'string') await handle.writeFile(data, options.encoding ?? 'utf8');
    else await handle.writeFile(data);
    if (options.fsync !== false) await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    if (options.mode !== undefined) await chmod(destination, options.mode);
    if (options.fsync !== false) await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
