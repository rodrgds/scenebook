import { describe, expect, it } from 'vitest';

import { SceneSchema } from '@scenebook/schema';

import {
  PrivacyBlockedError,
  applyOpaqueMasks,
  assessAssetPrivacy,
  assertPublicationPrivacySafe,
  compilePrivacyRuleConfigurations,
  evaluatePublicationPrivacy,
  redactSensitiveUrl,
  scanAndRedactText,
  scanOcrSegments,
  scanScenePrivacy,
  scanStructuredValue,
  scanText,
} from '../src/index.js';

const NOW = () => new Date('2026-07-20T12:00:00.000Z');

describe('privacy scanning', () => {
  it('detects credentials, payment data, and PII without retaining raw matches', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const input = `Contact ana@example.com with ${token}; card 4242 4242 4242 4242.`;
    const result = scanText(input, { now: NOW });

    expect(result.status).toBe('blocked');
    expect(result.findings.map((finding) => finding.category)).toEqual(
      expect.arrayContaining(['email', 'token', 'payment']),
    );
    expect(JSON.stringify(result.findings)).not.toContain(token);
    expect(result.findings.every((finding) => /^[a-f0-9]{64}$/u.test(finding.fingerprint))).toBe(
      true,
    );
  });

  it('treats values under sensitive structured keys as blocking', () => {
    const result = scanStructuredValue(
      {
        profile: { displayName: 'Test User' },
        credentials: { apiKey: 'not-a-recognized-token-shape' },
      },
      { now: NOW },
    );
    expect(result.status).toBe('blocked');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'sensitive-field-value', path: '$/credentials/apiKey' }),
      ]),
    );
  });

  it('scans portable Scene narrative and routes deterministically', () => {
    const scene = SceneSchema.parse({
      schemaVersion: 1,
      id: 'contact',
      title: 'Contact support',
      slug: 'contact-support',
      steps: [
        {
          id: 'contact-step',
          kind: 'explanation',
          title: 'Email ana@example.com',
        },
      ],
    });
    const result = scanScenePrivacy(scene, { now: NOW });
    expect(result.status).toBe('warning');
    expect(result.findings[0]).toMatchObject({ category: 'email', source: 'text' });
  });

  it('accepts OCR adapter output without pretending structured scans covered pixels', () => {
    const ocr = scanOcrSegments(
      [
        {
          assetHash: 'a'.repeat(64),
          text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
          bounds: { x: 0, y: 0, width: 0.5, height: 0.1 },
        },
      ],
      { now: NOW },
    );
    expect(ocr.status).toBe('blocked');
    expect(ocr.findings[0]).toMatchObject({ source: 'ocr' });
  });

  it('compiles safe project rules and rejects potentially catastrophic patterns', () => {
    const [rule] = compilePrivacyRuleConfigurations([
      {
        id: 'internal-account',
        pattern: '\\bACCT-[0-9]{6}\\b',
        flags: 'gu',
        category: 'personal-data',
        severity: 'high',
        minConfidence: 0.9,
      },
    ]);
    expect(scanText('Customer ACCT-123456', { customRules: [rule!] }).status).toBe('blocked');
    expect(() =>
      compilePrivacyRuleConfigurations([
        {
          id: 'catastrophic',
          pattern: '(a+)+$',
          flags: 'gu',
          category: 'custom',
          severity: 'high',
          minConfidence: 1,
        },
      ]),
    ).toThrow('potentially unsafe');
  });
});

describe('privacy gates', () => {
  const clear = scanText('Welcome to the product', { now: NOW });

  it('fails closed for unscanned pixel assets unless an explicit override is recorded', () => {
    const gate = evaluatePublicationPrivacy({
      structured: clear,
      assets: [assessAssetPrivacy('a'.repeat(64))],
    });
    expect(gate.status).toBe('unknown');
    expect(gate.unscannedAssetHashes).toEqual(['a'.repeat(64)]);
    expect(() => assertPublicationPrivacySafe(gate)).toThrow(PrivacyBlockedError);
    expect(assertPublicationPrivacySafe(gate, { allowUnscannedPrivacy: true }).overrideUsed).toBe(
      true,
    );
  });

  it('never permits an override for known blocked content', () => {
    const blocked = scanText('password=hunter2', { now: NOW });
    const gate = evaluatePublicationPrivacy({
      structured: clear,
      assets: [assessAssetPrivacy('b'.repeat(64), blocked)],
    });
    expect(gate.status).toBe('blocked');
    expect(() => assertPublicationPrivacySafe(gate, { allowUnscannedPrivacy: true })).toThrow(
      PrivacyBlockedError,
    );
  });
});

describe('irreversible redaction primitives', () => {
  it('redacts findings from right to left and sanitizes credential-bearing URLs', () => {
    const email = 'ana@example.com';
    const result = scanAndRedactText(`Email ${email}`, { now: NOW });
    expect(result.value).toBe('Email [REDACTED]');
    expect(result.value).not.toContain(email);
    expect(
      redactSensitiveUrl('https://user:secret@example.com/path?token=abc&safe=yes#private'),
    ).toBe('https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/path?token=%5BREDACTED%5D&safe=yes');
  });

  it('applies opaque masks to a copy without mutating source pixels', () => {
    const source = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]);
    const redacted = applyOpaqueMasks(source, 2, 1, [
      { mode: 'opaque', rect: { x: 0, y: 0, width: 0.5, height: 1 }, color: [1, 2, 3, 255] },
    ]);
    expect([...redacted]).toEqual([1, 2, 3, 255, 255, 255, 255, 255]);
    expect([...source]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  });
});
