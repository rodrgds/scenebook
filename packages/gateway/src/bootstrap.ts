import { z } from 'zod';

const MAX_RESPONSE_BYTES = 32 * 1024;

const PublicationBootstrapAuthorizationSchema = z
  .object({
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    channelId: z.string().min(1),
    userId: z.string().min(1),
    sourceSessionId: z.string().min(1),
    grantId: z.string().min(1),
    audienceOrigin: z.string().url(),
    returnPath: z.string().startsWith('/s/').max(2_048),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const PublicationBootstrapResponseSchema = z
  .object({ authorization: PublicationBootstrapAuthorizationSchema })
  .strict();

export type PublicationBootstrapAuthorization = z.infer<
  typeof PublicationBootstrapAuthorizationSchema
>;

export interface PublicationBootstrapClient {
  consume(credential: string, audienceOrigin: string): Promise<PublicationBootstrapAuthorization>;
}

export class PublicationBootstrapRejectedError extends Error {
  constructor() {
    super('Publication login was rejected');
    this.name = 'PublicationBootstrapRejectedError';
  }
}

export class PublicationBootstrapUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Publication login service is unavailable', options);
    this.name = 'PublicationBootstrapUnavailableError';
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredHeader)) {
      await response.body?.cancel('Invalid Content-Length').catch(() => undefined);
      throw new PublicationBootstrapUnavailableError();
    }
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
      await response.body
        ?.cancel('Response exceeds the configured byte limit')
        .catch(() => undefined);
      throw new PublicationBootstrapUnavailableError();
    }
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        byteLength += result.value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel('Response exceeds the configured byte limit').catch(() => undefined);
          throw new PublicationBootstrapUnavailableError();
        }
        chunks.push(result.value);
      }
    } catch (error) {
      if (error instanceof PublicationBootstrapUnavailableError) throw error;
      await reader.cancel('Response read failed').catch(() => undefined);
      throw new PublicationBootstrapUnavailableError({ cause: error });
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class HttpPublicationBootstrapClient implements PublicationBootstrapClient {
  private readonly endpoint: string;

  constructor(
    internalBaseUrl: string,
    private readonly exchangeSecret: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = `${new URL(internalBaseUrl).origin}/v1/internal/publication-login/consume`;
  }

  async consume(
    credential: string,
    audienceOrigin: string,
  ): Promise<PublicationBootstrapAuthorization> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.exchangeSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ credential, audienceOrigin }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new PublicationBootstrapUnavailableError({ cause: error });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new PublicationBootstrapRejectedError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PublicationBootstrapUnavailableError();
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponse(response);
    } catch (error) {
      if (error instanceof PublicationBootstrapUnavailableError) throw error;
      throw new PublicationBootstrapUnavailableError({ cause: error });
    }
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return PublicationBootstrapResponseSchema.parse(value).authorization;
    } catch (error) {
      throw new PublicationBootstrapUnavailableError({ cause: error });
    }
  }
}
