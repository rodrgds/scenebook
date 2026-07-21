import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import type { UploadTokenClaims } from './domain.js';

function decodeKey(value: string): Buffer {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(`${normalized}${padding}`, 'base64');
  if (decoded.byteLength !== 32) throw new Error('Encryption key must decode to exactly 32 bytes');
  return decoded;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHmac('sha256', 'scenebook-constant-time').update(left).digest();
  const rightDigest = createHmac('sha256', 'scenebook-constant-time').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export class HmacHasher {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error('HMAC secret must contain at least 32 characters');
  }

  hash(value: string, namespace: string): string {
    return createHmac('sha256', this.secret)
      .update(namespace)
      .update('\0')
      .update(value)
      .digest('hex');
  }
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = decodeKey(encodedKey);
  }

  encrypt(value: unknown): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const plaintext = Buffer.from(JSON.stringify(value));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, tag, ciphertext]).toString('base64url');
  }

  decrypt<T>(encoded: string): T {
    const envelope = Buffer.from(encoded, 'base64url');
    if (envelope.byteLength < 29) throw new Error('Encrypted CTA envelope is truncated');
    const nonce = envelope.subarray(0, 12);
    const tag = envelope.subarray(12, 28);
    const ciphertext = envelope.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  }
}

export class UploadTokenService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32)
      throw new Error('Upload-token secret must contain at least 32 characters');
    this.key = new TextEncoder().encode(secret);
  }

  async issue(
    claims: UploadTokenClaims,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<string> {
    return new SignJWT({
      workspace_id: claims.workspaceId,
      project_id: claims.projectId,
      repository: claims.repository,
      commit: claims.commit,
      ref: claims.ref,
      workflow_ref: claims.workflowRef,
      permissions: claims.permissions,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('scenebook')
      .setAudience('scenebook-artifact-upload')
      .setSubject(`${claims.repository}@${claims.commit}`)
      .setJti(claims.tokenId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(claims.expiresAt)
      .sign(this.key);
  }

  async verify(
    token: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<UploadTokenClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: 'scenebook',
      audience: 'scenebook-artifact-upload',
      algorithms: ['HS256'],
      clockTolerance: 5,
      currentDate: new Date(nowSeconds * 1_000),
    });
    const permissions = payload.permissions;
    if (
      typeof payload.workspace_id !== 'string' ||
      typeof payload.project_id !== 'string' ||
      typeof payload.repository !== 'string' ||
      typeof payload.commit !== 'string' ||
      typeof payload.ref !== 'string' ||
      typeof payload.workflow_ref !== 'string' ||
      !Array.isArray(permissions) ||
      permissions.length !== 1 ||
      permissions[0] !== 'artifact:write' ||
      typeof payload.exp !== 'number' ||
      typeof payload.jti !== 'string'
    ) {
      throw new Error('Upload token has invalid claims');
    }
    return {
      workspaceId: payload.workspace_id,
      projectId: payload.project_id,
      repository: payload.repository,
      commit: payload.commit,
      ref: payload.ref,
      workflowRef: payload.workflow_ref,
      permissions: ['artifact:write'],
      expiresAt: payload.exp,
      tokenId: payload.jti,
    };
  }
}
