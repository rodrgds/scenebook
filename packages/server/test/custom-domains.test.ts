import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertMatchingProvisioningObservation,
  customDomainStatusFromObservation,
  CustomDomainProvisionerError,
  hasExactCustomDomainDnsProof,
  HttpCustomDomainProvisioner,
  normalizeCustomDomainHostname,
  pinnedCustomDomainAddressLookup,
} from '../src/custom-domains.js';
import type { CustomDomainRecord } from '../src/domain.js';

const SECRET = 'custom-domain-provisioner-secret-'.padEnd(64, 's');

function domain(): CustomDomainRecord {
  return {
    id: 'domain-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    channelId: 'channel-1',
    hostname: 'stories.acme.com',
    routingTarget: 'customers.scenebook.cloud',
    status: 'provisioning',
    dnsProof: {
      status: 'verified',
      challengeName: '_scenebook-challenge.stories.acme.com',
      challengeValue: 'scenebook-verification=proof',
      checkedAt: '2026-07-21T12:00:00.000Z',
      verifiedAt: '2026-07-21T12:00:00.000Z',
    },
    provisioning: {
      operationKey: 'operation-1',
      desiredState: 'active',
      certificate: 'pending',
      routing: 'pending',
      requestedAt: '2026-07-21T12:00:00.000Z',
    },
    version: 3,
    createdBy: 'user-1',
    createdAt: '2026-07-21T11:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
  };
}

describe('custom-domain hostnames and DNS proof', () => {
  it('normalizes IDNA and root-dot spelling into one canonical hostname', () => {
    expect(normalizeCustomDomainHostname('  DÉMO.Acme.COM. ')).toBe('xn--dmo-bma.acme.com');
  });

  it.each([
    'https://stories.acme.com',
    '*.acme.com',
    'stories.acme.com:443',
    'user@stories.acme.com',
    '127.0.0.1',
    '127.1',
    'localhost',
    'stories.localhost',
    'stories.example',
    'single-label',
    'bad_label.acme.com',
    `x${'a'.repeat(63)}.acme.com`,
  ])('rejects an unsafe or ambiguous hostname: %s', (hostname) => {
    expect(() => normalizeCustomDomainHostname(hostname)).toThrow();
  });

  it('requires the exact TXT value while supporting DNS character-string segmentation', async () => {
    const resolver = {
      async resolveTxt() {
        return [['unrelated=value'], ['scenebook-verification=', 'proof']];
      },
    };
    await expect(
      hasExactCustomDomainDnsProof(
        resolver,
        '_scenebook-challenge.stories.acme.com',
        'scenebook-verification=proof',
      ),
    ).resolves.toBe(true);
    await expect(
      hasExactCustomDomainDnsProof(
        resolver,
        '_scenebook-challenge.stories.acme.com',
        'scenebook-verification=proof ',
      ),
    ).resolves.toBe(false);
  });
});

describe('custom-domain ingress observations', () => {
  it('never treats DNS or a partial provider observation as activation', () => {
    expect(
      customDomainStatusFromObservation({
        operationKey: 'operation-1',
        operationId: 'provider-1',
        hostname: 'stories.acme.com',
        desiredState: 'active',
        certificate: 'ready',
        routing: 'pending',
      }),
    ).toBe('provisioning');
    expect(
      customDomainStatusFromObservation({
        operationKey: 'operation-1',
        operationId: 'provider-1',
        hostname: 'stories.acme.com',
        desiredState: 'active',
        certificate: 'ready',
        routing: 'ready',
      }),
    ).toBe('active');
  });

  it('rejects cross-host, cross-operation, and impossible provider responses', () => {
    for (const observation of [
      {
        operationKey: 'operation-1',
        operationId: 'provider-1',
        hostname: 'other.acme.com',
        desiredState: 'active' as const,
        certificate: 'ready' as const,
        routing: 'ready' as const,
      },
      {
        operationKey: 'operation-other',
        operationId: 'provider-1',
        hostname: 'stories.acme.com',
        desiredState: 'active' as const,
        certificate: 'ready' as const,
        routing: 'ready' as const,
      },
      {
        operationKey: 'operation-1',
        operationId: 'provider-1',
        hostname: 'stories.acme.com',
        desiredState: 'active' as const,
        certificate: 'removed' as const,
        routing: 'removed' as const,
      },
    ]) {
      expect(() => assertMatchingProvisioningObservation(domain(), observation)).toThrow(
        CustomDomainProvisionerError,
      );
    }
  });

  it('authenticates bounded provider responses and binds the idempotency key', async () => {
    const provisioner = new HttpCustomDomainProvisioner({
      url: 'https://provisioner.example.net/reconcile',
      secret: SECRET,
      timeoutMs: 1_000,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { operationKey: string };
        expect(new Headers(init?.headers).get('idempotency-key')).toBe('operation-1');
        expect(request.operationKey).toBe('operation-1');
        const body = JSON.stringify({
          operationKey: 'operation-1',
          operationId: 'provider-1',
          hostname: 'stories.acme.com',
          desiredState: 'active',
          certificate: 'ready',
          routing: 'ready',
        });
        const timestamp = '2026-07-21T12:00:00.000Z';
        const signature = `sha256=${createHmac('sha256', SECRET)
          .update(timestamp)
          .update('.')
          .update(body)
          .digest('hex')}`;
        return new Response(body, {
          headers: { 'x-scenebook-signature': signature },
        });
      },
    });
    await expect(
      provisioner.reconcile({
        operationKey: 'operation-1',
        desiredState: 'active',
        domain: domain(),
      }),
    ).resolves.toMatchObject({ certificate: 'ready', routing: 'ready' });
  });

  it('fails closed on unauthenticated provider responses', async () => {
    const provisioner = new HttpCustomDomainProvisioner({
      url: 'https://provisioner.example.net/reconcile',
      secret: SECRET,
      timeoutMs: 1_000,
      fetch: async () =>
        new Response(
          JSON.stringify({
            operationKey: 'operation-1',
            operationId: 'provider-1',
            hostname: 'stories.acme.com',
            desiredState: 'active',
            certificate: 'ready',
            routing: 'ready',
          }),
          { headers: { 'x-scenebook-signature': 'sha256=forged' } },
        ),
    });
    await expect(
      provisioner.reconcile({
        operationKey: 'operation-1',
        desiredState: 'active',
        domain: domain(),
      }),
    ).rejects.toMatchObject({ code: 'provisioner_response_unauthenticated' });
  });

  it('rejects private provisioner destinations and pins the validated address against rebinding', async () => {
    const lookup = pinnedCustomDomainAddressLookup('93.184.216.34', 4);
    await expect(
      new Promise<{ address: string | import('node:dns').LookupAddress[]; family?: number }>(
        (resolve, reject) => {
          lookup('rebinding.attacker.test', {}, (error, address, family) => {
            if (error) reject(error);
            else resolve({ address, family });
          });
        },
      ),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });

    const provisioner = new HttpCustomDomainProvisioner({
      url: 'https://127.0.0.1/reconcile',
      secret: SECRET,
      timeoutMs: 1_000,
    });
    await expect(
      provisioner.reconcile({
        operationKey: 'operation-1',
        desiredState: 'active',
        domain: domain(),
      }),
    ).rejects.toMatchObject({ code: 'provisioner_unavailable' });
  });
});
