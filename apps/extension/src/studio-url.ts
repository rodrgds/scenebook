export const STUDIO_URL_KEY = 'scenebook.studio.url.v1';
export const DEFAULT_STUDIO_URL = 'http://127.0.0.1:8080/';

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(host)
  );
}

export function normalizeStudioUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Studio URL must be an absolute HTTPS URL or a loopback HTTP URL.');
  }
  if (url.username || url.password) {
    throw new Error('Studio URL must not contain username or password credentials.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('Studio URL must use HTTPS, except for localhost and 127.0.0.1.');
  }
  if (url.search || url.hash) {
    throw new Error('Studio URL must not contain a query or fragment.');
  }
  return url.href;
}

export function studioImportUrl(value: string): string {
  const url = new URL(normalizeStudioUrl(value));
  url.searchParams.set('action', 'import');
  return url.href;
}
