const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const RELATIVE_URL = /^(?:#|\?|\/[^/]|\.\.?\/)/u;

function parseWebUrl(value: string, baseUrl: string): URL | undefined {
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHARACTERS.test(trimmed) || trimmed.includes('\\')) return undefined;
  try {
    return new URL(trimmed, baseUrl);
  } catch {
    return undefined;
  }
}

/** Returns a navigation target only for ordinary web and email links. */
export function safeNavigationUrl(value: string | undefined, baseUrl: string): string {
  if (!value) return '';
  const parsed = parseWebUrl(value, baseUrl);
  if (!parsed || !['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return '';
  const trimmed = value.trim();
  return RELATIVE_URL.test(trimmed) ? trimmed : parsed.href;
}

/** Image sources additionally permit local object URLs and inert raster data URLs. */
export function safeImageSource(value: string | undefined, baseUrl: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (/^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/iu.test(trimmed)) {
    return trimmed;
  }
  const parsed = parseWebUrl(trimmed, baseUrl);
  if (!parsed || !['http:', 'https:', 'blob:'].includes(parsed.protocol)) return '';
  return RELATIVE_URL.test(trimmed) ? trimmed : parsed.href;
}

/**
 * Theme colors are inserted into a style attribute, so accept a deliberately
 * small color grammar instead of trusting arbitrary CSS tokens.
 */
export function safeThemeColor(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() ?? '';
  if (
    /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]{1,32}|(?:rgb|rgba|hsl|hsla)\([\d.%+\-,\s/]+\))$/iu.test(
      candidate,
    )
  ) {
    return candidate;
  }
  return fallback;
}

export function safeRadius(value: number | undefined, fallback = 14): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(64, Number(value))) : fallback;
}
