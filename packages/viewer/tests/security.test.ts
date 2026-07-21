import { describe, expect, it } from 'vitest';

import { safeImageSource, safeNavigationUrl, safeRadius, safeThemeColor } from '../src/security.js';

const base = 'https://docs.example.test/guides/invite/';

describe('viewer input boundaries', () => {
  it('rejects executable and non-web navigation URLs', () => {
    expect(safeNavigationUrl('javascript:alert(1)', base)).toBe('');
    expect(safeNavigationUrl('data:text/html,<script>alert(1)</script>', base)).toBe('');
    expect(safeNavigationUrl('file:///etc/passwd', base)).toBe('');
    expect(safeNavigationUrl('/settings/members', base)).toBe('/settings/members');
    expect(safeNavigationUrl('https://example.test/docs', base)).toBe('https://example.test/docs');
  });

  it('allows raster image data but rejects active data documents', () => {
    expect(safeImageSource('data:image/png;base64,iVBORw0KGgo=', base)).toContain('image/png');
    expect(safeImageSource('data:image/svg+xml,<svg onload=alert(1)>', base)).toBe('');
    expect(safeImageSource('../assets/frame.webp', base)).toBe('../assets/frame.webp');
  });

  it('prevents custom-property injection and clamps radii', () => {
    expect(safeThemeColor('#e5482c', '#000')).toBe('#e5482c');
    expect(safeThemeColor('red; background:url(https://tracker.test)', '#000')).toBe('#000');
    expect(safeRadius(Number.POSITIVE_INFINITY)).toBe(14);
    expect(safeRadius(900)).toBe(64);
  });
});
