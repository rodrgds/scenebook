import { describe, expect, it } from 'vitest';

import { DEFAULT_STUDIO_URL, normalizeStudioUrl, studioImportUrl } from './studio-url';

describe('Studio URL policy', () => {
  it('defaults to the self-hosted Compose Studio and builds its import route', () => {
    expect(DEFAULT_STUDIO_URL).toBe('http://127.0.0.1:8080/');
    expect(studioImportUrl(DEFAULT_STUDIO_URL)).toBe('http://127.0.0.1:8080/?action=import');
  });

  it.each([
    ['https://studio.example.com/scenebook', 'https://studio.example.com/scenebook'],
    ['http://localhost:5173/', 'http://localhost:5173/'],
    ['http://app.localhost:8080/', 'http://app.localhost:8080/'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080/'],
    ['http://[::1]:8080/', 'http://[::1]:8080/'],
  ])('accepts a safe Studio URL %s', (value, expected) => {
    expect(normalizeStudioUrl(value)).toBe(expected);
  });

  it.each([
    'http://studio.example.com/',
    'ftp://localhost/studio',
    'https://user:password@studio.example.com/',
    'https://studio.example.com/?token=secret',
    'https://studio.example.com/#import',
    'not a URL',
  ])('rejects an unsafe or ambiguous Studio URL %s', (value) => {
    expect(() => normalizeStudioUrl(value)).toThrow();
  });
});
