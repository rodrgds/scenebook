import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteAsset, getAsset, putAsset } from './asset-store.js';

interface Harness {
  readonly database: {
    close: ReturnType<typeof vi.fn>;
    objectStoreNames: { contains(name: string): boolean };
    createObjectStore: ReturnType<typeof vi.fn>;
    onversionchange: (() => void) | null;
    transaction: ReturnType<typeof vi.fn>;
  };
  readonly openRequest: Record<string, unknown> & {
    result: Harness['database'];
    error: DOMException | null;
    onsuccess: (() => void) | null;
  };
  readonly request: Record<string, unknown> & {
    result: unknown;
    error: DOMException | null;
    onsuccess: (() => void) | null;
    onerror: (() => void) | null;
  };
  readonly transaction: Record<string, unknown> & {
    error: DOMException | null;
    oncomplete: (() => void) | null;
    onabort: (() => void) | null;
    onerror: (() => void) | null;
    abort: ReturnType<typeof vi.fn>;
  };
  open(): void;
}

function harness(): Harness {
  const request = {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  } as Harness['request'];
  const store = {
    put: vi.fn(() => request),
    get: vi.fn(() => request),
    delete: vi.fn(() => request),
    clear: vi.fn(() => request),
  };
  const transaction = {
    error: null,
    oncomplete: null,
    onabort: null,
    onerror: null,
    abort: vi.fn(),
    objectStore: vi.fn(() => store),
  } as Harness['transaction'];
  const database = {
    close: vi.fn(),
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    onversionchange: null,
    transaction: vi.fn(() => transaction),
  } as Harness['database'];
  const openRequest = {
    result: database,
    error: null,
    onsuccess: null,
    onerror: null,
    onblocked: null,
    onupgradeneeded: null,
  } as Harness['openRequest'];
  vi.stubGlobal('indexedDB', { open: vi.fn(() => openRequest) });
  return {
    database,
    openRequest,
    request,
    transaction,
    open: () => openRequest.onsuccess?.(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recorder asset store transactions', () => {
  it('does not resolve a write until the read-write transaction commits', async () => {
    const value = harness();
    const promise = putAsset('abc', new Uint8Array([1, 2, 3]));
    value.open();
    await Promise.resolve();

    let settled = false;
    void promise.finally(() => {
      settled = true;
    });
    value.request.result = undefined;
    value.request.onsuccess?.();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(value.database.close).not.toHaveBeenCalled();

    value.transaction.oncomplete?.();
    await expect(promise).resolves.toBeUndefined();
    expect(value.database.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['abort', 'onabort'],
    ['transaction error', 'onerror'],
  ] as const)('rejects a %s after request success and closes the database', async (_, event) => {
    const value = harness();
    const promise = deleteAsset('abc');
    value.open();
    await Promise.resolve();
    value.request.onsuccess?.();
    value.transaction.error = new DOMException('commit failed', 'AbortError');

    value.transaction[event]?.();

    await expect(promise).rejects.toThrow('commit failed');
    expect(value.database.close).toHaveBeenCalledOnce();
  });

  it('rejects a request error, aborts the transaction, and closes the database', async () => {
    const value = harness();
    const promise = getAsset('abc');
    value.open();
    await Promise.resolve();
    value.request.error = new DOMException('read failed', 'DataError');

    value.request.onerror?.();

    await expect(promise).rejects.toThrow('read failed');
    expect(value.transaction.abort).toHaveBeenCalledOnce();
    expect(value.database.close).toHaveBeenCalledOnce();
  });

  it('closes the database when starting the transaction throws', async () => {
    const value = harness();
    value.database.transaction.mockImplementation(() => {
      throw new DOMException('database closing', 'InvalidStateError');
    });
    const promise = putAsset('abc', new Uint8Array([1]));
    value.open();

    await expect(promise).rejects.toThrow('database closing');
    expect(value.database.close).toHaveBeenCalledOnce();
  });
});
