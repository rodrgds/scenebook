import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import type { JsonValue } from '@scenebook/schema';
import { domainToASCII } from 'node:url';

import { z } from 'zod';

import type {
  CustomDomainDesiredState,
  CustomDomainProvisioningObservation,
  CustomDomainProvisioningRecord,
  CustomDomainRecord,
} from './domain.js';
import { readCappedWebhookResponse, validateWebhookUrl } from './webhook.js';

const RESERVED_SUFFIXES = [
  'alt',
  'arpa',
  'corp',
  'example',
  'home',
  'internal',
  'invalid',
  'lan',
  'local',
  'localdomain',
  'localhost',
  'onion',
  'test',
] as const;
const MAX_PROVISIONER_RESPONSE_BYTES = 64 * 1024;
const PROVISIONER_SIGNATURE_HEADER = 'x-scenebook-signature';
const PROVISIONER_TIMESTAMP_HEADER = 'x-scenebook-timestamp';

export class CustomDomainHostnameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomDomainHostnameError';
  }
}

export class CustomDomainDnsError extends Error {
  constructor(
    message: string,
    readonly code: 'dns_unavailable' | 'dns_response_invalid' = 'dns_unavailable',
  ) {
    super(message);
    this.name = 'CustomDomainDnsError';
  }
}

export class CustomDomainProvisionerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'provisioner_disabled'
      | 'provisioner_unavailable'
      | 'provisioner_response_invalid'
      | 'provisioner_response_unauthenticated',
  ) {
    super(message);
    this.name = 'CustomDomainProvisionerError';
  }
}

/**
 * Convert an operator-supplied DNS name into the single canonical identity
 * used by the API, database uniqueness constraints, and ingress provider.
 * URL syntax, wildcards, IP literals, private-use suffixes, and ambiguous
 * single-label names are deliberately rejected.
 */
export function normalizeCustomDomainHostname(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || /[\s/@:*?#\\]/u.test(trimmed)) {
    throw new CustomDomainHostnameError('Custom domain must be a bare DNS hostname');
  }
  const withoutRootDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!withoutRootDot || withoutRootDot.endsWith('.') || withoutRootDot.includes('..')) {
    throw new CustomDomainHostnameError('Custom domain has an invalid DNS label');
  }
  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (!ascii || ascii.length > 253 || isIP(ascii) !== 0) {
    throw new CustomDomainHostnameError('Custom domain must be a valid non-IP DNS hostname');
  }
  const labels = ascii.split('.');
  if (labels.length < 2) {
    throw new CustomDomainHostnameError('Custom domain must contain a registrable DNS suffix');
  }
  for (const label of labels) {
    if (
      label.length < 1 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
    ) {
      throw new CustomDomainHostnameError('Custom domain has an invalid DNS label');
    }
  }
  if (!/[a-z]/u.test(labels.at(-1)!)) {
    throw new CustomDomainHostnameError('Custom domain must have a non-numeric DNS suffix');
  }
  if (RESERVED_SUFFIXES.some((suffix) => ascii === suffix || ascii.endsWith(`.${suffix}`))) {
    throw new CustomDomainHostnameError('Custom domain uses a reserved or private-use DNS suffix');
  }
  return ascii;
}

export function customDomainChallengeName(hostname: string): string {
  return `_scenebook-challenge.${normalizeCustomDomainHostname(hostname)}`;
}

export function makeCustomDomainChallengeValue(): string {
  return `scenebook-verification=${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
}

export interface CustomDomainDnsResolver {
  resolveTxt(hostname: string): Promise<readonly (readonly string[])[]>;
}

function hasErrnoCode<T>(error: T, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isStringSegments<T>(value: T): value is T & readonly string[] {
  if (!Array.isArray(value)) return false;
  for (const segment of value) {
    const text: unknown = segment;
    if (typeof text !== 'string') return false;
  }
  return true;
}

export class NodeCustomDomainDnsResolver implements CustomDomainDnsResolver {
  async resolveTxt(hostname: string): Promise<readonly (readonly string[])[]> {
    try {
      return await resolveTxt(hostname);
    } catch (error) {
      if (hasErrnoCode(error, 'ENODATA') || hasErrnoCode(error, 'ENOTFOUND')) return [];
      throw new CustomDomainDnsError('DNS verification is temporarily unavailable');
    }
  }
}

export async function hasExactCustomDomainDnsProof(
  resolver: CustomDomainDnsResolver,
  challengeName: string,
  challengeValue: string,
): Promise<boolean> {
  const records = await resolver.resolveTxt(challengeName);
  if (!Array.isArray(records)) {
    throw new CustomDomainDnsError(
      'DNS resolver returned an invalid TXT response',
      'dns_response_invalid',
    );
  }
  return records.some(
    (segments) =>
      Array.isArray(segments) && isStringSegments(segments) && segments.join('') === challengeValue,
  );
}

export interface CustomDomainProvisioningRequest {
  readonly operationKey: string;
  readonly desiredState: CustomDomainDesiredState;
  readonly domain: Pick<
    CustomDomainRecord,
    'id' | 'workspaceId' | 'projectId' | 'channelId' | 'hostname' | 'routingTarget'
  >;
}

export interface CustomDomainProvisioner {
  /**
   * Idempotently reconcile external certificate and ingress/CDN state. DNS
   * ownership is intentionally absent from the return contract: the server
   * activates only from explicit certificate *and* routing observations.
   */
  reconcile(input: CustomDomainProvisioningRequest): Promise<CustomDomainProvisioningObservation>;
}

export class DisabledCustomDomainProvisioner implements CustomDomainProvisioner {
  async reconcile(): Promise<never> {
    throw new CustomDomainProvisionerError(
      'Custom-domain ingress provisioning is not configured',
      'provisioner_disabled',
    );
  }
}

export const CustomDomainProvisioningObservationSchema: z.ZodType<CustomDomainProvisioningObservation> =
  z
    .object({
      operationKey: z.string().min(1).max(300),
      operationId: z.string().min(1).max(300),
      hostname: z.string().min(1).max(253),
      desiredState: z.enum(['active', 'disabled', 'removed']),
      certificate: z.enum(['not-requested', 'pending', 'ready', 'failed', 'removed']),
      routing: z.enum(['not-requested', 'pending', 'ready', 'disabled', 'failed', 'removed']),
      failureCode: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u)
        .optional(),
    })
    .strict()
    .superRefine((observation, context) => {
      if (
        observation.failureCode &&
        observation.certificate !== 'failed' &&
        observation.routing !== 'failed'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Provisioner failureCode requires a failed certificate or routing observation',
          path: ['failureCode'],
        });
      }
    });

export const CustomDomainProvisioningRecordSchema: z.ZodType<CustomDomainProvisioningRecord> = z
  .object({
    operationKey: z.string().min(1).max(300),
    operationId: z.string().min(1).max(300).optional(),
    desiredState: z.enum(['active', 'disabled', 'removed']),
    certificate: z.enum(['not-requested', 'pending', 'ready', 'failed', 'removed']),
    routing: z.enum(['not-requested', 'pending', 'ready', 'disabled', 'failed', 'removed']),
    requestedAt: z.string().datetime({ offset: true }),
    observedAt: z.string().datetime({ offset: true }).optional(),
    failureCode: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u)
      .optional(),
  })
  .strict();

export interface HttpCustomDomainProvisionerOptions {
  readonly url: string;
  readonly secret: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export function pinnedCustomDomainAddressLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, _options, callback) => callback(null, address, family);
}

function signature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex')}`;
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_PROVISIONER_RESPONSE_BYTES) {
    throw new CustomDomainProvisionerError(
      'Custom-domain provisioner response exceeds the size limit',
      'provisioner_response_invalid',
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PROVISIONER_RESPONSE_BYTES) {
        throw new CustomDomainProvisionerError(
          'Custom-domain provisioner response exceeds the size limit',
          'provisioner_response_invalid',
        );
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Provider-neutral HTTPS contract for certificate/CDN automation. Requests
 * and responses are HMAC authenticated; callers must implement reconciliation
 * idempotently by `operationKey`.
 */
export class HttpCustomDomainProvisioner implements CustomDomainProvisioner {
  private readonly fetch?: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: HttpCustomDomainProvisionerOptions) {
    if (options.secret.length < 32)
      throw new TypeError('Provisioner secret must be at least 32 bytes');
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1_000 ||
      options.timeoutMs > 30_000
    ) {
      throw new RangeError('Provisioner timeout must be between 1000ms and 30000ms');
    }
    this.fetch = options.fetch;
    this.now = options.now ?? (() => new Date());
  }

  async reconcile(
    input: CustomDomainProvisioningRequest,
  ): Promise<CustomDomainProvisioningObservation> {
    const body = JSON.stringify({ schemaVersion: 1, action: 'reconcile', ...input });
    const timestamp = this.now().toISOString();
    let response: Response;
    try {
      const headers = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'idempotency-key': input.operationKey,
        [PROVISIONER_TIMESTAMP_HEADER]: timestamp,
        [PROVISIONER_SIGNATURE_HEADER]: signature(this.options.secret, timestamp, body),
      };
      response = this.fetch
        ? await this.fetch(this.options.url, {
            method: 'POST',
            headers,
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(this.options.timeoutMs),
          })
        : await this.postToPinnedPublicProvisioner(body, headers);
    } catch {
      throw new CustomDomainProvisionerError(
        'Custom-domain provisioner is temporarily unavailable',
        'provisioner_unavailable',
      );
    }
    const responseBody = await readBoundedResponse(response);
    if (!response.ok) {
      throw new CustomDomainProvisionerError(
        'Custom-domain provisioner rejected reconciliation',
        'provisioner_unavailable',
      );
    }
    const responseSignature = response.headers.get(PROVISIONER_SIGNATURE_HEADER) ?? '';
    const expectedSignature = signature(this.options.secret, timestamp, responseBody);
    if (!signaturesEqual(responseSignature, expectedSignature)) {
      throw new CustomDomainProvisionerError(
        'Custom-domain provisioner response could not be authenticated',
        'provisioner_response_unauthenticated',
      );
    }
    let parsed: JsonValue;
    try {
      // SAFETY: JSON.parse of the capped response body only yields JSON-compatible values.
      parsed = JSON.parse(responseBody) as JsonValue;
    } catch {
      throw new CustomDomainProvisionerError(
        'Custom-domain provisioner returned invalid JSON',
        'provisioner_response_invalid',
      );
    }
    const observation = CustomDomainProvisioningObservationSchema.safeParse(parsed);
    if (!observation.success) {
      throw new CustomDomainProvisionerError(
        'Custom-domain provisioner returned an invalid observation',
        'provisioner_response_invalid',
      );
    }
    return observation.data;
  }

  private async postToPinnedPublicProvisioner(
    body: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const configured = new URL(this.options.url);
    const resolved = await validateWebhookUrl(this.options.url, {
      allowHttp: configured.protocol === 'http:',
    });
    return new Promise<Response>((resolve, reject) => {
      const requester = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requester(
        {
          protocol: resolved.url.protocol,
          hostname: resolved.url.hostname,
          port: resolved.url.port || undefined,
          path: `${resolved.url.pathname}${resolved.url.search}`,
          method: 'POST',
          headers,
          servername: resolved.url.hostname,
          lookup: pinnedCustomDomainAddressLookup(resolved.address, resolved.family),
          timeout: this.options.timeoutMs,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
        (incoming) => {
          void readCappedWebhookResponse(incoming, MAX_PROVISIONER_RESPONSE_BYTES)
            .then((responseBody) => {
              const responseHeaders = new Headers({
                'content-length': String(Buffer.byteLength(responseBody)),
                'content-type': String(incoming.headers['content-type'] ?? 'application/json'),
              });
              const signature = incoming.headers[PROVISIONER_SIGNATURE_HEADER];
              if (signature !== undefined) {
                responseHeaders.set(PROVISIONER_SIGNATURE_HEADER, String(signature));
              }
              resolve(
                new Response(responseBody, {
                  status: incoming.statusCode ?? 502,
                  headers: responseHeaders,
                }),
              );
            })
            .catch(reject);
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('Custom-domain provisioner request timed out')),
      );
      request.on('error', reject);
      request.end(body);
    });
  }
}

export function customDomainStatusFromObservation(
  observation: CustomDomainProvisioningObservation,
): CustomDomainRecord['status'] {
  if (observation.desiredState === 'active') {
    if (observation.certificate === 'failed' || observation.routing === 'failed') return 'failed';
    return observation.certificate === 'ready' && observation.routing === 'ready'
      ? 'active'
      : 'provisioning';
  }
  if (observation.desiredState === 'disabled') {
    if (observation.routing === 'failed') return 'failed';
    return observation.routing === 'disabled' ? 'disabled' : 'disabling';
  }
  if (observation.certificate === 'failed' || observation.routing === 'failed') return 'failed';
  return observation.certificate === 'removed' && observation.routing === 'removed'
    ? 'removed'
    : 'removing';
}

export function assertMatchingProvisioningObservation(
  domain: CustomDomainRecord,
  observation: CustomDomainProvisioningObservation,
): void {
  const parsed = CustomDomainProvisioningObservationSchema.safeParse(observation);
  if (!parsed.success) {
    throw new CustomDomainProvisionerError(
      'Custom-domain provisioner returned an invalid observation',
      'provisioner_response_invalid',
    );
  }
  const candidate = parsed.data;
  if (!domain.provisioning) {
    throw new CustomDomainProvisionerError(
      'Custom-domain record has no pending provisioner operation',
      'provisioner_response_invalid',
    );
  }
  let normalized: string;
  try {
    normalized = normalizeCustomDomainHostname(candidate.hostname);
  } catch {
    throw new CustomDomainProvisionerError(
      'Custom-domain provisioner returned another hostname',
      'provisioner_response_invalid',
    );
  }
  if (
    normalized !== domain.hostname ||
    candidate.operationKey !== domain.provisioning.operationKey ||
    candidate.desiredState !== domain.provisioning.desiredState
  ) {
    throw new CustomDomainProvisionerError(
      'Custom-domain provisioner observation is not bound to this operation',
      'provisioner_response_invalid',
    );
  }
  if (
    (candidate.desiredState === 'active' &&
      (candidate.certificate === 'removed' ||
        candidate.routing === 'removed' ||
        candidate.routing === 'disabled')) ||
    (candidate.desiredState === 'disabled' && candidate.routing === 'removed') ||
    (candidate.desiredState === 'removed' &&
      (candidate.certificate === 'ready' || candidate.routing === 'ready'))
  ) {
    throw new CustomDomainProvisionerError(
      'Custom-domain provisioner returned an impossible desired-state observation',
      'provisioner_response_invalid',
    );
  }
}
