import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadPublicationGatewayConfig } from '../src/config.js';

const identityKeyPair = generateKeyPairSync('ed25519');
const IDENTITY_PUBLIC_KEY = identityKeyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
const previousIdentityKeyPair = generateKeyPairSync('ed25519');
const PREVIOUS_IDENTITY_PUBLIC_KEY = previousIdentityKeyPair.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    SCENEBOOK_PUBLIC_URL: 'https://control.example.com',
    SCENEBOOK_PUBLICATION_URL: 'https://stories.example.com',
    SCENEBOOK_CONTROL_PLANE_INTERNAL_URL: 'http://cloud:4310',
    DATABASE_URL: 'postgresql://gateway@example/scenebook',
    SCENEBOOK_IDENTITY_VERIFICATION_PUBLIC_KEY: IDENTITY_PUBLIC_KEY,
    SCENEBOOK_GATEWAY_SESSION_SECRET: 'g'.repeat(64),
    SCENEBOOK_GATEWAY_EXCHANGE_SECRET: 'x'.repeat(64),
    ...overrides,
  };
}

describe('publication gateway configuration', () => {
  it('requires independent HTTPS origins and signing keys in production', () => {
    expect(loadPublicationGatewayConfig(environment()).publicationBaseUrl).toBe(
      'https://stories.example.com',
    );
    expect(() =>
      loadPublicationGatewayConfig(
        environment({ SCENEBOOK_PUBLICATION_URL: 'https://control.example.com' }),
      ),
    ).toThrow('distinct');
    expect(() =>
      loadPublicationGatewayConfig(
        environment({ SCENEBOOK_PUBLICATION_URL: 'http://stories.example.com' }),
      ),
    ).toThrow('HTTPS');
    expect(() =>
      loadPublicationGatewayConfig(
        environment({ SCENEBOOK_GATEWAY_SESSION_SECRET: 'x'.repeat(64) }),
      ),
    ).toThrow('independent');
    expect(() =>
      loadPublicationGatewayConfig(
        environment({ SCENEBOOK_GATEWAY_EXCHANGE_SECRET: 'g'.repeat(64) }),
      ),
    ).toThrow('independent');
  });

  it('rejects a non-HTTP internal control-plane origin', () => {
    expect(() =>
      loadPublicationGatewayConfig(
        environment({ SCENEBOOK_CONTROL_PLANE_INTERNAL_URL: 'ftp://cloud.example' }),
      ),
    ).toThrow('HTTP(S)');
  });

  it('loads a bounded rollover key ring and rejects duplicate or malformed keys', () => {
    expect(
      loadPublicationGatewayConfig(
        environment({
          SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON: JSON.stringify([
            PREVIOUS_IDENTITY_PUBLIC_KEY,
          ]),
        }),
      ).identityPreviousVerificationPublicKeys,
    ).toEqual([PREVIOUS_IDENTITY_PUBLIC_KEY]);
    expect(() =>
      loadPublicationGatewayConfig(
        environment({
          SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON: JSON.stringify([
            IDENTITY_PUBLIC_KEY,
          ]),
        }),
      ),
    ).toThrow('unique derived key IDs');
    expect(() =>
      loadPublicationGatewayConfig(
        environment({
          SCENEBOOK_IDENTITY_PREVIOUS_VERIFICATION_PUBLIC_KEYS_JSON: JSON.stringify([
            'not-a-valid-public-key'.padEnd(64, 'x'),
          ]),
        }),
      ),
    ).toThrow('base64-encoded SPKI');
  });

  it('rejects partial S3 credentials and bounds serving resources', () => {
    expect(() =>
      loadPublicationGatewayConfig(
        environment({
          SCENEBOOK_OBJECT_STORE: 's3',
          SCENEBOOK_S3_BUCKET: 'scenebook',
          SCENEBOOK_S3_ACCESS_KEY_ID: 'gateway',
        }),
      ),
    ).toThrow('configured together');
    const config = loadPublicationGatewayConfig(
      environment({
        SCENEBOOK_GATEWAY_MAX_MEMBER_BYTES: String(64 * 1024 * 1024),
        SCENEBOOK_GATEWAY_MAX_RESPONSES: '3',
      }),
    );
    expect(config.maxMemberBytes).toBe(64 * 1024 * 1024);
    expect(config.maxConcurrentResponses).toBe(3);
  });

  it('deploys with a public verification key and exact masked database views only', async () => {
    const compose = await readFile(
      new URL('../../../deploy/compose.yaml', import.meta.url),
      'utf8',
    );
    const gateway = compose.slice(compose.indexOf('\n  gateway:'), compose.indexOf('\n  static:'));
    expect(gateway).toContain('SCENEBOOK_IDENTITY_VERIFICATION_PUBLIC_KEY');
    expect(gateway).not.toContain('SCENEBOOK_IDENTITY_TOKEN_SECRET');
    expect(compose).not.toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public');
    expect(compose).not.toContain('GRANT SELECT ON TABLES TO scenebook_gateway');
    expect(compose).toContain('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public');
    expect(compose).toContain("repeat('0',64) AS token_hash");
    expect(compose).toContain('GRANT SELECT ON publication_gateway.workspaces');
    for (const forbidden of [
      'publication_gateway.audit_events',
      'publication_gateway.analytics_events',
      'publication_gateway.cta_submissions',
      'publication_gateway.artifact_uploads',
    ]) {
      expect(compose).not.toContain(forbidden);
    }
  });
});
