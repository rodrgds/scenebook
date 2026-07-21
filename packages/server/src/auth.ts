import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

import { decodeProtectedHeader, SignJWT, jwtVerify } from 'jose';

import type {
  IdentityScope,
  PrivateShareLinkRecord,
  UserSessionRecord,
  WorkspaceRole,
} from './domain.js';

const SESSION_AUDIENCE = 'scenebook-control-session:v1';
const SHARE_AUDIENCE = 'scenebook-publication-share:v1';
const ISSUER = 'scenebook-control-plane';

export const ALL_IDENTITY_SCOPES = [
  'workspace:read',
  'workspace:admin',
  'project:read',
  'project:write',
  'review:read',
  'review:write',
  'channel:read',
  'channel:write',
  'release:write',
  'schedule:read',
  'schedule:write',
  'runner:admin',
  'analytics:read',
  'audit:read',
] as const satisfies readonly IdentityScope[];

const ROLE_SCOPES: Readonly<Record<WorkspaceRole, ReadonlySet<IdentityScope>>> = {
  owner: new Set(ALL_IDENTITY_SCOPES),
  editor: new Set([
    'workspace:read',
    'project:read',
    'project:write',
    'review:read',
    'review:write',
    'channel:read',
    'channel:write',
    'release:write',
    'schedule:read',
    'schedule:write',
    'analytics:read',
  ]),
  reviewer: new Set([
    'workspace:read',
    'project:read',
    'review:read',
    'review:write',
    'channel:read',
    'schedule:read',
  ]),
  viewer: new Set([
    'workspace:read',
    'project:read',
    'review:read',
    'channel:read',
    'schedule:read',
  ]),
};

export function roleAllows(role: WorkspaceRole, scope: IdentityScope): boolean {
  return ROLE_SCOPES[role].has(scope);
}

export interface SessionClaims {
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: number;
}

export interface PrivateShareClaims {
  readonly linkId: string;
  readonly grantId: string;
  readonly expiresAt: number;
}

export interface IdentityTokenServiceOptions {
  /** HMAC key used only for opaque personal API-token digests. */
  readonly apiTokenHashSecret: string;
  /** Base64-encoded PKCS#8 Ed25519 private key. Control plane only. */
  readonly signingPrivateKey: string;
  /** Base64-encoded SPKI Ed25519 public key. Safe to provide to the gateway. */
  readonly verificationPublicKey: string;
  /** Up to three bounded rollover public keys accepted strictly by their derived kid. */
  readonly previousVerificationPublicKeys?: readonly string[];
}

export interface IdentityTokenVerifierOptions {
  readonly activeVerificationPublicKey: string;
  readonly previousVerificationPublicKeys?: readonly string[];
}

export const MAX_PREVIOUS_IDENTITY_VERIFICATION_KEYS = 3;

interface TokenKeys {
  readonly algorithm: 'HS256' | 'EdDSA';
  readonly signingKey: Uint8Array | KeyObject;
  readonly verificationKey: Uint8Array | KeyObject;
  readonly keyId?: string;
}

function shareDigest(value: string): string {
  return createHash('sha256').update('private-share-token\0').update(value).digest('hex');
}

function ed25519PublicKey(encoded: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error('Identity verification key must be a base64-encoded SPKI public key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Identity verification key must use Ed25519');
  }
  return key;
}

function ed25519PrivateKey(encoded: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('Identity signing key must be a base64-encoded PKCS#8 private key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Identity signing key must use Ed25519');
  }
  return key;
}

function publicKeyId(key: KeyObject): string {
  return createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('base64url')
    .slice(0, 22);
}

async function verifyToken(
  token: string,
  key: Uint8Array | KeyObject,
  algorithm: 'HS256' | 'EdDSA',
  audience: string,
  nowSeconds: number,
  expectedKeyId?: string,
) {
  const result = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience,
    algorithms: [algorithm],
    clockTolerance: 5,
    currentDate: new Date(nowSeconds * 1_000),
  });
  if (
    result.protectedHeader.typ !== 'JWT' ||
    (expectedKeyId !== undefined && result.protectedHeader.kid !== expectedKeyId)
  ) {
    throw new Error('Identity token has invalid protected headers');
  }
  return result.payload;
}

function sessionClaims(payload: Awaited<ReturnType<typeof verifyToken>>): SessionClaims {
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof payload.session_id !== 'string' ||
    payload.session_id !== payload.jti ||
    typeof payload.exp !== 'number'
  ) {
    throw new Error('Session token has invalid claims');
  }
  return { sessionId: payload.jti, userId: payload.sub, expiresAt: payload.exp };
}

function privateShareClaims(payload: Awaited<ReturnType<typeof verifyToken>>): PrivateShareClaims {
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof payload.grant_id !== 'string' ||
    payload.sub !== payload.grant_id ||
    typeof payload.exp !== 'number'
  ) {
    throw new Error('Private-share token has invalid claims');
  }
  return {
    linkId: payload.jti,
    grantId: payload.grant_id,
    expiresAt: payload.exp,
  };
}

/** Verification-only publication capability. It contains no signing or API-token hashing key. */
export class IdentityTokenVerifier {
  private readonly keys = new Map<string, KeyObject>();

  constructor(options: string | IdentityTokenVerifierOptions) {
    const activeVerificationPublicKey =
      typeof options === 'string' ? options : options.activeVerificationPublicKey;
    const previousVerificationPublicKeys =
      typeof options === 'string' ? [] : (options.previousVerificationPublicKeys ?? []);
    if (previousVerificationPublicKeys.length > MAX_PREVIOUS_IDENTITY_VERIFICATION_KEYS) {
      throw new Error(
        `At most ${MAX_PREVIOUS_IDENTITY_VERIFICATION_KEYS} previous identity verification keys are allowed`,
      );
    }
    for (const encoded of [activeVerificationPublicKey, ...previousVerificationPublicKeys]) {
      const key = ed25519PublicKey(encoded);
      const keyId = publicKeyId(key);
      if (this.keys.has(keyId)) {
        throw new Error('Identity verification keys must have unique derived key IDs');
      }
      this.keys.set(keyId, key);
    }
  }

  private async verify(token: string, audience: string, nowSeconds: number) {
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new Error('Identity token has invalid protected headers');
    }
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || typeof header.kid !== 'string') {
      throw new Error('Identity token has invalid protected headers');
    }
    const key = this.keys.get(header.kid);
    if (!key) throw new Error('Identity token uses an unknown verification key');
    return verifyToken(token, key, 'EdDSA', audience, nowSeconds, header.kid);
  }

  async verifySession(
    token: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<SessionClaims> {
    return sessionClaims(await this.verify(token, SESSION_AUDIENCE, nowSeconds));
  }

  async verifyPrivateShare(
    token: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<PrivateShareClaims> {
    return privateShareClaims(await this.verify(token, SHARE_AUDIENCE, nowSeconds));
  }

  hashShareToken(token: string): string {
    return shareDigest(token);
  }
}

export class IdentityTokenService {
  private readonly apiTokenHashSecret: string;
  private readonly keys: TokenKeys;
  private readonly asymmetricVerifier?: IdentityTokenVerifier;

  constructor(options: string | IdentityTokenServiceOptions) {
    const apiTokenHashSecret = typeof options === 'string' ? options : options.apiTokenHashSecret;
    if (apiTokenHashSecret.length < 32)
      throw new Error('Identity-token secret must contain at least 32 characters');
    this.apiTokenHashSecret = apiTokenHashSecret;
    if (typeof options === 'string') {
      const key = new TextEncoder().encode(options);
      this.keys = { algorithm: 'HS256', signingKey: key, verificationKey: key };
      return;
    }
    const signingKey = ed25519PrivateKey(options.signingPrivateKey);
    const verificationKey = ed25519PublicKey(options.verificationPublicKey);
    const derived = signingKey.export({ format: 'jwk' }).x;
    const configured = verificationKey.export({ format: 'jwk' }).x;
    if (
      typeof derived !== 'string' ||
      typeof configured !== 'string' ||
      derived.length !== configured.length ||
      !timingSafeEqual(Buffer.from(derived), Buffer.from(configured))
    ) {
      throw new Error('Identity signing and verification keys do not form a pair');
    }
    this.keys = {
      algorithm: 'EdDSA',
      signingKey,
      verificationKey,
      keyId: publicKeyId(verificationKey),
    };
    this.asymmetricVerifier = new IdentityTokenVerifier({
      activeVerificationPublicKey: options.verificationPublicKey,
      previousVerificationPublicKeys: options.previousVerificationPublicKeys,
    });
  }

  private digest(value: string, namespace: string): string {
    return createHmac('sha256', this.apiTokenHashSecret)
      .update(namespace)
      .update('\0')
      .update(value)
      .digest('hex');
  }

  createApiToken(id: string): { readonly token: string; readonly tokenHash: string } {
    const token = `sbk_pat.${id}.${randomBytes(32).toString('base64url')}`;
    return { token, tokenHash: this.digest(token, 'identity-api-token') };
  }

  apiTokenId(token: string): string | undefined {
    const match = /^sbk_pat\.([A-Za-z0-9][A-Za-z0-9_-]{0,199})\.[A-Za-z0-9_-]{43}$/u.exec(token);
    return match?.[1];
  }

  hashApiToken(token: string): string {
    return this.digest(token, 'identity-api-token');
  }

  hashShareToken(token: string): string {
    return shareDigest(token);
  }

  async issueSession(
    session: UserSessionRecord,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<string> {
    return new SignJWT({ session_id: session.id })
      .setProtectedHeader({
        alg: this.keys.algorithm,
        typ: 'JWT',
        ...(this.keys.keyId ? { kid: this.keys.keyId } : {}),
      })
      .setIssuer(ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setSubject(session.userId)
      .setJti(session.id)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(Math.floor(new Date(session.expiresAt).getTime() / 1_000))
      .sign(this.keys.signingKey);
  }

  async verifySession(
    token: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<SessionClaims> {
    if (this.asymmetricVerifier) {
      return this.asymmetricVerifier.verifySession(token, nowSeconds);
    }
    return sessionClaims(
      await verifyToken(
        token,
        this.keys.verificationKey,
        this.keys.algorithm,
        SESSION_AUDIENCE,
        nowSeconds,
        this.keys.keyId,
      ),
    );
  }

  async issuePrivateShare(
    link: Pick<PrivateShareLinkRecord, 'id' | 'grantId' | 'expiresAt'>,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<string> {
    return new SignJWT({ grant_id: link.grantId })
      .setProtectedHeader({
        alg: this.keys.algorithm,
        typ: 'JWT',
        ...(this.keys.keyId ? { kid: this.keys.keyId } : {}),
      })
      .setIssuer(ISSUER)
      .setAudience(SHARE_AUDIENCE)
      .setSubject(link.grantId)
      .setJti(link.id)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(Math.floor(new Date(link.expiresAt).getTime() / 1_000))
      .sign(this.keys.signingKey);
  }

  async verifyPrivateShare(
    token: string,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): Promise<PrivateShareClaims> {
    if (this.asymmetricVerifier) {
      return this.asymmetricVerifier.verifyPrivateShare(token, nowSeconds);
    }
    return privateShareClaims(
      await verifyToken(
        token,
        this.keys.verificationKey,
        this.keys.algorithm,
        SHARE_AUDIENCE,
        nowSeconds,
        this.keys.keyId,
      ),
    );
  }
}
