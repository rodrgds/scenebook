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

function claim(payload: JWTPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`GitHub OIDC token is missing ${key}`);
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
    const repository = claim(payload, 'repository');
    const runId = claim(payload, 'run_id');
    const workflowRef =
      typeof payload.job_workflow_ref === 'string' && payload.job_workflow_ref.length > 0
        ? payload.job_workflow_ref
        : claim(payload, 'workflow_ref');
    return {
      repository,
      commit: claim(payload, 'sha'),
      ref: claim(payload, 'ref'),
      workflowRef,
      actor: claim(payload, 'actor'),
      runId,
      tokenId:
        typeof payload.jti === 'string'
          ? payload.jti
          : `${repository}:${runId}:${claim(payload, 'run_attempt')}`,
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
