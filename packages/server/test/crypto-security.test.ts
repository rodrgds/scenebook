import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import { HmacHasher, SecretBox, UploadTokenService, constantTimeEqual } from '../src/crypto.js';
import { redactLogValue } from '../src/logger.js';
import { matchesWorkflowRef } from '../src/oidc.js';
import { isPublicAddress, readCappedWebhookResponse } from '../src/webhook.js';

const SECRET = 's'.repeat(64);
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');

describe('control-plane security primitives', () => {
  it('compares secrets without exposing length-dependent behavior', () => {
    expect(constantTimeEqual('correct', 'correct')).toBe(true);
    expect(constantTimeEqual('correct', 'wrong')).toBe(false);
    expect(constantTimeEqual('', 'a very different length')).toBe(false);
  });

  it('encrypts CTA payloads with authenticated encryption and detects tampering', () => {
    const box = new SecretBox(ENCRYPTION_KEY);
    const ciphertext = box.encrypt({ email: 'person@example.com', choice: 'demo' });
    expect(ciphertext).not.toContain('person@example.com');
    expect(box.decrypt(ciphertext)).toEqual({ email: 'person@example.com', choice: 'demo' });
    const envelope = Buffer.from(ciphertext, 'base64url');
    envelope[envelope.length - 1] = envelope[envelope.length - 1]! ^ 1;
    expect(() => box.decrypt(envelope.toString('base64url'))).toThrow();
  });

  it('issues short-lived upload tokens with immutable repository and commit scope', async () => {
    const tokens = new UploadTokenService(SECRET);
    const token = await tokens.issue(
      {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: 'acme/product',
        commit: 'a'.repeat(40),
        ref: 'refs/heads/main',
        workflowRef: 'acme/product/.github/workflows/publish.yml@refs/heads/main',
        permissions: ['artifact:write'],
        expiresAt: 1_900_000_300,
        tokenId: 'token-1',
      },
      1_900_000_000,
    );
    const claims = await tokens.verify(token, 1_900_000_001);
    expect(claims).toMatchObject({
      repository: 'acme/product',
      commit: 'a'.repeat(40),
      permissions: ['artifact:write'],
    });
    await expect(
      new UploadTokenService('x'.repeat(64)).verify(token, 1_900_000_001),
    ).rejects.toThrow();
  });

  it('uses namespaced HMAC identifiers', () => {
    const hasher = new HmacHasher(SECRET);
    expect(hasher.hash('person-1', 'analytics')).not.toBe(hasher.hash('person-1', 'audit'));
    expect(hasher.hash('person-1', 'analytics')).not.toContain('person-1');
  });

  it('redacts nested tokens, secrets, and email addresses from logs', () => {
    expect(
      redactLogValue({
        authorization: 'Bearer should-never-appear',
        message: 'contact person@example.com using sk-proj-secretvalue',
        nested: { password: 'hunter2' },
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      message: 'contact [REDACTED:EMAIL] using [REDACTED:TOKEN]',
      nested: { password: '[REDACTED]' },
    });
  });

  it('matches only anchored workflow patterns', () => {
    expect(
      matchesWorkflowRef(
        'acme/product/.github/workflows/*.yml@refs/heads/main',
        'acme/product/.github/workflows/publish.yml@refs/heads/main',
      ),
    ).toBe(true);
    expect(matchesWorkflowRef('acme/*', 'evil/acme/workflow')).toBe(false);
  });

  it('rejects private, local, mapped, documentation, and multicast addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.168.1.2',
      '198.51.100.2',
      '203.0.113.9',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
      'ff02::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('aborts webhook response streams above the hard byte cap', async () => {
    const stream = new PassThrough();
    const result = readCappedWebhookResponse(stream, 32);
    stream.end(Buffer.alloc(33, 1));
    await expect(result).rejects.toThrow('exceeded 32 bytes');
    expect(stream.destroyed).toBe(true);
  });
});
