import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import type { WebhookConfig } from './config.js';

function blockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (!/^[23][0-9a-f]{3}:/u.test(normalized) || normalized.startsWith('2001:db8:')) return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  return mapped ? !blockedIpv4(mapped) : true;
}

export async function validateWebhookUrl(
  value: string,
  options: { readonly allowHttp?: boolean } = {},
): Promise<{ readonly url: URL; readonly address: string; readonly family: 4 | 6 }> {
  const url = new URL(value);
  if (url.username || url.password) throw new Error('Webhook URLs cannot contain credentials');
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    throw new Error('Webhook URLs must use HTTPS');
  }
  if (url.hash) throw new Error('Webhook URLs cannot contain fragments');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Webhook hostname is not public');
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error('Webhook hostname resolves to a private, reserved, or unsafe address');
  }
  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export interface WebhookResponse {
  readonly status: number;
  readonly body: string;
}

export const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

export function readCappedWebhookResponse(
  stream: NodeJS.ReadableStream & { destroy(error?: Error): void },
  maximumBytes = MAX_WEBHOOK_RESPONSE_BYTES,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maximumBytes) {
        const error = new Error(`Webhook response exceeded ${maximumBytes} bytes`);
        stream.destroy(error);
        fail(error);
        return;
      }
      chunks.push(buffer);
    });
    stream.once('error', (error) =>
      fail(error instanceof Error ? error : new Error(String(error))),
    );
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export class WebhookDispatcher {
  private readonly configured: ReadonlyMap<string, WebhookConfig>;

  constructor(
    webhooks: readonly WebhookConfig[],
    private readonly allowHttp = false,
  ) {
    this.configured = new Map(webhooks.map((webhook) => [webhook.id, webhook]));
    if (this.configured.size !== webhooks.length) throw new Error('Webhook IDs must be unique');
  }

  get(id: string): WebhookConfig {
    const webhook = this.configured.get(id);
    if (!webhook) throw new Error(`Unknown preconfigured webhook: ${id}`);
    return webhook;
  }

  async deliver(id: string, payload: unknown, now = new Date()): Promise<WebhookResponse> {
    const webhook = this.get(id);
    const resolved = await validateWebhookUrl(webhook.url, { allowHttp: this.allowHttp });
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    const signature = createHmac('sha256', webhook.secret)
      .update(timestamp)
      .update('.')
      .update(body)
      .digest('hex');
    return new Promise<WebhookResponse>((resolve, reject) => {
      const requester = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requester(
        {
          protocol: resolved.url.protocol,
          hostname: resolved.url.hostname,
          port: resolved.url.port || undefined,
          path: `${resolved.url.pathname}${resolved.url.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'Scenebook-Webhook/1.0',
            'x-scenebook-timestamp': timestamp,
            'x-scenebook-signature': `sha256=${signature}`,
          },
          servername: resolved.url.hostname,
          lookup: (_hostname, _options, callback) =>
            callback(null, resolved.address, resolved.family),
          timeout: webhook.timeoutMs,
        },
        (response) => {
          void readCappedWebhookResponse(response)
            .then((responseBody) => {
              const status = response.statusCode ?? 0;
              if (status < 200 || status >= 300) {
                reject(new Error(`Webhook returned HTTP ${status}`));
              } else {
                resolve({ status, body: responseBody });
              }
            })
            .catch(reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('Webhook delivery timed out')));
      request.on('error', reject);
      request.end(body);
    });
  }
}
