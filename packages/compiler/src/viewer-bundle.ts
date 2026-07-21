import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const resolveDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Bundle the public player entry together with the exact canonical @scenebook/viewer runtime.
 * Generated publications therefore cannot drift into a second, feature-incomplete player.
 */
export async function bundleViewerRuntime(source: string, format: 'iife' | 'esm'): Promise<string> {
  const result = await build({
    stdin: {
      contents: source,
      loader: 'js',
      resolveDir: resolveDirectory,
      sourcefile: `scenebook-generated-player.${format}.js`,
    },
    bundle: true,
    format,
    platform: 'browser',
    target: ['es2022'],
    write: false,
    // Keep generated code auditable. Publication determinism comes from esbuild's stable output,
    // not identifier mangling, and readable bridge/submission code is a security review surface.
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
    treeShaking: true,
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error('The canonical Scenebook viewer bundle was empty.');
  return output;
}
