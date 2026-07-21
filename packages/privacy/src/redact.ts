import { NormalizedRectSchema, type PrivacyFinding } from '@scenebook/schema';

import { scanText } from './scan.js';
import type { PixelMask, PrivacyScanOptions } from './types.js';

export function redactText(
  text: string,
  findings: readonly PrivacyFinding[],
  replacement = '[REDACTED]',
): string {
  const ranges = findings
    .filter(
      (finding): finding is PrivacyFinding & { start: number; end: number } =>
        finding.start !== undefined && finding.end !== undefined && finding.disposition === 'open',
    )
    .map((finding) => ({ start: finding.start, end: finding.end }))
    .sort((left, right) => right.start - left.start || right.end - left.end);
  let redacted = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (range.start < 0 || range.end > text.length || range.end <= range.start) continue;
    if (range.end > lastStart) continue;
    redacted = `${redacted.slice(0, range.start)}${replacement}${redacted.slice(range.end)}`;
    lastStart = range.start;
  }
  return redacted;
}

export function scanAndRedactText(
  text: string,
  options: PrivacyScanOptions = {},
  replacement = '[REDACTED]',
): { readonly value: string; readonly scan: ReturnType<typeof scanText> } {
  const scan = scanText(text, options);
  return { value: redactText(text, scan.findings, replacement), scan };
}

export function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    for (const key of [...url.searchParams.keys()]) {
      if (
        /(?:password|passwd|pwd|secret|token|key|authorization|cookie|session|code)/iu.test(key)
      ) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    url.hash = '';
    return url.toString();
  } catch {
    return scanAndRedactText(value).value;
  }
}

export function applyOpaqueMasks(
  rgba: Uint8Array,
  width: number,
  height: number,
  masks: readonly PixelMask[],
): Uint8Array {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError('Image dimensions must be positive integers');
  }
  if (rgba.byteLength !== width * height * 4) {
    throw new RangeError(`Expected ${width * height * 4} RGBA bytes, received ${rgba.byteLength}`);
  }
  const output = new Uint8Array(rgba);
  for (const mask of masks) {
    const rect = NormalizedRectSchema.parse(mask.rect);
    const [red, green, blue, alpha] = mask.color ?? [24, 24, 24, 255];
    for (const channel of [red, green, blue, alpha]) {
      if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
        throw new RangeError('Mask RGBA channels must be integers between 0 and 255');
      }
    }
    const startX = Math.max(0, Math.floor(rect.x * width));
    const startY = Math.max(0, Math.floor(rect.y * height));
    const endX = Math.min(width, Math.ceil((rect.x + rect.width) * width));
    const endY = Math.min(height, Math.ceil((rect.y + rect.height) * height));
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * width + x) * 4;
        output[offset] = red;
        output[offset + 1] = green;
        output[offset + 2] = blue;
        output[offset + 3] = alpha;
      }
    }
  }
  return output;
}
