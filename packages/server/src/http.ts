import type { JsonObject, JsonValue } from '@scenebook/schema';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: JsonObject;

  constructor(status: number, code: string, message: string, details?: JsonObject) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function assertDeclaredLength(request: Request, maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('Maximum request bytes must be a non-negative safe integer');
  }
  const declared = request.headers.get('content-length');
  if (declared === null) return;
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length < 0)
    throw new HttpError(400, 'invalid_content_length', 'Invalid Content-Length');
  if (length > maximumBytes)
    throw new HttpError(413, 'body_too_large', `Request body exceeds ${maximumBytes} bytes`);
}

export async function* readLimitedStream(
  request: Request,
  maximumBytes: number,
): AsyncGenerator<Uint8Array> {
  assertDeclaredLength(request, maximumBytes);
  if (!request.body) return;
  const reader = request.body.getReader();
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('body limit exceeded');
        throw new HttpError(413, 'body_too_large', `Request body exceeds ${maximumBytes} bytes`);
      }
      yield value;
    }
  } finally {
    if (!completed) await reader.cancel('request body consumer stopped').catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readLimitedBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readLimitedStream(request, maximumBytes)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readJsonBody(request: Request, maximumBytes: number): Promise<JsonValue> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json')
    throw new HttpError(415, 'json_required', 'Content-Type must be application/json');
  const bytes = await readLimitedBytes(request, maximumBytes);
  if (bytes.byteLength === 0) throw new HttpError(400, 'body_required', 'Request body is required');
  try {
    // SAFETY: JSON.parse of a fatal-decoded UTF-8 body only yields JSON-compatible values.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonValue;
  } catch (error) {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid UTF-8 JSON', {
      cause: error instanceof Error ? error.name : 'unknown',
    });
  }
}
