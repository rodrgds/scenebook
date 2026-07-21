import { describe, expect, it } from 'vitest';
import {
  containsSensitiveRecordedText,
  sanitizeRecordedRoute,
  sanitizeRecordedText,
  slugify,
} from './protocol';

describe('recorder protocol utilities', () => {
  it('creates portable scene slugs', () => {
    expect(slugify('  Invite a Téam!  ')).toBe('invite-a-team');
  });

  it('drops query values, fragments, and credentials from recorded routes', () => {
    expect(
      sanitizeRecordedRoute(
        'https://person:password@example.test/members/invite?email=private@example.test&token=secret#access_token=secret',
      ),
    ).toBe('https://example.test/members/invite');
  });

  it('redacts private and opaque pathname segments', () => {
    expect(sanitizeRecordedRoute('https://example.test/users/private%40example.test/profile')).toBe(
      'https://example.test/users/__redacted__/profile',
    );
    expect(
      sanitizeRecordedRoute('https://example.test/reset/550e8400-e29b-41d4-a716-446655440000'),
    ).toBe('https://example.test/reset/__redacted__');
  });

  it('removes secrets from semantic target context before persistence', () => {
    const source = 'Invite private@example.test with sk-proj-abcdefghijklmnopqrstuvwxyz';
    expect(sanitizeRecordedText(source)).toBe('Invite [PRIVATE] with [PRIVATE]');
    expect(containsSensitiveRecordedText(source)).toBe(true);
    expect(containsSensitiveRecordedText('Invite member')).toBe(false);
    expect(sanitizeRecordedText('Invite a teammate')).toBe('Invite a teammate');
  });

  it('fails closed for non-web and invalid routes', () => {
    expect(sanitizeRecordedRoute('javascript:alert(1)')).toBe('/');
    expect(sanitizeRecordedRoute('not a route')).toBe('/');
  });
});
