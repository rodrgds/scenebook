import { createReadStream, watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import type { LoadedConfig } from './types.js';
import { buildProject } from './project.js';

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.md': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`));
}

export async function startDevServer(
  config: LoadedConfig,
  options: {
    readonly host: string;
    readonly port: number;
    readonly allowUnscannedPrivacy: boolean;
    readonly output?: string;
    readonly channel?: string;
    readonly collection?: string;
  },
): Promise<void> {
  const buildOptions = {
    allowUnscannedPrivacy: options.allowUnscannedPrivacy,
    ...(options.output ? { output: options.output } : {}),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.collection ? { collection: options.collection } : {}),
  };
  let build = await buildProject(config, buildOptions);
  let rebuilding = false;
  let queued = false;
  const rebuild = async (): Promise<void> => {
    if (rebuilding) {
      queued = true;
      return;
    }
    rebuilding = true;
    try {
      build = await buildProject(config, buildOptions);
      process.stdout.write(`Rebuilt ${build.manifest.scenes.length} Scene(s).\n`);
    } catch (error) {
      process.stderr.write(
        `Rebuild failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      rebuilding = false;
      if (queued) {
        queued = false;
        void rebuild();
      }
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const decoded = decodeURIComponent(url.pathname);
      const root = resolve(build.outputDirectory);
      let path = resolve(root, `.${normalize(decoded)}`);
      if (!inside(root, path)) {
        response.writeHead(400).end('Invalid path');
        return;
      }
      const stats = await lstat(path).catch(() => undefined);
      if (stats?.isDirectory()) path = join(path, 'index.html');
      const file = await lstat(path).catch(() => undefined);
      if (!file?.isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      response.writeHead(200, {
        'content-type': MEDIA_TYPES[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': file.size,
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'",
      });
      createReadStream(path).pipe(response);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolvePromise);
  });
  process.stdout.write(`Scenebook is available at http://${options.host}:${options.port}\n`);

  const watcher = watch(config.directory, { recursive: true }, (_event, filename) => {
    if (!filename || /(?:node_modules|scenebook-dist|\.scenebook|\.git)/u.test(filename)) return;
    const changed = resolve(config.directory, String(filename));
    if (inside(resolve(build.outputDirectory), changed)) return;
    if (/\.(?:ya?ml|mdx?|tsx?|png|jpe?g|webp|svg)$/u.test(filename)) void rebuild();
  });
  const shutdown = (): void => {
    watcher.close();
    process.exitCode = 0;
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
