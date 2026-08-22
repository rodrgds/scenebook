export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TargetSnapshot = {
  accessibleName?: string;
  nearbyText?: string;
  role?: string;
  selectors: string[];
  rect?: NormalizedRect;
  /** Whether the target had rendered bounds inside the captured viewport. */
  visible?: boolean;
  /** Whether no sampled point in the visible target bounds could receive pointer input. */
  occluded?: boolean;
};

export type CaptureMask = NormalizedRect & {
  reason: 'author' | 'embedded-content' | 'payment' | 'personal-data' | 'secret';
};

export type CapturedState = {
  createdAt: string;
  route: string;
  assetHash: string;
  assetMime: 'image/png';
  masks: CaptureMask[];
  viewport: { width: number; height: number; devicePixelRatio: number };
};

export type CapturedStep = CapturedState & {
  id: string;
  kind: 'capture';
  title: string;
  caption: string;
  target?: TargetSnapshot;
};

type DraftCheck = {
  id: string;
  kind: 'visible';
  label: string;
  target: TargetSnapshot;
};

export type RecorderSession = {
  id: string;
  tabId: number;
  sceneId: string;
  title: string;
  startedAt: string;
  status: 'recording' | 'stopped';
  steps: CapturedStep[];
  checks: DraftCheck[];
  /** Latest privacy-scrubbed pre-action frame. It is consumed when the next action is recorded. */
  checkpoint?: CapturedState;
};

export type RecorderMessage =
  | { type: 'status' }
  | { type: 'start'; title: string }
  | { type: 'stop' }
  | { type: 'undo' }
  | { type: 'clear' }
  | { type: 'download' }
  | { type: 'open-studio' }
  | {
      type: 'capture';
      title: string;
      route: string;
      target?: TargetSnapshot;
      masks: CaptureMask[];
      viewport: CapturedStep['viewport'];
    }
  | {
      /** Refresh the pre-action frame without adding a user-visible Step. */
      type: 'checkpoint';
      route: string;
      masks: CaptureMask[];
      viewport: CapturedStep['viewport'];
    }
  | {
      /** Attach an action to the already-captured pre-action frame. */
      type: 'capture-action';
      title: string;
      target: TargetSnapshot;
    }
  | { type: 'add-check'; label: string; target: TargetSnapshot };

export type RecorderResponse =
  | {
      ok: true;
      session?: RecorderSession;
      imported?: boolean;
      downloadId?: number;
    }
  | { ok: false; error: string };

export const SESSION_KEY = 'scenebook.recorder.session.v1';

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return slug || `scene-${Date.now()}`;
}

const RECORDED_SECRET_PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:gh[pousr]_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu,
  /\b(?:\d[ -]*?){13,19}\b/gu,
];

export function sanitizeRecordedText(value: string): string {
  let sanitized = value;
  for (const pattern of RECORDED_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, '[PRIVATE]');
  }
  return sanitized;
}

export function containsSensitiveRecordedText(value: string): boolean {
  return sanitizeRecordedText(value) !== value;
}

function sanitizedPathname(pathname: string): string {
  const segments = pathname.split('/').map((segment) => {
    if (!segment) return segment;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return '__redacted__';
    }
    const opaqueIdentifier =
      /^[a-f0-9]{24,}$/iu.test(decoded) ||
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(decoded);
    return containsSensitiveRecordedText(decoded) || opaqueIdentifier
      ? '__redacted__'
      : encodeURIComponent(decoded).replaceAll('%3A', ':').replaceAll('%40', '@');
  });
  return segments.join('/') || '/';
}

/**
 * Routes are useful replay context, but query strings and fragments routinely
 * contain access tokens, email addresses, search terms, and opaque user IDs.
 * The recorder therefore drops query/fragment/userinfo and redacts sensitive
 * or opaque pathname segments before the route reaches session storage.
 */
export function sanitizeRecordedRoute(value: string): string {
  try {
    const route = new URL(value);
    if (route.protocol !== 'http:' && route.protocol !== 'https:') return '/';
    return `${route.origin}${sanitizedPathname(route.pathname)}`;
  } catch {
    return '/';
  }
}
