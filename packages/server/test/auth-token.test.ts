import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { IdentityTokenService, IdentityTokenVerifier, roleAllows } from '../src/auth.js';
import { RunnerTokenService } from '../src/runner-token.js';

const SECRET = 'identity-signing-secret-'.padEnd(64, 'i');
const NOW = Math.floor(new Date('2026-07-21T10:00:00.000Z').getTime() / 1_000);

function identityKeyMaterial() {
  const pair = generateKeyPairSync('ed25519');
  const signingPrivateKey = pair.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
  const verificationPublicKey = pair.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  return { signingPrivateKey, verificationPublicKey };
}

function asymmetricIdentity() {
  const { signingPrivateKey, verificationPublicKey } = identityKeyMaterial();
  return {
    service: new IdentityTokenService({
      apiTokenHashSecret: SECRET,
      signingPrivateKey,
      verificationPublicKey,
    }),
    verifier: new IdentityTokenVerifier(verificationPublicKey),
  };
}

describe('identity credential cryptography', () => {
  it('separates Session and private-share audiences and rejects tampering', async () => {
    const { service, verifier } = asymmetricIdentity();
    const session = {
      id: 'session-1',
      userId: 'user-1',
      sourceTokenId: 'token-1',
      workspaceId: 'workspace-1',
      scopes: ['project:read'] as const,
      createdAt: '2026-07-21T10:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
    };
    const sessionToken = await service.issueSession(session, NOW);
    await expect(service.verifySession(sessionToken, NOW)).resolves.toMatchObject({
      sessionId: session.id,
      userId: session.userId,
    });
    await expect(verifier.verifySession(sessionToken, NOW)).resolves.toMatchObject({
      sessionId: session.id,
      userId: session.userId,
    });
    expect('issueSession' in verifier).toBe(false);
    expect('createApiToken' in verifier).toBe(false);
    await expect(service.verifyPrivateShare(sessionToken, NOW)).rejects.toThrow();

    const shareToken = await service.issuePrivateShare(
      {
        id: 'share-1',
        grantId: 'grant-1',
        expiresAt: '2026-07-21T11:00:00.000Z',
      },
      NOW,
    );
    await expect(service.verifyPrivateShare(shareToken, NOW)).resolves.toMatchObject({
      linkId: 'share-1',
      grantId: 'grant-1',
    });
    await expect(verifier.verifyPrivateShare(shareToken, NOW)).resolves.toMatchObject({
      linkId: 'share-1',
      grantId: 'grant-1',
    });
    expect(verifier.hashShareToken(shareToken)).toBe(service.hashShareToken(shareToken));
    await expect(service.verifySession(shareToken, NOW)).rejects.toThrow();
    const parts = sessionToken.split('.');
    const signature = parts[2]!;
    const replacement = signature[0] === 'a' ? 'b' : 'a';
    const tampered = `${parts[0]}.${parts[1]}.${replacement}${signature.slice(1)}`;
    await expect(service.verifySession(tampered, NOW)).rejects.toThrow();
  });

  it('creates parseable high-entropy PATs without granting roles beyond policy', () => {
    const service = new IdentityTokenService(SECRET);
    const first = service.createApiToken('token-1');
    const second = service.createApiToken('token-1');
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(service.apiTokenId(first.token)).toBe('token-1');
    expect(service.apiTokenId(`${first.token}x`)).toBeUndefined();
    expect(roleAllows('reviewer', 'review:write')).toBe(true);
    expect(roleAllows('reviewer', 'project:write')).toBe(false);
    expect(roleAllows('viewer', 'review:write')).toBe(false);
    expect(roleAllows('owner', 'runner:admin')).toBe(true);
    expect(roleAllows('editor', 'schedule:write')).toBe(true);
    expect(roleAllows('editor', 'runner:admin')).toBe(false);
    expect(roleAllows('reviewer', 'schedule:read')).toBe(true);
    expect(roleAllows('reviewer', 'schedule:write')).toBe(false);
  });

  it('keeps active and previous Ed25519 keys verifiable strictly by kid during rotation', async () => {
    const previous = identityKeyMaterial();
    const active = identityKeyMaterial();
    const unknown = identityKeyMaterial();
    const session = {
      id: 'session-rotation',
      userId: 'user-rotation',
      sourceTokenId: 'token-rotation',
      workspaceId: 'workspace-1',
      scopes: ['channel:read'] as const,
      createdAt: '2026-07-21T10:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
    };
    const previousSigner = new IdentityTokenService({
      apiTokenHashSecret: SECRET,
      ...previous,
    });
    const previousToken = await previousSigner.issueSession(session, NOW);
    const previousShare = await previousSigner.issuePrivateShare(
      {
        id: 'share-rotation',
        grantId: 'grant-rotation',
        expiresAt: '2026-07-21T11:00:00.000Z',
      },
      NOW,
    );
    const activeService = new IdentityTokenService({
      apiTokenHashSecret: SECRET,
      ...active,
      previousVerificationPublicKeys: [previous.verificationPublicKey],
    });
    const verifier = new IdentityTokenVerifier({
      activeVerificationPublicKey: active.verificationPublicKey,
      previousVerificationPublicKeys: [previous.verificationPublicKey],
    });
    await expect(activeService.verifySession(previousToken, NOW)).resolves.toMatchObject({
      sessionId: session.id,
    });
    await expect(verifier.verifySession(previousToken, NOW)).resolves.toMatchObject({
      sessionId: session.id,
    });
    await expect(activeService.verifyPrivateShare(previousShare, NOW)).resolves.toMatchObject({
      linkId: 'share-rotation',
    });
    await expect(verifier.verifyPrivateShare(previousShare, NOW)).resolves.toMatchObject({
      linkId: 'share-rotation',
    });
    const activeToken = await activeService.issueSession({ ...session, id: 'session-active' }, NOW);
    await expect(verifier.verifySession(activeToken, NOW)).resolves.toMatchObject({
      sessionId: 'session-active',
    });

    const unknownSigner = new IdentityTokenService({
      apiTokenHashSecret: SECRET,
      ...unknown,
    });
    const unknownToken = await unknownSigner.issueSession(
      { ...session, id: 'session-unknown' },
      NOW,
    );
    await expect(verifier.verifySession(unknownToken, NOW)).rejects.toThrow('unknown');
    expect(
      () =>
        new IdentityTokenVerifier({
          activeVerificationPublicKey: active.verificationPublicKey,
          previousVerificationPublicKeys: [active.verificationPublicKey],
        }),
    ).toThrow('unique derived key IDs');
  });
});

describe('verification runner credential cryptography', () => {
  it('creates opaque, parseable, independently namespaced runner credentials', () => {
    const service = new RunnerTokenService('runner-signing-secret-'.padEnd(64, 'r'));
    const first = service.create('runner-1');
    const second = service.create('runner-1');
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(service.id(first.token)).toBe('runner-1');
    expect(service.id(`${first.token}x`)).toBeUndefined();
    expect(service.hash(`${first.token}x`)).not.toBe(first.tokenHash);
    expect(new IdentityTokenService(SECRET).apiTokenId(first.token)).toBeUndefined();
  });
});
