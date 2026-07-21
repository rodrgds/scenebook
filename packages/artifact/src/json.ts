import { readFile } from 'node:fs/promises';

import { stableStringify } from '@scenebook/core';
import type { z } from 'zod';

import { atomicWriteFile, type AtomicWriteOptions } from './atomic.js';

const DEFAULT_MAX_JSON_BYTES = 100 * 1024 * 1024;

export async function loadJsonArtifact<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { readonly maxBytes?: number } = {},
): Promise<T> {
  const bytes = await readFile(path);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new RangeError(`Artifact ${path} exceeds the ${maxBytes}-byte limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new SyntaxError(`Artifact ${path} is not valid JSON`, { cause: error });
  }
  return schema.parse(parsed);
}

export async function writeJsonArtifactAtomic<T>(
  path: string,
  value: T,
  schema: z.ZodType<T>,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const parsed = schema.parse(value);
  await atomicWriteFile(path, `${stableStringify(parsed, 2)}\n`, options);
}
