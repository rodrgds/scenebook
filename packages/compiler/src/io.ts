import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { stableStringify } from '@scenebook/core';

export async function writeOutputFile(
  root: string,
  path: string,
  contents: string | Uint8Array,
): Promise<string> {
  const absolute = resolve(root, path);
  const relativePath = relative(resolve(root), absolute);
  if (relativePath.startsWith('..')) throw new Error(`Output path escapes build root: ${path}`);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  return relativePath.replaceAll('\\', '/');
}

export function canonicalJson(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}
