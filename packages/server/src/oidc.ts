import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface GitHubOidcClaims {
  readonly repository: string;
  readonly commit: string;
  readonly ref: string;
  readonly workflowRef: string;
  readonly actor: string;
  readonly runId: string;
  readonly tokenId: string;
}

export interface GitHubOidcVerifier {
  verify(token: string): Promise<GitHubOidcClaims>;
}

interface ClaimedOidcPayload extends JWTPayload {
  readonly repository: string;
  readonly run_id: string;
  readonly sha: string;
  readonly ref: string;
  readonly job_workflow_ref?: string;
  readonly workflow_ref: string;
  readonly actor: string;
  readonly run_attempt: string;
}

function isClaimedOidcPayload(payload: JWTPayload): payload is ClaimedOidcPayload {
  for (const key of [
    'repository',
    'run_id',
    'sha',
    'ref',
    'workflow_ref',
    'actor',
    'run_attempt',
  ] as const) {
    const value = payload[key];
    if (typeof value !== 'string' || value.length === 0) return false;
  }
  return true;
}

function claim<
  K extends 'repository' | 'run_id' | 'sha' | 'ref' | 'workflow_ref' | 'actor' | 'run_attempt',
>(payload: ClaimedOidcPayload, key: K): string {
  const value = payload[key];
  if (value.length === 0) throw new Error(`GitHub OIDC token is missing ${String(key)}`);
  return value;
}

export class RemoteGitHubOidcVerifier implements GitHubOidcVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    jwksUrl: string,
    private readonly issuer: string,
    private readonly audience: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
  }

  async verify(token: string): Promise<GitHubOidcClaims> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['RS256'],
      clockTolerance: 5,
      maxTokenAge: '10 minutes',
    });
    if (!isClaimedOidcPayload(payload)) {
      throw new Error('GitHub OIDC token is missing required claims');
    }
    const repository = claim(payload, 'repository');
    const runId = claim(payload, 'run_id');
    const workflowRef =
      payload.job_workflow_ref && payload.job_workflow_ref.length > 0
        ? payload.job_workflow_ref
        : claim(payload, 'workflow_ref');
    return {
      repository,
      commit: claim(payload, 'sha'),
      ref: claim(payload, 'ref'),
      workflowRef,
      actor: claim(payload, 'actor'),
      runId,
      tokenId: payload.jti ?? `${repository}:${runId}:${claim(payload, 'run_attempt')}`,
    };
  }
}

export function matchesWorkflowRef(pattern: string, value: string): boolean {
  if (pattern.length > 500) return false;
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.-]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`, 'u').test(value);
}
