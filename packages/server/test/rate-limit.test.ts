import { describe, expect, it } from 'vitest';

import {
  boundedRouteScope,
  FixedWindowRateLimiter,
  PerClientRateLimiter,
} from '../src/rate-limit.js';

describe('fixed-window rate limiter', () => {
  it('bounds active keys, fails closed at capacity, and evicts expired buckets', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, 1_000, () => now, 3);

    expect(limiter.consume('client-a').allowed).toBe(true);
    expect(limiter.consume('client-b').allowed).toBe(true);
    expect(limiter.consume('client-c').allowed).toBe(true);
    expect(limiter.consume('client-d')).toMatchObject({ allowed: false, remaining: 0 });
    expect(limiter.consume('client-a').allowed).toBe(true);
    expect(limiter.consume('client-a').allowed).toBe(false);

    now = 2_000;
    expect(limiter.consume('client-d')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('maps attacker-controlled IDs and unknown paths to bounded operation scopes', () => {
    expect(
      boundedRouteScope(
        'POST',
        '/v1/public/workspaces/workspace-a/projects/project-a/channels/channel-a/analytics',
      ),
    ).toBe('POST\0analytics');
    expect(
      boundedRouteScope(
        'POST',
        '/v1/public/workspaces/workspace-z/projects/project-z/channels/channel-z/analytics',
      ),
    ).toBe('POST\0analytics');
    expect(boundedRouteScope('GET', '/attacker/path/one')).toBe('GET\0unmatched');
    expect(boundedRouteScope('GET', '/attacker/path/two')).toBe('GET\0unmatched');
    expect(boundedRouteScope('GET', '/v1/not-a-route/channels/channel-a')).toBe('GET\0unmatched');
    expect(boundedRouteScope('POST', '/healthz')).toBe('POST\0unmatched');
    expect(
      boundedRouteScope('PUT', `/v1/uploads/${'a'.repeat(120)}/objects/${'b'.repeat(64)}`),
    ).toBe('PUT\0objects');
    expect(
      boundedRouteScope(
        'GET',
        '/v1/admin/workspaces/workspace-a/projects/project-a/channels/channel-a/custom-domains/domain-a',
      ),
    ).toBe('GET\0custom-domains');
    expect(
      boundedRouteScope(
        'POST',
        '/v1/admin/workspaces/workspace-z/projects/project-z/channels/channel-z/custom-domains/domain-z/activate',
      ),
    ).toBe('POST\0custom-domains');
  });

  it('retains operation budgets while enforcing a per-client aggregate budget', () => {
    const limiter = new PerClientRateLimiter({
      operationLimit: 2,
      aggregateLimit: 3,
      windowMs: 60_000,
    });
    expect(limiter.consume('client-a', 'POST\0analytics').allowed).toBe(true);
    expect(limiter.consume('client-a', 'POST\0analytics').allowed).toBe(true);
    expect(limiter.consume('client-a', 'POST\0cta').allowed).toBe(true);
    expect(limiter.consume('client-a', 'POST\0cta')).toMatchObject({
      allowed: false,
      limitedBy: 'aggregate',
    });
    expect(limiter.consume('client-b', 'POST\0analytics').allowed).toBe(true);
  });

  it('collapses one client path spam into a single unmatched operation bucket', () => {
    const limiter = new PerClientRateLimiter({
      operationLimit: 1,
      aggregateLimit: 100,
      windowMs: 60_000,
      maxClients: 1,
      maxOperationBuckets: 1,
    });
    for (let index = 0; index < 100; index += 1) {
      const scope = boundedRouteScope('GET', `/random/${index}/${'x'.repeat(index)}`);
      expect(scope).toBe('GET\0unmatched');
      expect(limiter.consume('one-client', scope).allowed).toBe(index === 0);
    }
    expect(limiter.consume('another-client', 'GET\0unmatched')).toMatchObject({
      allowed: false,
      limitedBy: 'aggregate',
    });
  });
});
