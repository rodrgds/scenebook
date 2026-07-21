import { CliError } from './types.js';

const SENSITIVE_NAME_PARTS = new Set([
  'apikey',
  'auth',
  'authorization',
  'code',
  'cookie',
  'credential',
  'email',
  'jwt',
  'password',
  'passwd',
  'phone',
  'secret',
  'session',
  'sessionid',
  'signature',
  'token',
]);

function sensitiveName(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
  if (SENSITIVE_NAME_PARTS.has(normalized)) return true;
  const parts = name.toLowerCase().split(/[^a-z0-9]+/u);
  if (parts.some((part) => SENSITIVE_NAME_PARTS.has(part))) return true;
  return ['apikey', 'credential', 'password', 'secret', 'sessionid', 'signature', 'token'].some(
    (suffix) => normalized.length > suffix.length && normalized.endsWith(suffix),
  );
}

function likelySecret(value: string): boolean {
  const candidate = value.trim();
  return (
    /^(?:basic|bearer)\s+/iu.test(candidate) ||
    /^(?:gh[pousr]_|rk_live_|sk-|sk_live_|xox[baprs]-)/u.test(candidate) ||
    /^[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u.test(candidate) ||
    (candidate.length >= 40 && /^[A-Za-z0-9._~-]+$/u.test(candidate))
  );
}

function decodedFragment(url: URL): string {
  try {
    return decodeURIComponent(url.hash.slice(1));
  } catch {
    throw new CliError('Recording URL fragment is not valid percent-encoded text.');
  }
}

export interface RecordingTarget {
  readonly href: string;
  readonly local: boolean;
}

export function prepareRecordingTarget(rawUrl: string): RecordingTarget {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError('Recording URL must be an absolute HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('Recording URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new CliError(
      'Recording URL must not contain username or password credentials. Use a synthetic login inside the recorder instead.',
    );
  }
  for (const [name, value] of url.searchParams) {
    if (sensitiveName(name) || likelySecret(value)) {
      throw new CliError(
        `Recording URL contains a sensitive query parameter (${name}). Remove it before launching the recorder.`,
      );
    }
  }
  const fragment = decodedFragment(url);
  if (
    fragment &&
    (likelySecret(fragment) ||
      /(?:^|[?&#/_.:-])(?:api[-_]?key|auth|code|credential|jwt|pass(?:word|wd)?|secret|session(?:id)?|signature|token)(?:$|[=&/_.:-])/iu.test(
        fragment,
      ))
  ) {
    throw new CliError(
      'Recording URL fragment appears to contain credentials or another secret. Remove it before launching the recorder.',
    );
  }

  const hostname = url.hostname.toLowerCase();
  const local =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  return { href: url.href, local };
}
