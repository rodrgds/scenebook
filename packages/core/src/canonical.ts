import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { CanonicalArtifactSchema, type JsonValue } from '@scenebook/schema';

import { InvariantError } from './errors.js';

function canonicalizeInternal(value: unknown, ancestors: WeakSet<object>, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvariantError(`Non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new InvariantError(`Value at ${path} is not JSON-serializable`, { type: typeof value });
  }
  if (ancestors.has(value)) throw new InvariantError(`Circular reference at ${path}`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        canonicalizeInternal(entry, ancestors, `${path}[${index}]`),
      );
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvariantError(`Non-plain object at ${path}`);
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) throw new InvariantError(`Undefined value at ${path}.${key}`);
      output[key] = canonicalizeInternal(entry, ancestors, `${path}.${key}`);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalize(value: unknown): JsonValue {
  return canonicalizeInternal(value, new WeakSet<object>(), '$');
}

export function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(canonicalize(value), null, space);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

/**
 * Hash a schema-normalized JSON payload using the Scenebook canonical JSON
 * contract. Transport formatting, including a trailing newline, is excluded.
 */
export function canonicalJsonHash(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Hash a supported artifact after applying its schema defaults and validation. */
export function artifactHash(value: unknown): string {
  return canonicalJsonHash(CanonicalArtifactSchema.parse(value));
}

/** Compatibility name for callers hashing non-artifact canonical values. */
export function revisionOf(value: unknown): string {
  return canonicalJsonHash(value);
}
