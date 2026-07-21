import { describe, expect, it } from 'vitest';

import {
  HttpPublicationBootstrapClient,
  PublicationBootstrapUnavailableError,
} from '../src/bootstrap.js';

describe('HTTP publication bootstrap client', () => {
  it('prechecks declared response size and cancels chunked overflow incrementally', async () => {
    let declaredCancelled = false;
    const declaredClient = new HttpPublicationBootstrapClient(
      'http://control.internal:4310',
      'exchange-secret-'.padEnd(64, 'x'),
      5_000,
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array([0x7b, 0x7d]));
            },
            cancel() {
              declaredCancelled = true;
            },
          }),
          { status: 200, headers: { 'content-length': String(32 * 1024 + 1) } },
        )) as typeof fetch,
    );
    await expect(
      declaredClient.consume('credential', 'https://publish.example'),
    ).rejects.toBeInstanceOf(PublicationBootstrapUnavailableError);
    expect(declaredCancelled).toBe(true);

    let chunkedCancelled = false;
    let chunk = 0;
    const chunkedClient = new HttpPublicationBootstrapClient(
      'http://control.internal:4310',
      'exchange-secret-'.padEnd(64, 'x'),
      5_000,
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (chunk++ < 3) {
                controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
              }
            },
            cancel() {
              chunkedCancelled = true;
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    );
    await expect(
      chunkedClient.consume('credential', 'https://publish.example'),
    ).rejects.toBeInstanceOf(PublicationBootstrapUnavailableError);
    expect(chunkedCancelled).toBe(true);
  });
});
