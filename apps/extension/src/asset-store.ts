const DATABASE = 'scenebook-recorder-v1';
const ASSETS = 'assets';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(message));
    };
    request.onerror = () => fail('Could not open recorder storage');
    request.onblocked = () => fail('Recorder storage upgrade was blocked by another tab');
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ASSETS)) {
        request.result.createObjectStore(ASSETS);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let requestSucceeded = false;
    let result: T;
    let transaction: IDBTransaction;

    const close = (): void => database.close();
    const fail = (error: DOMException | Error | null, fallback: string): void => {
      if (settled) return;
      settled = true;
      close();
      reject(error ?? new Error(fallback));
    };

    try {
      transaction = database.transaction(ASSETS, mode);
    } catch (error) {
      fail(error as Error, 'Could not start recorder storage transaction');
      return;
    }

    transaction.onabort = () => fail(transaction.error, 'Recorder storage transaction was aborted');
    transaction.onerror = () => fail(transaction.error, 'Recorder storage transaction failed');
    transaction.oncomplete = () => {
      if (settled) return;
      if (!requestSucceeded) {
        fail(null, 'Recorder storage transaction completed without a request result');
        return;
      }
      settled = true;
      close();
      resolve(result);
    };

    let request: IDBRequest<T>;
    try {
      request = operation(transaction.objectStore(ASSETS));
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // A transaction can already be inactive; the original operation error is authoritative.
      }
      fail(error as Error, 'Recorder storage operation failed');
      return;
    }
    request.onsuccess = () => {
      result = request.result;
      requestSucceeded = true;
    };
    request.onerror = () => {
      const error = request.error;
      try {
        transaction.abort();
      } catch {
        // IndexedDB normally aborts failed requests automatically.
      }
      fail(error, 'Recorder storage request failed');
    };
  });
}

export async function putAsset(hash: string, bytes: Uint8Array): Promise<void> {
  await transact('readwrite', (store) => store.put(bytes, hash));
}

export async function getAsset(hash: string): Promise<Uint8Array | undefined> {
  return await transact<Uint8Array | undefined>('readonly', (store) => store.get(hash));
}

export async function deleteAsset(hash: string): Promise<void> {
  await transact('readwrite', (store) => store.delete(hash));
}

export async function clearAssets(): Promise<void> {
  await transact('readwrite', (store) => store.clear());
}
