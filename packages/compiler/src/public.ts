import type { PublicationDistribution, PublicAnalyticsRuntime, PublicCtaRuntime } from './types.js';

const ID = '[a-z0-9][a-z0-9._:-]{0,127}';
const PUBLIC_ANALYTICS_PATH = new RegExp(
  `^/v1/public/workspaces/${ID}/projects/${ID}/channels/${ID}/analytics$`,
  'u',
);
const PUBLIC_CTA_PATH = new RegExp(
  `^/v1/public/workspaces/${ID}/projects/${ID}/channels/${ID}/cta$`,
  'u',
);
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const DEFAULT_PUBLIC_DISTRIBUTION: PublicationDistribution = Object.freeze({
  seo: Object.freeze({ index: false, follow: false }),
  attribution: true,
  remix: true,
});

function publicUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} cannot contain credentials, a query string, or a fragment.`);
  }
  return parsed;
}

export function effectivePublicBaseUrl(distribution: PublicationDistribution): string | undefined {
  if (distribution.baseUrl) {
    const parsed = publicUrl(distribution.baseUrl, 'Publication baseUrl');
    if (distribution.customDomain && parsed.hostname !== distribution.customDomain) {
      throw new Error('Publication baseUrl hostname must match customDomain.');
    }
    if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`;
    return parsed.toString();
  }
  if (!distribution.customDomain) return undefined;
  if (!HOSTNAME.test(distribution.customDomain)) {
    throw new Error('Publication customDomain must be a lowercase DNS hostname.');
  }
  return `https://${distribution.customDomain}/`;
}

export function absolutePublicationUrl(
  distribution: PublicationDistribution,
  path: string,
): string | undefined {
  const base = effectivePublicBaseUrl(distribution);
  return base ? new URL(path, base).toString() : undefined;
}

export function publicArtifactUrl(distribution: PublicationDistribution, path: string): string {
  return absolutePublicationUrl(distribution, path) ?? path;
}

export function robotsDirective(distribution: PublicationDistribution): string {
  return `${distribution.seo.index ? 'index' : 'noindex'},${distribution.seo.follow ? 'follow' : 'nofollow'}`;
}

export interface PublicPublicationRuntimes {
  readonly analytics?: PublicAnalyticsRuntime;
  readonly cta?: PublicCtaRuntime;
}

function validatePublicService(
  service: 'analytics' | 'CTA',
  endpointValue: string,
  path: RegExp,
): void {
  const endpoint = publicUrl(endpointValue, `Public ${service} endpoint`);
  if (
    endpoint.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  ) {
    throw new Error(
      `Public ${service} endpoint must use HTTPS except for explicit loopback development.`,
    );
  }
  if (!path.test(endpoint.pathname)) {
    throw new Error(
      `Public ${service} endpoint must use the exact Scenebook Channel ${service === 'CTA' ? 'cta' : 'analytics'} path.`,
    );
  }
}

function validatePublicToken(token: string, service: 'analytics' | 'CTA'): void {
  if (token.length < 16 || token.length > 2_048) {
    throw new Error(`Public ${service} token must contain between 16 and 2048 characters.`);
  }
}

export function validatePublicationDistribution(
  distribution: PublicationDistribution,
  runtimes: PublicPublicationRuntimes = {},
  requireConfiguredRuntimes = false,
): void {
  effectivePublicBaseUrl(distribution);
  if (distribution.seo.title !== undefined && distribution.seo.title.trim().length === 0) {
    throw new Error('Publication SEO title cannot be empty.');
  }
  if (
    distribution.seo.description !== undefined &&
    distribution.seo.description.trim().length === 0
  ) {
    throw new Error('Publication SEO description cannot be empty.');
  }
  const analytics = distribution.analytics;
  const analyticsRuntime = runtimes.analytics;
  if (!analytics && analyticsRuntime) {
    throw new Error('Public analytics runtime was supplied without publication metadata.');
  }
  if (analytics && !analyticsRuntime && requireConfiguredRuntimes) {
    throw new Error(
      'Public analytics is configured but its build-time token is unavailable. Supply the configured token environment variable.',
    );
  }
  if (analytics && analyticsRuntime) {
    validatePublicService('analytics', analytics.endpoint, PUBLIC_ANALYTICS_PATH);
    if (
      analyticsRuntime.endpoint !== analytics.endpoint ||
      analyticsRuntime.releaseId !== analytics.releaseId ||
      analyticsRuntime.respectDoNotTrack !== analytics.respectDoNotTrack
    ) {
      throw new Error('Public analytics runtime does not match the reviewed publication metadata.');
    }
    validatePublicToken(analyticsRuntime.token, 'analytics');
  }

  const cta = distribution.cta;
  const ctaRuntime = runtimes.cta;
  if (!cta && ctaRuntime) {
    throw new Error('Public CTA runtime was supplied without publication metadata.');
  }
  if (cta && !ctaRuntime && requireConfiguredRuntimes) {
    throw new Error(
      'Public CTA submission is configured but its build-time token is unavailable. Supply the configured token environment variable.',
    );
  }
  if (cta && ctaRuntime) {
    validatePublicService('CTA', cta.endpoint, PUBLIC_CTA_PATH);
    if (ctaRuntime.endpoint !== cta.endpoint || ctaRuntime.releaseId !== cta.releaseId) {
      throw new Error('Public CTA runtime does not match the reviewed publication metadata.');
    }
    validatePublicToken(ctaRuntime.token, 'CTA');
  }
}
