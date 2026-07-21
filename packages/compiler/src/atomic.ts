import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AtomicDirectoryReplacementResult {
  readonly committed: true;
  readonly cleanup:
    | { readonly status: 'not-required' | 'removed' }
    | {
        readonly status: 'pending';
        readonly backupDirectory: string;
        readonly warning: string;
      };
}

export interface AtomicDirectoryDependencies {
  /** Test seam for deterministic post-commit cleanup failures. */
  readonly removeDirectory?: (path: string) => Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function replaceDirectoryAtomically(
  destination: string,
  build: (stagingDirectory: string) => Promise<void>,
  overwrite = true,
  dependencies: AtomicDirectoryDependencies = {},
): Promise<AtomicDirectoryReplacementResult> {
  const absoluteDestination = resolve(destination);
  const parent = dirname(absoluteDestination);
  const name = basename(absoluteDestination);
  if (absoluteDestination === parent || name.length === 0) {
    throw new Error(`Refusing to replace unsafe output directory: ${destination}`);
  }

  await mkdir(parent, { recursive: true });
  if (await exists(absoluteDestination)) {
    const stats = await lstat(absoluteDestination);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic-link output directory: ${absoluteDestination}`);
    }
    if (!overwrite) throw new Error(`Output directory already exists: ${absoluteDestination}`);
  }

  const staging = await mkdtemp(join(parent, `.${name}.staging-`));
  const backup = join(parent, `.${name}.backup-${randomUUID()}`);
  let movedExisting = false;

  try {
    await build(staging);
    if (await exists(absoluteDestination)) {
      await rename(absoluteDestination, backup);
      movedExisting = true;
    }
    await rename(staging, absoluteDestination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (movedExisting && !(await exists(absoluteDestination))) {
      await rename(backup, absoluteDestination).catch(() => undefined);
    }
    throw error;
  }

  if (!movedExisting) return { committed: true, cleanup: { status: 'not-required' } };
  try {
    const removeDirectory =
      dependencies.removeDirectory ??
      ((path: string) => rm(path, { recursive: true, force: true }));
    await removeDirectory(backup);
    return { committed: true, cleanup: { status: 'removed' } };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      committed: true,
      cleanup: {
        status: 'pending',
        backupDirectory: backup,
        warning: `Publication committed at ${absoluteDestination}, but its previous backup could not be removed at ${backup}: ${detail}`,
      },
    };
  }
}
