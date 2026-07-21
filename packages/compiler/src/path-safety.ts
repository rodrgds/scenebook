import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

async function canonicalProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];

  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return resolve(canonical, ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;

      // realpath reports ENOENT for a dangling symlink. Do not silently treat
      // one as an ordinary missing path because its future target could alias
      // a protected source tree.
      const status = await lstat(cursor).catch((statusError: unknown) => {
        const statusCode = (statusError as NodeJS.ErrnoException).code;
        if (statusCode === 'ENOENT' || statusCode === 'ENOTDIR') return undefined;
        throw statusError;
      });
      if (status?.isSymbolicLink()) {
        throw new Error(`Refusing to resolve output through a dangling symbolic link: ${cursor}`);
      }

      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function contains(parent: string, child: string): boolean {
  // APFS/HFS+ and Windows volumes are commonly case- and Unicode-normalization
  // insensitive. Missing path tails cannot be realpathed yet, so compare them
  // conservatively to avoid case-only aliases bypassing source protection.
  const comparable = (path: string): string =>
    process.platform === 'darwin' || process.platform === 'win32'
      ? path.normalize('NFC').toLowerCase()
      : path;
  const path = relative(comparable(parent), comparable(child));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/**
 * Resolve existing symlinks plus any nonexistent tail, then reject every
 * destination that contains or is contained by a protected source/state path.
 * The canonical destination is returned so mutation does not traverse the
 * caller's symlink aliases after validation.
 */
export async function safeOutputDirectory(
  destination: string,
  protectedPaths: readonly string[],
): Promise<string> {
  const absolute = resolve(destination);
  const status = await lstat(absolute).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (status?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symbolic-link output directory: ${absolute}`);
  }

  const canonicalDestination = await canonicalProspectivePath(absolute);
  const canonicalProtected = await Promise.all(
    protectedPaths.map((path) => canonicalProspectivePath(path)),
  );
  for (const protectedPath of new Set(canonicalProtected)) {
    if (
      contains(canonicalDestination, protectedPath) ||
      contains(protectedPath, canonicalDestination)
    ) {
      throw new Error(
        `Refusing to replace output directory ${canonicalDestination}: it overlaps protected source or state path ${protectedPath}. Choose a separate sibling output directory.`,
      );
    }
  }
  return canonicalDestination;
}
