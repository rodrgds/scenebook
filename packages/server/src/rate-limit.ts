export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
}

export interface ClientRateLimitDecision extends RateLimitDecision {
  readonly limitedBy?: 'aggregate' | 'operation';
  readonly aggregate: RateLimitDecision;
  readonly operation?: RateLimitDecision;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const ROUTE_RESOURCES = new Set([
  'analytics',
  'approvals',
  'audit',
  'baselines',
  'builds',
  'channels',
  'comments',
  'cta',
  'custom-domains',
  'decisions',
  'evidence',
  'exchange',
  'finalize',
  'objects',
  'projects',
  'releases',
  'repositories',
  'reviews',
  'revisions',
  'rollback',
  'runs',
  'scenes',
  'uploads',
  'workspaces',
]);

interface RouteScopePattern {
  readonly method: string;
  readonly path: RegExp;
  readonly resource: string;
}

const ROUTE_SCOPE_PATTERNS: readonly RouteScopePattern[] = [
  { method: 'POST', path: /^\/v1\/admin\/workspaces$/u, resource: 'workspaces' },
  { method: 'GET', path: /^\/v1\/admin\/workspaces\/[^/]+$/u, resource: 'workspaces' },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects$/u,
    resource: 'projects',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+$/u,
    resource: 'projects',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/repositories$/u,
    resource: 'repositories',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/scenes\/revisions$/u,
    resource: 'revisions',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/scenes\/[^/]+\/revisions(?:\/[^/]+)?$/u,
    resource: 'revisions',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/reviews$/u,
    resource: 'reviews',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/reviews\/[^/]+$/u,
    resource: 'reviews',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/reviews\/[^/]+\/comments$/u,
    resource: 'comments',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/reviews\/[^/]+\/decisions$/u,
    resource: 'decisions',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/evidence\/runs$/u,
    resource: 'runs',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/evidence\/runs\/[^/]+$/u,
    resource: 'runs',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/evidence\/builds$/u,
    resource: 'builds',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/evidence\/builds\/[^/]+$/u,
    resource: 'builds',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/evidence\/baselines$/u,
    resource: 'baselines',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/evidence\/baselines\/[^/]+$/u,
    resource: 'baselines',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/evidence\/approvals$/u,
    resource: 'approvals',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/evidence\/approvals\/[^/]+$/u,
    resource: 'approvals',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/channels$/u,
    resource: 'channels',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/channels\/[^/]+$/u,
    resource: 'channels',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/channels\/[^/]+\/custom-domains(?:\/[^/]+\/(?:challenge|verify-dns|activate|refresh|disable|remove))?$/u,
    resource: 'custom-domains',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/channels\/[^/]+\/custom-domains(?:\/[^/]+)?$/u,
    resource: 'custom-domains',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/channels\/[^/]+\/releases$/u,
    resource: 'releases',
  },
  {
    method: 'POST',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/channels\/[^/]+\/rollback$/u,
    resource: 'rollback',
  },
  {
    method: 'GET',
    path: /^\/v1\/admin\/workspaces\/[^/]+\/projects\/[^/]+\/releases\/[^/]+$/u,
    resource: 'releases',
  },
  { method: 'GET', path: /^\/v1\/admin\/workspaces\/[^/]+\/audit$/u, resource: 'audit' },
  { method: 'POST', path: /^\/v1\/oidc\/exchange$/u, resource: 'exchange' },
  { method: 'POST', path: /^\/v1\/uploads$/u, resource: 'uploads' },
  {
    method: 'PUT',
    path: /^\/v1\/uploads\/[^/]+\/objects\/[^/]+$/u,
    resource: 'objects',
  },
  {
    method: 'POST',
    path: /^\/v1\/uploads\/[^/]+\/finalize$/u,
    resource: 'finalize',
  },
  {
    method: 'POST',
    path: /^\/v1\/public\/workspaces\/[^/]+\/projects\/[^/]+\/channels\/[^/]+\/analytics$/u,
    resource: 'analytics',
  },
  {
    method: 'POST',
    path: /^\/v1\/public\/workspaces\/[^/]+\/projects\/[^/]+\/channels\/[^/]+\/cta$/u,
    resource: 'cta',
  },
];

/**
 * Map untrusted request paths to a finite operation vocabulary. IDs and unknown
 * suffixes never become bucket keys, so arbitrary-path traffic cannot consume
 * the limiter's global key capacity.
 */
export function boundedRouteScope(method: string, path: string): string {
  const verb = method.trim().toUpperCase().slice(0, 12) || 'UNKNOWN';
  const canonical = path.split('?')[0] || '/';
  if (
    (verb === 'GET' || verb === 'HEAD') &&
    (canonical === '/healthz' || canonical === '/readyz' || canonical === '/metrics')
  ) {
    return `${verb}\0${canonical}`;
  }
  const route = ROUTE_SCOPE_PATTERNS.find(
    (candidate) => candidate.method === verb && candidate.path.test(canonical),
  );
  return `${verb}\0${route?.resource ?? 'unmatched'}`;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
    readonly maxBuckets = 10_000,
  ) {
    if (!Number.isInteger(limit) || limit <= 0)
      throw new RangeError('Rate limit must be a positive integer');
    if (!Number.isInteger(windowMs) || windowMs < 1_000)
      throw new RangeError('Rate-limit window must be at least 1000ms');
    if (!Number.isInteger(maxBuckets) || maxBuckets <= 0)
      throw new RangeError('Rate-limit bucket capacity must be a positive integer');
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket?.resetAt !== undefined && bucket.resetAt <= now) {
      this.buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      this.prune(now);
      if (this.buckets.size >= this.maxBuckets) {
        const resetAt = Math.min(...[...this.buckets.values()].map((value) => value.resetAt));
        return {
          allowed: false,
          limit: this.limit,
          remaining: 0,
          resetAt,
        };
      }
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  prune(now = this.now()): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

/**
 * Enforces one request budget across every operation for a client while also
 * retaining a narrower budget for each bounded operation scope.
 */
export class PerClientRateLimiter {
  private readonly aggregate: FixedWindowRateLimiter;
  private readonly operations: FixedWindowRateLimiter;

  constructor(options: {
    readonly operationLimit: number;
    readonly aggregateLimit: number;
    readonly windowMs: number;
    readonly now?: () => number;
    readonly maxClients?: number;
    readonly maxOperationBuckets?: number;
  }) {
    const maxClients = options.maxClients ?? 10_000;
    this.aggregate = new FixedWindowRateLimiter(
      options.aggregateLimit,
      options.windowMs,
      options.now,
      maxClients,
    );
    this.operations = new FixedWindowRateLimiter(
      options.operationLimit,
      options.windowMs,
      options.now,
      options.maxOperationBuckets ?? maxClients * (ROUTE_RESOURCES.size + 4),
    );
  }

  consume(clientKey: string, operationScope: string): ClientRateLimitDecision {
    const aggregate = this.aggregate.consume(clientKey);
    if (!aggregate.allowed) return { ...aggregate, aggregate, limitedBy: 'aggregate' };
    const operation = this.operations.consume(`${clientKey}\0${operationScope}`);
    const decision: ClientRateLimitDecision = {
      ...operation,
      aggregate,
      operation,
    };
    return operation.allowed ? decision : { ...decision, limitedBy: 'operation' as const };
  }

  prune(): void {
    this.aggregate.prune();
    this.operations.prune();
  }
}
