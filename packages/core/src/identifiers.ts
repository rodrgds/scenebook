import { sha256 } from './canonical.js';

export function slugify(value: string, fallback = 'untitled'): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100)
    .replace(/-+$/u, '');
  return slug || fallback;
}

export function createDeterministicId(namespace: string, value: string, length = 16): string {
  if (!Number.isInteger(length) || length < 8 || length > 64) {
    throw new RangeError('Deterministic ID length must be an integer between 8 and 64');
  }
  const prefix = slugify(namespace, 'id').slice(0, 40);
  return `${prefix}-${sha256(`${namespace}\u0000${value}`).slice(0, length)}`;
}

export function isValidId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value);
}
