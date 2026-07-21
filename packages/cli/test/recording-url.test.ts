import { describe, expect, it } from 'vitest';
import { prepareRecordingTarget } from '../src/recording-url.js';

describe('recording URL policy', () => {
  it('accepts only credential-free HTTP(S) targets and identifies loopback hosts', () => {
    expect(prepareRecordingTarget('http://localhost:4173/invite?mode=preview#/members')).toEqual({
      href: 'http://localhost:4173/invite?mode=preview#/members',
      local: true,
    });
    expect(prepareRecordingTarget('https://docs.example.test/guide?page=2')).toEqual({
      href: 'https://docs.example.test/guide?page=2',
      local: false,
    });
    expect(prepareRecordingTarget('http://[::1]:3000/').local).toBe(true);
  });

  it.each(['file:///tmp/private.html', 'javascript:alert(1)', 'ftp://example.test/file'])(
    'rejects the %s scheme',
    (url) => {
      expect(() => prepareRecordingTarget(url)).toThrow('must use HTTP or HTTPS');
    },
  );

  it('rejects URL userinfo without reflecting credentials', () => {
    const password = 'not-for-logs';
    expect(() => prepareRecordingTarget(`https://person:${password}@example.test/`)).toThrow(
      'must not contain username or password',
    );
    try {
      prepareRecordingTarget(`https://person:${password}@example.test/`);
    } catch (error) {
      expect((error as Error).message).not.toContain(password);
    }
  });

  it('fails closed for named, opaque, and fragment-carried secrets without reflecting values', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    for (const url of [
      `https://example.test/?access_token=${secret}`,
      `https://example.test/?state=${secret}`,
      `https://example.test/#/callback?code=${secret}`,
    ]) {
      try {
        prepareRecordingTarget(url);
        throw new Error('Expected the target to be rejected.');
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).toMatch(/sensitive|secret|credentials/iu);
      }
    }
  });
});
