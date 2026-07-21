import { createHash, randomUUID } from 'node:crypto';

import {
  constantTimeEqual,
  IdentityTokenVerifier,
  normalizeCustomDomainHostname,
  type ControlPlaneRepository,
  type HostedPublicationRecord,
  type ImmutableObjectStore,
} from '@scenebook/server';
import { SlugSchema } from '@scenebook/schema';
import { deleteCookie, setCookie } from 'hono/cookie';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import {
  createExactFileStream,
  assertCurrentPublication,
  extractPublicationMember,
  loadBoundPublication,
  PublicationResponsePool,
  PublicationArchiveCache,
  PublicationUnavailableError,
  readExactPublicationFile,
} from './archive.js';
import type { PublicationGatewayConfig } from './config.js';
import {
  PublicationBootstrapRejectedError,
  PublicationBootstrapUnavailableError,
  type PublicationBootstrapClient,
} from './bootstrap.js';
import { PortalSessionService, type PortalSessionClaims } from './session.js';

const ShareExchangeSchema = z.object({ token: z.string().min(1).max(8_192) }).strict();
const UserExchangeSchema = z
  .object({
    workspaceSlug: SlugSchema,
    projectSlug: SlugSchema,
    channelSlug: SlugSchema,
  })
  .strict();
const BootstrapExchangeSchema = z.object({ credential: z.string().min(32).max(512) }).strict();
const MAX_HTML_BYTES = 8 * 1024 * 1024;

class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

function expectsHtml(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.headers.get('sec-fetch-dest') === 'document') return true;
  return request.headers.get('accept')?.toLowerCase().includes('text/html') ?? false;
}

function browserErrorCopy(status: number): {
  readonly title: string;
  readonly heading: string;
  readonly detail: string;
  readonly action?: { readonly href: string; readonly label: string };
} {
  if (status === 401 || status === 403) {
    return {
      title: 'Private publication access needed',
      heading: 'This private publication needs a current link',
      detail: 'Open the most recent invitation, or ask the sender for a new link.',
    };
  }
  if (status === 404) {
    return {
      title: 'Publication not found',
      heading: 'Publication not found',
      detail: 'The address may have changed, or this publication may no longer be available.',
      action: { href: '/', label: 'Go to the publication home' },
    };
  }
  if (status === 503) {
    return {
      title: 'Publication temporarily unavailable',
      heading: 'Publication temporarily unavailable',
      detail: 'The publication could not be opened right now. Try again in a moment.',
      action: { href: '', label: 'Try again' },
    };
  }
  return {
    title: 'Publication unavailable',
    heading: 'This publication cannot be opened',
    detail: 'Check the address or try again later.',
    action: { href: '', label: 'Try again' },
  };
}

function browserErrorPage(status: number): string {
  const copy = browserErrorCopy(status);
  const action = copy.action
    ? `<a class="action" href="${copy.action.href}">${copy.action.label}</a>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title><style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f5f6;color:#1c1d1f}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f5f6;color:#1c1d1f}main{width:min(100%,40rem);padding:clamp(28px,6vw,56px);background:#fff;border:1px solid #dfe2e5;border-radius:20px}h1{max-width:18ch;margin:0;font-family:ui-serif,Charter,Georgia,serif;font-size:clamp(2rem,7vw,3.5rem);line-height:1;letter-spacing:-.03em}p{max-width:52ch;margin:20px 0 0;color:#5f646b;font-size:1.0625rem;line-height:1.65}.action{display:inline-flex;min-height:44px;align-items:center;justify-content:center;margin-top:28px;padding:10px 16px;border-radius:10px;background:#1c1d1f;color:#fff;font-weight:700;text-decoration:none}.action:focus-visible{outline:3px solid #2459d1;outline-offset:3px}@media(prefers-color-scheme:dark){:root,body{background:#161719;color:#f4f5f6}main{background:#202225;border-color:#36393d}p{color:#b8bdc3}.action{background:#f4f5f6;color:#1c1d1f}}</style></head><body><main><h1>${copy.heading}</h1><p>${copy.detail}</p>${action}</main></body></html>`;
}

const PRIVATE_ACCESS_STYLES = `:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f5f6;color:#1c1d1f}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f5f6;color:#1c1d1f}main{width:min(100%,40rem);padding:clamp(28px,6vw,56px);background:#fff;border:1px solid #dfe2e5;border-radius:20px}h1{max-width:18ch;margin:0;font-family:ui-serif,Charter,Georgia,serif;font-size:clamp(2rem,7vw,3.5rem);line-height:1;letter-spacing:-.03em}p{max-width:52ch;margin:20px 0 0;color:#5f646b;font-size:1.0625rem;line-height:1.65}.recovery{font-size:.9375rem}noscript p{color:#9e2d2d}@media(prefers-color-scheme:dark){:root,body{background:#161719;color:#f4f5f6}main{background:#202225;border-color:#36393d}p{color:#b8bdc3}noscript p{color:#ff9c9c}}`;

export interface PublicationGatewayDependencies {
  readonly repository: ControlPlaneRepository;
  readonly objectStore: ImmutableObjectStore;
  readonly identityVerifier: IdentityTokenVerifier;
  readonly portalSessions: PortalSessionService;
  readonly bootstrapClient: PublicationBootstrapClient;
  readonly config: Pick<
    PublicationGatewayConfig,
    | 'nodeEnv'
    | 'publicationBaseUrl'
    | 'controlPlaneBaseUrl'
    | 'sessionTtlSeconds'
    | 'maxJsonBytes'
    | 'maxMemberBytes'
    | 'maxCacheBytes'
    | 'maxConcurrentResponses'
    | 'temporaryRoot'
  >;
  readonly now?: () => Date;
}

function bearer(value: string | undefined): string {
  const match = value?.match(/^Bearer ([^\s]+)$/u);
  if (!match) throw new GatewayHttpError(401, 'identity_required', 'Identity session required');
  return match[1]!;
}

async function jsonBody<T>(request: Request, schema: z.ZodType<T>, maximum: number): Promise<T> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new GatewayHttpError(415, 'json_required', 'Expected application/json');
  }
  const declaredHeader = request.headers.get('content-length');
  let declared: number | undefined;
  if (declaredHeader !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredHeader)) {
      throw new GatewayHttpError(400, 'invalid_content_length', 'Content-Length is invalid');
    }
    declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared)) {
      throw new GatewayHttpError(400, 'invalid_content_length', 'Content-Length is invalid');
    }
  }
  if (declared !== undefined && declared > maximum) {
    await request.body?.cancel('Request body exceeds the configured JSON limit').catch(() => {});
    throw new GatewayHttpError(413, 'request_too_large', 'Request body is too large');
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        byteLength += result.value.byteLength;
        if (byteLength > maximum) {
          await reader.cancel('Request body exceeds the configured JSON limit').catch(() => {});
          throw new GatewayHttpError(413, 'request_too_large', 'Request body is too large');
        }
        chunks.push(result.value);
      }
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
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new GatewayHttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayHttpError(422, 'invalid_request', 'Request body does not match the contract');
  }
  return parsed.data;
}

function requestAuthority(request: Request): {
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
} {
  const raw = request.headers.get('host');
  if (!raw || raw !== raw.trim() || /[\s,@/\\?#\u0000-\u001f\u007f]/u.test(raw)) {
    throw new GatewayHttpError(400, 'invalid_host', 'Host header is invalid');
  }
  try {
    const parsed = new URL(`http://${raw}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('Host header is not an authority');
    }
    return {
      host: parsed.host.toLowerCase(),
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port,
    };
  } catch {
    throw new GatewayHttpError(400, 'invalid_host', 'Host header is invalid');
  }
}

function assertSameOrigin(request: Request, production: boolean, required = false): void {
  const origin = request.headers.get('origin');
  if (!origin) {
    if (required) {
      throw new GatewayHttpError(403, 'origin_rejected', 'A same-origin request is required');
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new GatewayHttpError(403, 'origin_rejected', 'Request origin is invalid');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.host.toLowerCase() !== requestAuthority(request).host ||
    (production && parsed.protocol !== 'https:') ||
    (request.headers.get('sec-fetch-site') &&
      request.headers.get('sec-fetch-site') !== 'same-origin')
  ) {
    throw new GatewayHttpError(403, 'origin_rejected', 'Cross-origin credential exchange denied');
  }
}

function canonicalMemberPath(raw: string): string {
  if (!raw || raw === '/') return 'index.html';
  let value = raw.replace(/^\/+|\/+$/gu, '');
  if (!value) return 'index.html';
  try {
    value = value
      .split('/')
      .map((part) => {
        const decoded = decodeURIComponent(part);
        if (decoded.includes('/') || decoded.includes('\\')) {
          throw new Error('Encoded path separator');
        }
        return decoded;
      })
      .join('/');
  } catch {
    throw new GatewayHttpError(400, 'invalid_path', 'Publication path is invalid');
  }
  if (
    value.length > 1_024 ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('/')) ||
    !/^[A-Za-z0-9._/-]+$/u.test(value)
  ) {
    throw new GatewayHttpError(400, 'invalid_path', 'Publication path is invalid');
  }
  return raw.endsWith('/') ? `${value}/index.html` : value;
}

function exactArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function routeMatches(
  route: HostedPublicationRecord,
  workspaceId: string,
  projectId: string,
  channelId: string,
): boolean {
  return (
    route.workspace.id === workspaceId &&
    route.project.id === projectId &&
    route.channel.id === channelId
  );
}

function active(record: { readonly revokedAt?: string; readonly expiresAt: string }, now: number) {
  return !record.revokedAt && new Date(record.expiresAt).getTime() > now;
}

function requestCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function scriptAndStyleCsp(
  html: string,
  controlPlaneOrigin: string,
  frameAncestors: string,
): string {
  const hashes = (expression: RegExp): string[] =>
    [...html.matchAll(expression)].map(
      (match) =>
        `'sha256-${createHash('sha256')
          .update(match[1] ?? '')
          .digest('base64')}'`,
    );
  const scripts = hashes(/<script\b[^>]*>([\s\S]*?)<\/script>/giu);
  const styles = hashes(/<style\b[^>]*>([\s\S]*?)<\/style>/giu);
  return [
    "default-src 'none'",
    `script-src ${scripts.length ? scripts.join(' ') : "'none'"}`,
    "script-src-attr 'none'",
    `style-src-elem ${styles.length ? styles.join(' ') : "'none'"}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${controlPlaneOrigin}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    "manifest-src 'self'",
    "worker-src 'none'",
  ].join('; ');
}

function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (!value) return undefined;
  if (size === 0) throw new GatewayHttpError(416, 'range_unsatisfiable', 'Range is unsatisfiable');
  const match = value.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2])) {
    throw new GatewayHttpError(416, 'range_unsatisfiable', 'Only one byte range is supported');
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new GatewayHttpError(416, 'range_unsatisfiable', 'Range is unsatisfiable');
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    throw new GatewayHttpError(416, 'range_unsatisfiable', 'Range is unsatisfiable');
  }
  return { start, end: Math.min(end, size - 1) };
}

export function createPublicationGatewayApp(dependencies: PublicationGatewayDependencies) {
  const app = new Hono();
  const now = dependencies.now ?? (() => new Date());
  const responsePool = new PublicationResponsePool(dependencies.config.maxConcurrentResponses);
  const archiveCache = new PublicationArchiveCache(
    dependencies.config.temporaryRoot,
    dependencies.config.maxCacheBytes,
    dependencies.config.maxMemberBytes,
  );
  const publicationUrl = new URL(dependencies.config.publicationBaseUrl);
  const defaultHostname = publicationUrl.hostname.toLowerCase();
  const configuredPort = publicationUrl.port;
  const implicitPort = publicationUrl.protocol === 'https:' ? '443' : '80';
  const publicationPortMatches = (port: string): boolean =>
    configuredPort ? port === configuredPort : !port || port === implicitPort;
  const isDefaultPublicationRequest = (request: Request): boolean => {
    const authority = requestAuthority(request);
    return authority.hostname === defaultHostname && publicationPortMatches(authority.port);
  };
  const controlOrigin = new URL(dependencies.config.controlPlaneBaseUrl).origin;
  const secureCookies = dependencies.config.nodeEnv === 'production';
  const cookieName = secureCookies ? '__Host-scenebook_portal' : 'scenebook_portal';

  const resolvePath = async (
    workspaceSlug: string,
    projectSlug: string,
    channelSlug: string,
  ): Promise<HostedPublicationRecord> => {
    for (const value of [workspaceSlug, projectSlug, channelSlug]) {
      if (!SlugSchema.safeParse(value).success) {
        throw new GatewayHttpError(404, 'publication_not_found', 'Publication not found');
      }
    }
    const route = await dependencies.repository.resolveHostedPublication({
      kind: 'path',
      workspaceSlug,
      projectSlug,
      channelSlug,
    });
    if (!route) throw new GatewayHttpError(404, 'publication_not_found', 'Publication not found');
    return route;
  };

  const resolveHost = async (request: Request): Promise<HostedPublicationRecord> => {
    const authority = requestAuthority(request);
    if (!publicationPortMatches(authority.port)) {
      throw new GatewayHttpError(421, 'host_unrecognized', 'Host is not a publication origin');
    }
    const hostname = authority.hostname;
    if (hostname === defaultHostname) {
      throw new GatewayHttpError(404, 'publication_not_found', 'Publication not found');
    }
    let normalized: string;
    try {
      normalized = normalizeCustomDomainHostname(hostname);
    } catch {
      throw new GatewayHttpError(421, 'host_unrecognized', 'Host is not a publication origin');
    }
    const route = await dependencies.repository.resolveHostedPublication({
      kind: 'hostname',
      hostname: normalized,
    });
    if (!route?.customDomain) {
      throw new GatewayHttpError(
        421,
        'host_unrecognized',
        'Host is not an active publication origin',
      );
    }
    return route;
  };

  const currentRouteForGrant = async (
    grant: { readonly workspaceId: string; readonly projectId: string; readonly channelId: string },
    request: Request,
  ): Promise<{ route: HostedPublicationRecord; location: string }> => {
    if (!isDefaultPublicationRequest(request)) {
      const route = await resolveHost(request);
      if (!routeMatches(route, grant.workspaceId, grant.projectId, grant.channelId)) {
        throw new GatewayHttpError(401, 'private_access_invalid', 'Private access is invalid');
      }
      assertCurrentPublication(route);
      return { route, location: '/' };
    }
    const workspace = await dependencies.repository.getWorkspace(grant.workspaceId);
    const project = await dependencies.repository.getProject(grant.workspaceId, grant.projectId);
    const channel = await dependencies.repository.getChannel(
      grant.workspaceId,
      grant.projectId,
      grant.channelId,
    );
    if (!workspace || !project || !channel) {
      throw new GatewayHttpError(401, 'private_access_invalid', 'Private access is invalid');
    }
    const route = await resolvePath(workspace.slug, project.slug, channel.slug);
    if (!routeMatches(route, grant.workspaceId, grant.projectId, grant.channelId)) {
      throw new GatewayHttpError(401, 'private_access_invalid', 'Private access is invalid');
    }
    assertCurrentPublication(route);
    return { route, location: `/s/${workspace.slug}/${project.slug}/${channel.slug}/` };
  };

  const assertLiveUserAccess = async (
    route: HostedPublicationRecord,
    userId: string,
    sourceSessionId: string,
    grant: Awaited<ReturnType<ControlPlaneRepository['getPortalGrant']>>,
    current: number,
  ) => {
    if (
      !grant ||
      grant.subject.kind !== 'user' ||
      grant.subject.userId !== userId ||
      !active(grant, current) ||
      !routeMatches(route, grant.workspaceId, grant.projectId, grant.channelId)
    ) {
      throw new GatewayHttpError(401, 'private_access_revoked', 'Private access was revoked');
    }
    const session = await dependencies.repository.getUserSession(sourceSessionId);
    const source = session
      ? await dependencies.repository.getIdentityApiToken(session.sourceTokenId)
      : undefined;
    const user = await dependencies.repository.getUser(userId);
    if (
      !session ||
      session.userId !== userId ||
      session.workspaceId !== route.workspace.id ||
      (session.projectId && session.projectId !== route.project.id) ||
      (session.channelId && session.channelId !== route.channel.id) ||
      session.revokedAt ||
      new Date(session.expiresAt).getTime() <= current ||
      !session.scopes.includes('channel:read') ||
      !source ||
      source.userId !== session.userId ||
      source.workspaceId !== session.workspaceId ||
      source.projectId !== session.projectId ||
      source.channelId !== session.channelId ||
      !exactArray(source.scopes, session.scopes) ||
      source.revokedAt ||
      new Date(source.expiresAt).getTime() <= current ||
      !user ||
      user.disabledAt
    ) {
      throw new GatewayHttpError(401, 'private_access_revoked', 'Private access was revoked');
    }
    return { session, grant };
  };

  const verifyLivePortalSession = async (
    request: Request,
    route: HostedPublicationRecord,
  ): Promise<PortalSessionClaims> => {
    const token = requestCookie(request, cookieName);
    if (!token)
      throw new GatewayHttpError(401, 'private_access_required', 'Private access required');
    let claims: PortalSessionClaims;
    const currentSeconds = Math.floor(now().getTime() / 1_000);
    try {
      claims = await dependencies.portalSessions.verify(token, currentSeconds);
    } catch {
      throw new GatewayHttpError(401, 'private_access_invalid', 'Private access is invalid');
    }
    if (!routeMatches(route, claims.workspace_id, claims.project_id, claims.channel_id)) {
      throw new GatewayHttpError(403, 'private_access_denied', 'Private access is not valid here');
    }
    const current = currentSeconds * 1_000;
    const grant = await dependencies.repository.getPortalGrant(claims.grant_id);
    if (
      !grant ||
      !active(grant, current) ||
      !routeMatches(route, grant.workspaceId, grant.projectId, grant.channelId)
    ) {
      throw new GatewayHttpError(401, 'private_access_revoked', 'Private access was revoked');
    }
    if (claims.auth_kind === 'share') {
      const link = await dependencies.repository.getPrivateShareLink(claims.link_id!);
      if (
        grant.subject.kind !== 'link' ||
        grant.permission !== 'view' ||
        !link ||
        link.grantId !== grant.id ||
        !active(link, current)
      ) {
        throw new GatewayHttpError(401, 'private_access_revoked', 'Private access was revoked');
      }
      return claims;
    }
    await assertLiveUserAccess(route, claims.user_id!, claims.source_session_id!, grant, current);
    return claims;
  };

  const issueCookie = async (
    context: Context,
    claims: Parameters<PortalSessionService['issue']>[0],
    currentSeconds: number,
  ): Promise<void> => {
    const token = await dependencies.portalSessions.issue(claims, currentSeconds);
    setCookie(context, cookieName, token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.max(1, claims.expiresAt - currentSeconds),
    });
  };

  const servePublication = async (
    context: Context,
    route: HostedPublicationRecord,
    memberPath: string,
  ): Promise<Response> => {
    if (route.channel.kind === 'private-portal') {
      await verifyLivePortalSession(context.req.raw, route);
    } else if (route.channel.kind !== 'public-catalog') {
      throw new GatewayHttpError(404, 'publication_not_found', 'Publication not found');
    }
    let bound;
    try {
      bound = await loadBoundPublication(dependencies.objectStore, route);
    } catch (error) {
      if (error instanceof PublicationUnavailableError) {
        throw new GatewayHttpError(503, 'publication_unavailable', 'Publication is unavailable');
      }
      throw error;
    }
    const descriptor = bound.files.get(memberPath);
    if (!descriptor)
      throw new GatewayHttpError(404, 'publication_member_not_found', 'File not found');
    if (
      bound.inventory.files.some((file) => file.byteLength > dependencies.config.maxMemberBytes)
    ) {
      throw new GatewayHttpError(503, 'publication_unavailable', 'Publication is unavailable');
    }
    const privateResponse = route.channel.kind === 'private-portal';
    const publicEmbed = !privateResponse && memberPath.startsWith('embeds/');
    const etag = `"${descriptor.sha256}"`;
    const headers = new Headers({
      'accept-ranges': 'bytes',
      'cache-control': privateResponse ? 'private, no-store' : 'public, max-age=0, must-revalidate',
      'content-type': descriptor.mediaType,
      etag,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-scenebook-release-id': route.release!.release.id,
      vary: privateResponse ? 'Cookie, Host' : 'Host',
      'cross-origin-resource-policy': publicEmbed ? 'cross-origin' : 'same-origin',
      'permissions-policy':
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
    });
    if (privateResponse || descriptor.mediaType !== 'text/html') {
      headers.set('x-frame-options', 'DENY');
    } else if (!publicEmbed) {
      headers.set('x-frame-options', 'SAMEORIGIN');
    }
    if (
      !privateResponse &&
      !context.req.header('range') &&
      context.req.header('if-none-match') === etag
    ) {
      return new Response(null, { status: 304, headers });
    }
    let range;
    try {
      range = parseRange(context.req.header('range'), descriptor.byteLength);
    } catch (error) {
      if (error instanceof GatewayHttpError && error.status === 416) {
        headers.set('content-range', `bytes */${descriptor.byteLength}`);
        return new Response(null, { status: 416, headers });
      }
      throw error;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, descriptor.byteLength - 1);
    headers.set('content-length', String(descriptor.byteLength === 0 ? 0 : end - start + 1));
    if (range) headers.set('content-range', `bytes ${start}-${end}/${descriptor.byteLength}`);
    if (context.req.method === 'HEAD' || descriptor.byteLength === 0) {
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const release = responsePool.acquire();
    if (!release) {
      throw new GatewayHttpError(503, 'gateway_busy', 'Publication gateway is at capacity');
    }
    let extracted;
    try {
      extracted =
        (await archiveCache.acquire(dependencies.objectStore, bound, memberPath)) ??
        (await extractPublicationMember(dependencies.objectStore, bound, memberPath, {
          temporaryRoot: dependencies.config.temporaryRoot,
          maxMemberBytes: dependencies.config.maxMemberBytes,
        }));
    } catch (error) {
      release();
      if (error instanceof PublicationUnavailableError) {
        throw new GatewayHttpError(503, 'publication_unavailable', 'Publication is unavailable');
      }
      throw error;
    }
    if (descriptor.mediaType === 'text/html') {
      if (descriptor.byteLength > MAX_HTML_BYTES) {
        await extracted.dispose();
        release();
        throw new GatewayHttpError(503, 'publication_unavailable', 'Publication is unavailable');
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await readExactPublicationFile(extracted, release);
      } catch (error) {
        if (error instanceof PublicationUnavailableError) {
          throw new GatewayHttpError(503, 'publication_unavailable', 'Publication is unavailable');
        }
        throw error;
      }
      let html: string;
      try {
        html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new GatewayHttpError(503, 'publication_unavailable', 'Publication is unavailable');
      }
      headers.set(
        'content-security-policy',
        scriptAndStyleCsp(
          html,
          controlOrigin,
          publicEmbed ? '*' : privateResponse ? "'none'" : "'self'",
        ),
      );
      return new Response(range ? bytes.subarray(start, end + 1) : bytes, {
        status: range ? 206 : 200,
        headers,
      });
    }
    headers.set('content-security-policy', "default-src 'none'; sandbox");
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await createExactFileStream(extracted, start, end, release);
    } catch (error) {
      if (error instanceof PublicationUnavailableError) {
        throw new GatewayHttpError(503, 'publication_unavailable', 'Publication is unavailable');
      }
      throw error;
    }
    return new Response(stream, { status: range ? 206 : 200, headers });
  };

  app.onError((error, context) => {
    const status = error instanceof GatewayHttpError ? error.status : 500;
    const code = error instanceof GatewayHttpError ? error.code : 'internal_error';
    const message =
      error instanceof GatewayHttpError
        ? error.message
        : dependencies.config.nodeEnv === 'production'
          ? 'Publication gateway request failed'
          : error instanceof Error
            ? error.message
            : 'Publication gateway request failed';
    const html = expectsHtml(context.req.raw);
    const headers = new Headers({
      'cache-control': 'no-store',
      'content-type': html ? 'text/html; charset=UTF-8' : 'application/json; charset=UTF-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    if (html) {
      headers.set(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      headers.set('x-frame-options', 'DENY');
    }
    const body = html ? browserErrorPage(status) : JSON.stringify({ error: { code, message } });
    return new Response(context.req.method === 'HEAD' ? null : body, { status, headers });
  });

  app.get('/healthz', (context) => context.json({ ok: true, service: 'publication-gateway' }));
  app.get('/readyz', async (context) => {
    await Promise.all([dependencies.repository.health(), dependencies.objectStore.health()]);
    return context.json({ ok: true, service: 'publication-gateway' });
  });

  app.get('/share', (context) => {
    const nonce = createHash('sha256').update(randomUUID()).digest('base64url');
    context.header('cache-control', 'private, no-store');
    context.header('referrer-policy', 'no-referrer');
    context.header('x-content-type-options', 'nosniff');
    context.header('x-frame-options', 'DENY');
    context.header(
      'content-security-policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    );
    return context.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open private publication</title><style>${PRIVATE_ACCESS_STYLES}</style></head><body><main id="access" aria-busy="true"><h1 id="heading">Opening private publication</h1><p id="status" role="status" aria-live="polite">Checking this link…</p><p id="recovery" class="recovery" hidden>Open the most recent invitation, or ask the sender for a new link.</p><noscript><p>JavaScript is required to open this private publication. Enable it and reopen the link, or ask the sender for help.</p></noscript></main><script nonce="${nonce}">(()=>{const main=document.getElementById('access');const heading=document.getElementById('heading');const status=document.getElementById('status');const recovery=document.getElementById('recovery');const fail=message=>{main.setAttribute('aria-busy','false');heading.textContent='This link cannot open the publication';status.setAttribute('role','alert');status.textContent=message;recovery.hidden=false};const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);if(!token){fail('The link is incomplete.');return}fetch('/_scenebook/auth/share',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(async response=>{if(!response.ok)throw new Error('This link is invalid, expired, or revoked.');return response.json()}).then(payload=>window.location.replace(payload.location)).catch(error=>fail(error instanceof Error?error.message:'This link could not be opened.'))})();</script></body></html>`,
    );
  });

  app.get('/login', (context) => {
    if (!isDefaultPublicationRequest(context.req.raw)) {
      throw new GatewayHttpError(421, 'host_route_mismatch', 'Login is not valid on this Host');
    }
    const nonce = createHash('sha256').update(randomUUID()).digest('base64url');
    context.header('cache-control', 'private, no-store');
    context.header('referrer-policy', 'no-referrer');
    context.header('x-content-type-options', 'nosniff');
    context.header('x-frame-options', 'DENY');
    context.header(
      'content-security-policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    );
    return context.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open private publication</title><style>${PRIVATE_ACCESS_STYLES}</style></head><body><main id="access" aria-busy="true"><h1 id="heading">Opening private publication</h1><p id="status" role="status" aria-live="polite">Finishing secure sign-in…</p><p id="recovery" class="recovery" hidden>Open the most recent invitation, or ask the sender for a new link.</p><noscript><p>JavaScript is required to finish sign-in. Enable it and reopen the invitation, or ask the sender for help.</p></noscript></main><script nonce="${nonce}">(()=>{const main=document.getElementById('access');const heading=document.getElementById('heading');const status=document.getElementById('status');const recovery=document.getElementById('recovery');const fail=message=>{main.setAttribute('aria-busy','false');heading.textContent='Sign-in link unavailable';status.setAttribute('role','alert');status.textContent=message;recovery.hidden=false};const credential=new URLSearchParams(location.hash.slice(1)).get('credential');history.replaceState(null,'',location.pathname);if(!credential){fail('The invitation is incomplete.');return}fetch('/_scenebook/auth/bootstrap',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({credential})}).then(async response=>{if(!response.ok)throw new Error('This invitation is invalid, expired, revoked, or already used.');return response.json()}).then(payload=>window.location.replace(payload.location)).catch(error=>fail(error instanceof Error?error.message:'Sign-in could not be completed.'))})();</script></body></html>`,
    );
  });

  app.post('/_scenebook/auth/share', async (context) => {
    assertSameOrigin(context.req.raw, secureCookies);
    const body = await jsonBody(
      context.req.raw,
      ShareExchangeSchema,
      dependencies.config.maxJsonBytes,
    );
    const currentSeconds = Math.floor(now().getTime() / 1_000);
    let claims;
    try {
      claims = await dependencies.identityVerifier.verifyPrivateShare(body.token, currentSeconds);
    } catch {
      throw new GatewayHttpError(401, 'private_share_invalid', 'Private share is invalid');
    }
    const [link, grant] = await Promise.all([
      dependencies.repository.getPrivateShareLink(claims.linkId),
      dependencies.repository.getPortalGrant(claims.grantId),
    ]);
    const current = currentSeconds * 1_000;
    const suppliedHash = dependencies.identityVerifier.hashShareToken(body.token);
    if (
      !link ||
      link.grantId !== claims.grantId ||
      !active(link, current) ||
      Math.floor(new Date(link.expiresAt).getTime() / 1_000) !== claims.expiresAt ||
      !constantTimeEqual(suppliedHash, link.tokenHash) ||
      !grant ||
      grant.id !== link.grantId ||
      grant.subject.kind !== 'link' ||
      grant.permission !== 'view' ||
      !active(grant, current)
    ) {
      throw new GatewayHttpError(401, 'private_share_invalid', 'Private share is invalid');
    }
    const target = await currentRouteForGrant(grant, context.req.raw);
    if (target.route.channel.kind !== 'private-portal') {
      throw new GatewayHttpError(401, 'private_share_invalid', 'Private share is invalid');
    }
    const expiresAt = Math.min(
      claims.expiresAt,
      Math.floor(new Date(grant.expiresAt).getTime() / 1_000),
      currentSeconds + dependencies.config.sessionTtlSeconds,
    );
    await issueCookie(
      context,
      {
        auth_kind: 'share',
        workspace_id: grant.workspaceId,
        project_id: grant.projectId,
        channel_id: grant.channelId,
        grant_id: grant.id,
        link_id: link.id,
        expiresAt,
      },
      currentSeconds,
    );
    context.header('cache-control', 'private, no-store');
    return context.json({
      location: target.location,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    });
  });

  app.post('/_scenebook/auth/session', async (context) => {
    assertSameOrigin(context.req.raw, secureCookies);
    const requested = await jsonBody(
      context.req.raw,
      UserExchangeSchema,
      dependencies.config.maxJsonBytes,
    );
    const defaultRequest = isDefaultPublicationRequest(context.req.raw);
    const route = defaultRequest
      ? await resolvePath(requested.workspaceSlug, requested.projectSlug, requested.channelSlug)
      : await resolveHost(context.req.raw);
    if (
      !defaultRequest &&
      (route.workspace.slug !== requested.workspaceSlug ||
        route.project.slug !== requested.projectSlug ||
        route.channel.slug !== requested.channelSlug)
    ) {
      throw new GatewayHttpError(404, 'publication_not_found', 'Publication not found');
    }
    if (route.channel.kind !== 'private-portal') {
      throw new GatewayHttpError(404, 'publication_not_found', 'Publication not found');
    }
    const currentSeconds = Math.floor(now().getTime() / 1_000);
    let identity;
    try {
      identity = await dependencies.identityVerifier.verifySession(
        bearer(context.req.header('authorization')),
        currentSeconds,
      );
    } catch {
      throw new GatewayHttpError(401, 'identity_invalid', 'Identity session is invalid');
    }
    const session = await dependencies.repository.getUserSession(identity.sessionId);
    const grant = await dependencies.repository.findPortalGrantForUser(
      route.workspace.id,
      route.project.id,
      route.channel.id,
      identity.userId,
      new Date(currentSeconds * 1_000).toISOString(),
    );
    if (
      !session ||
      session.userId !== identity.userId ||
      Math.floor(new Date(session.expiresAt).getTime() / 1_000) !== identity.expiresAt ||
      !grant ||
      grant.subject.kind !== 'user'
    ) {
      throw new GatewayHttpError(
        403,
        'private_access_denied',
        'No active Portal grant allows access',
      );
    }
    await assertLiveUserAccess(route, identity.userId, session.id, grant, currentSeconds * 1_000);
    const expiresAt = Math.min(
      identity.expiresAt,
      Math.floor(new Date(session.expiresAt).getTime() / 1_000),
      Math.floor(new Date(grant.expiresAt).getTime() / 1_000),
      currentSeconds + dependencies.config.sessionTtlSeconds,
    );
    await issueCookie(
      context,
      {
        auth_kind: 'user',
        workspace_id: route.workspace.id,
        project_id: route.project.id,
        channel_id: route.channel.id,
        grant_id: grant.id,
        user_id: identity.userId,
        source_session_id: session.id,
        expiresAt,
      },
      currentSeconds,
    );
    context.header('cache-control', 'private, no-store');
    return context.json({
      location: defaultRequest
        ? `/s/${route.workspace.slug}/${route.project.slug}/${route.channel.slug}/`
        : '/',
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    });
  });

  app.post('/_scenebook/auth/bootstrap', async (context) => {
    if (!isDefaultPublicationRequest(context.req.raw)) {
      throw new GatewayHttpError(421, 'host_route_mismatch', 'Login is not valid on this Host');
    }
    assertSameOrigin(context.req.raw, secureCookies, true);
    const body = await jsonBody(
      context.req.raw,
      BootstrapExchangeSchema,
      dependencies.config.maxJsonBytes,
    );
    const audienceOrigin = publicationUrl.origin;
    let authorization;
    try {
      authorization = await dependencies.bootstrapClient.consume(body.credential, audienceOrigin);
    } catch (error) {
      if (error instanceof PublicationBootstrapRejectedError) {
        throw new GatewayHttpError(
          401,
          'publication_login_invalid',
          'Publication login is invalid',
        );
      }
      if (error instanceof PublicationBootstrapUnavailableError) {
        throw new GatewayHttpError(
          503,
          'publication_login_unavailable',
          'Publication login is unavailable',
        );
      }
      throw error;
    }
    if (authorization.audienceOrigin !== audienceOrigin) {
      throw new GatewayHttpError(401, 'publication_login_invalid', 'Publication login is invalid');
    }
    const target = await currentRouteForGrant(
      {
        workspaceId: authorization.workspaceId,
        projectId: authorization.projectId,
        channelId: authorization.channelId,
      },
      context.req.raw,
    );
    if (
      target.location !== authorization.returnPath ||
      target.route.channel.kind !== 'private-portal'
    ) {
      throw new GatewayHttpError(401, 'publication_login_invalid', 'Publication login is invalid');
    }
    const currentSeconds = Math.floor(now().getTime() / 1_000);
    const grant = await dependencies.repository.getPortalGrant(authorization.grantId);
    const live = await assertLiveUserAccess(
      target.route,
      authorization.userId,
      authorization.sourceSessionId,
      grant,
      currentSeconds * 1_000,
    );
    const expiresAt = Math.min(
      Math.floor(new Date(authorization.expiresAt).getTime() / 1_000),
      Math.floor(new Date(live.session.expiresAt).getTime() / 1_000),
      Math.floor(new Date(live.grant.expiresAt).getTime() / 1_000),
      currentSeconds + dependencies.config.sessionTtlSeconds,
    );
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= currentSeconds) {
      throw new GatewayHttpError(401, 'publication_login_invalid', 'Publication login is invalid');
    }
    await issueCookie(
      context,
      {
        auth_kind: 'user',
        workspace_id: authorization.workspaceId,
        project_id: authorization.projectId,
        channel_id: authorization.channelId,
        grant_id: authorization.grantId,
        user_id: authorization.userId,
        source_session_id: authorization.sourceSessionId,
        expiresAt,
      },
      currentSeconds,
    );
    context.header('cache-control', 'private, no-store');
    context.header('referrer-policy', 'no-referrer');
    return context.json({ location: authorization.returnPath });
  });

  app.delete('/_scenebook/auth/session', (context) => {
    assertSameOrigin(context.req.raw, secureCookies);
    deleteCookie(context, cookieName, { path: '/', secure: secureCookies });
    context.header('cache-control', 'private, no-store');
    return context.body(null, 204);
  });

  const pathHandler = async (context: Context) => {
    if (!isDefaultPublicationRequest(context.req.raw)) {
      throw new GatewayHttpError(
        421,
        'host_route_mismatch',
        'Path route is not valid on this Host',
      );
    }
    const route = await resolvePath(
      context.req.param('workspaceSlug') ?? '',
      context.req.param('projectSlug') ?? '',
      context.req.param('channelSlug') ?? '',
    );
    const prefix = `/s/${route.workspace.slug}/${route.project.slug}/${route.channel.slug}`;
    const pathname = new URL(context.req.url).pathname;
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      throw new GatewayHttpError(404, 'publication_not_found', 'Publication not found');
    }
    const path = canonicalMemberPath(pathname.slice(prefix.length));
    return servePublication(context, route, path);
  };
  app.on(['GET', 'HEAD'], '/s/:workspaceSlug/:projectSlug/:channelSlug', pathHandler);
  app.on(['GET', 'HEAD'], '/s/:workspaceSlug/:projectSlug/:channelSlug/*', pathHandler);

  app.on(['GET', 'HEAD'], '*', async (context) => {
    const route = await resolveHost(context.req.raw);
    const path = canonicalMemberPath(new URL(context.req.url).pathname);
    return servePublication(context, route, path);
  });

  return app;
}

export type PublicationGatewayApp = ReturnType<typeof createPublicationGatewayApp>;
