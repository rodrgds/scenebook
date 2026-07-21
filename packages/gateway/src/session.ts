import { randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

const ISSUER = 'scenebook-publication-gateway';
const AUDIENCE = 'scenebook-private-publication';

const PortalSessionClaimsSchema = z
  .object({
    iss: z.literal(ISSUER),
    aud: z.union([z.literal(AUDIENCE), z.array(z.literal(AUDIENCE)).length(1)]),
    sub: z.string().min(1),
    jti: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    auth_kind: z.enum(['share', 'user']),
    workspace_id: z.string().min(1),
    project_id: z.string().min(1),
    channel_id: z.string().min(1),
    grant_id: z.string().min(1),
    link_id: z.string().min(1).optional(),
    user_id: z.string().min(1).optional(),
    source_session_id: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (
      (value.auth_kind === 'share' &&
        (!value.link_id || value.user_id || value.source_session_id)) ||
      (value.auth_kind === 'user' && (!value.user_id || !value.source_session_id || value.link_id))
    ) {
      context.addIssue({ code: 'custom', message: 'Portal session subject is inconsistent' });
    }
  });

export type PortalSessionClaims = z.infer<typeof PortalSessionClaimsSchema>;

export class PortalSessionService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32)
      throw new Error('Gateway-session secret must be at least 32 characters');
    this.key = new TextEncoder().encode(secret);
  }

  async issue(
    claims: Omit<PortalSessionClaims, 'iss' | 'aud' | 'sub' | 'jti' | 'iat' | 'exp'> & {
      readonly expiresAt: number;
    },
    now: number,
  ): Promise<string> {
    const subject =
      claims.auth_kind === 'share' ? `share:${claims.link_id}` : `user:${claims.user_id}`;
    return new SignJWT({
      auth_kind: claims.auth_kind,
      workspace_id: claims.workspace_id,
      project_id: claims.project_id,
      channel_id: claims.channel_id,
      grant_id: claims.grant_id,
      ...(claims.link_id ? { link_id: claims.link_id } : {}),
      ...(claims.user_id ? { user_id: claims.user_id } : {}),
      ...(claims.source_session_id ? { source_session_id: claims.source_session_id } : {}),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(subject)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(claims.expiresAt)
      .sign(this.key);
  }

  async verify(token: string, now: number): Promise<PortalSessionClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: new Date(now * 1_000),
      clockTolerance: 0,
    });
    return PortalSessionClaimsSchema.parse(payload);
  }
}
