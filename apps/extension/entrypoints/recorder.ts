import {
  containsSensitiveRecordedText,
  sanitizeRecordedText,
  type CaptureMask,
  type NormalizedRect,
  type RecorderMessage,
  type TargetSnapshot,
} from '../src/protocol';

const REDACT_ATTRIBUTE = 'data-scenebook-redact';
const EXCLUDE_ATTRIBUTE = 'data-scenebook-recorder-ui';
let checkpointAvailable = false;
let checkpointPromise: Promise<boolean> = Promise.resolve(false);

function normalizeRect(rect: DOMRect): NormalizedRect | undefined {
  if (innerWidth <= 0 || innerHeight <= 0) return undefined;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right);
  const bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return undefined;
  return {
    x: left / innerWidth,
    y: top / innerHeight,
    width: (right - left) / innerWidth,
    height: (bottom - top) / innerHeight,
  };
}

function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isRendered(element: Element): boolean {
  if (!element.isConnected) return false;
  let current: Element | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    current = composedParent(current);
  }
  return true;
}

function belongsToTarget(target: Element, candidate: Element | undefined): boolean {
  let current: Element | null = candidate ?? null;
  while (current) {
    if (current === target) return true;
    current = composedParent(current);
  }
  // Hit testing from the document retargets open-shadow descendants to their
  // host. Accept only hosts reached through a shadow boundary, never arbitrary
  // light-DOM ancestors that may actually be covering the target.
  current = target;
  while (current) {
    const root = current.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    if (root.host === candidate) return true;
    current = root.host;
  }
  return false;
}

function targetGeometry(
  element: HTMLElement,
): Pick<TargetSnapshot, 'rect' | 'visible' | 'occluded'> {
  const rect = normalizeRect(element.getBoundingClientRect());
  if (!rect || !isRendered(element)) return { visible: false, occluded: false };
  const left = rect.x * innerWidth;
  const top = rect.y * innerHeight;
  const right = (rect.x + rect.width) * innerWidth;
  const bottom = (rect.y + rect.height) * innerHeight;
  const insetX = Math.min(2, (right - left) / 4);
  const insetY = Math.min(2, (bottom - top) / 4);
  const xValues = [left + insetX, (left + right) / 2, right - insetX];
  const yValues = [top + insetY, (top + bottom) / 2, bottom - insetY];
  const reachable = xValues.some((x) =>
    yValues.some((y) => {
      const hit = document
        .elementsFromPoint(x, y)
        .find((candidate) => !candidate.closest(`[${EXCLUDE_ATTRIBUTE}]`));
      return belongsToTarget(element, hit);
    }),
  );
  return { rect, visible: true, occluded: !reachable };
}

function escapeText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").trim();
}

function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  const label = labelledBy
    ? labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(' ')
    : undefined;
  return (
    element.getAttribute('aria-label') ??
    label ??
    (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : undefined) ??
    element.getAttribute('alt') ??
    element.getAttribute('title') ??
    (!element.isContentEditable
      ? element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120)
      : undefined) ??
    ''
  );
}

function safeNearbyText(element: HTMLElement): string {
  const parent = element.parentElement;
  if (!parent) return '';
  const clone = parent.cloneNode(true) as HTMLElement;
  for (const excluded of clone.querySelectorAll(
    `script, style, noscript, [${EXCLUDE_ATTRIBUTE}]`,
  )) {
    excluded.remove();
  }
  const candidates = [
    ...(clone.matches(`input, textarea, [contenteditable], [${REDACT_ATTRIBUTE}]`) ? [clone] : []),
    ...clone.querySelectorAll<HTMLElement>(
      `input, textarea, [contenteditable], [${REDACT_ATTRIBUTE}]`,
    ),
  ];
  for (const candidate of candidates) {
    // Current input values are properties rather than text nodes, but clearing both the
    // property and subtree also removes default textarea values and contenteditable text.
    if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
      candidate.value = '';
    }
    candidate.replaceChildren('[PRIVATE]');
  }
  return sanitizeRecordedText(clone.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? '');
}

function implicitRole(element: HTMLElement): string | undefined {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLAnchorElement) return 'link';
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') return 'checkbox';
    if (element.type === 'radio') return 'radio';
    return 'textbox';
  }
  if (element instanceof HTMLSelectElement) return 'combobox';
  return undefined;
}

function cssPath(element: HTMLElement): string {
  const parts: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== document.body && parts.length < 4) {
    const id = current.id;
    if (id) {
      parts.unshift(`#${CSS.escape(id)}`);
      break;
    }
    let part = current.tagName.toLowerCase();
    const parent: HTMLElement | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName === current?.tagName,
      );
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ');
}

function targetSnapshot(element: HTMLElement): TargetSnapshot {
  const rawName = accessibleName(element);
  const sensitiveTarget = Boolean(isSensitive(element));
  const name = sensitiveTarget ? '' : sanitizeRecordedText(rawName);
  const role = implicitRole(element);
  const selectors: string[] = [];
  const testId = element.getAttribute('data-testid');
  if (testId) selectors.push(`getByTestId('${escapeText(testId)}')`);
  if (role && rawName && !sensitiveTarget && !containsSensitiveRecordedText(rawName))
    selectors.push(`getByRole('${role}', { name: '${escapeText(rawName)}' })`);
  if (element.id) selectors.push(`#${CSS.escape(element.id)}`);
  selectors.push(cssPath(element));
  const nearbyText = safeNearbyText(element);
  return {
    accessibleName: name || undefined,
    role,
    nearbyText: nearbyText || undefined,
    selectors: [
      ...new Set(selectors.filter((value) => value && !containsSensitiveRecordedText(value))),
    ],
    ...targetGeometry(element),
  };
}

function isSensitive(element: Element): CaptureMask['reason'] | undefined {
  if (element.hasAttribute(REDACT_ATTRIBUTE)) return 'author';
  if (!(element instanceof HTMLElement)) return undefined;
  // Embedded documents are separate event and security boundaries. Their pixels are part of a
  // visible-tab screenshot, but the top document cannot reliably inspect their current DOM or
  // intercept a user's masking gesture (especially after a cross-origin navigation). Treat the
  // entire rendered frame as private instead of ever persisting unaudited pixels.
  if (
    element instanceof HTMLIFrameElement ||
    element instanceof HTMLObjectElement ||
    element instanceof HTMLEmbedElement
  ) {
    return 'embedded-content';
  }
  const descriptor = [
    element.getAttribute('name'),
    element.getAttribute('id'),
    element.getAttribute('autocomplete'),
    element.getAttribute('aria-label'),
    element.getAttribute('placeholder'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (element instanceof HTMLInputElement && element.type === 'password') return 'secret';
  if (element instanceof HTMLInputElement && element.type === 'email') return 'personal-data';
  if (element instanceof HTMLInputElement && element.type === 'tel') return 'personal-data';
  if (/token|secret|password|api.?key|auth|credential/.test(descriptor)) return 'secret';
  if (/card|cvv|cvc|iban|account.?number|payment/.test(descriptor)) return 'payment';
  if (/email|phone|address|full.?name|first.?name|last.?name/.test(descriptor))
    return 'personal-data';
  // Typed values are private by default, even when the product uses a vague field name.
  // Authors can still explain the action through fixtures and captions without persisting the value.
  if (
    (element instanceof HTMLInputElement &&
      ![
        'button',
        'checkbox',
        'color',
        'file',
        'hidden',
        'image',
        'radio',
        'range',
        'reset',
        'submit',
      ].includes(element.type) &&
      element.value.length > 0) ||
    (element instanceof HTMLTextAreaElement && element.value.length > 0) ||
    (element.isContentEditable && (element.textContent?.trim().length ?? 0) > 0)
  ) {
    return 'personal-data';
  }
  return undefined;
}

function sensitiveElements(): Array<{ element: HTMLElement; reason: CaptureMask['reason'] }> {
  const candidates = document.querySelectorAll<HTMLElement>(
    `iframe, object, embed, input, textarea, [contenteditable="true"], [${REDACT_ATTRIBUTE}]`,
  );
  const structured = Array.from(candidates)
    .map((element) => ({ element, reason: isSensitive(element) }))
    .filter((item): item is { element: HTMLElement; reason: CaptureMask['reason'] } =>
      Boolean(item.reason),
    );
  const textPatterns: Array<{ pattern: RegExp; reason: CaptureMask['reason'] }> = [
    { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, reason: 'personal-data' },
    {
      pattern: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/,
      reason: 'secret',
    },
    { pattern: /\b(?:sk|pk|api|token)[_-][A-Za-z0-9_-]{16,}\b/i, reason: 'secret' },
    { pattern: /\b(?:\d[ -]*?){13,19}\b/, reason: 'payment' },
  ];
  const textMatches: Array<{ element: HTMLElement; reason: CaptureMask['reason'] }> = [];
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = node.textContent?.trim();
        const parent = node.parentElement;
        if (!value || !parent || parent.closest(`[${EXCLUDE_ATTRIBUTE}]`))
          return NodeFilter.FILTER_REJECT;
        return textPatterns.some(({ pattern }) => pattern.test(value))
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const element = node.parentElement;
      const value = node.textContent ?? '';
      const match = textPatterns.find(({ pattern }) => pattern.test(value));
      if (element && match) textMatches.push({ element, reason: match.reason });
    }
  }
  const byElement = new Map<HTMLElement, CaptureMask['reason']>();
  for (const { element, reason } of [...structured, ...textMatches]) byElement.set(element, reason);
  return Array.from(byElement, ([element, reason]) => ({ element, reason })).filter(
    ({ element }) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
    },
  );
}

function applyPrivacyOverlays(): { masks: CaptureMask[]; remove: () => void } {
  const overlays: HTMLElement[] = [];
  const masks: CaptureMask[] = [];
  for (const { element, reason } of sensitiveElements()) {
    const rect = element.getBoundingClientRect();
    const normalized = normalizeRect(rect);
    if (!normalized) continue;
    masks.push({ ...normalized, reason });
    const overlay = document.createElement('div');
    overlay.setAttribute(EXCLUDE_ATTRIBUTE, 'privacy-mask');
    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '2147483646',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      background: '#171512',
      borderRadius: getComputedStyle(element).borderRadius,
      pointerEvents: 'none',
    });
    document.documentElement.append(overlay);
    overlays.push(overlay);
  }
  return { masks, remove: () => overlays.forEach((overlay) => overlay.remove()) };
}

/**
 * DOM mutations are not guaranteed to reach Chromium's compositor before an
 * extension capture request runs. Waiting through two animation frames proves
 * that both the privacy masks and the hidden recorder HUD have been painted.
 */
function waitForVisualCommit(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

class RecorderHud {
  private host = document.createElement('div');
  private shadow = this.host.attachShadow({ mode: 'closed' });
  private paused = false;
  private maskNext = false;
  private checkNext = false;
  private toolsOpen = false;
  private capturing = false;
  private customMasked = new Set<HTMLElement>();

  constructor() {
    this.host.setAttribute(EXCLUDE_ATTRIBUTE, 'hud');
    Object.assign(this.host.style, {
      position: 'fixed',
      zIndex: '2147483647',
      left: '50%',
      bottom: '20px',
      transform: 'translateX(-50%)',
    });
    this.render();
    document.documentElement.append(this.host);
  }

  get isPaused(): boolean {
    return this.paused || this.capturing;
  }

  get isUserPaused(): boolean {
    return this.paused;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  intercept(element: HTMLElement): boolean {
    if (this.maskNext) {
      element.setAttribute(REDACT_ATTRIBUTE, 'author');
      this.customMasked.add(element);
      this.maskNext = false;
      this.render();
      return true;
    }
    if (this.checkNext) {
      this.checkNext = false;
      const target = targetSnapshot(element);
      void chrome.runtime.sendMessage({
        type: 'add-check',
        label: `Confirm ${target.accessibleName || 'the selected element'} is visible`,
        target,
      } satisfies RecorderMessage);
      this.render('Check added');
      return true;
    }
    return false;
  }

  beginCapture(): void {
    this.capturing = true;
  }

  captureComplete(): void {
    this.capturing = false;
  }

  showStatus(message: string): void {
    this.render(message);
  }

  setHidden(hidden: boolean): void {
    this.host.style.visibility = hidden ? 'hidden' : 'visible';
  }

  dispose(): void {
    this.customMasked.forEach((element) => element.removeAttribute(REDACT_ATTRIBUTE));
    this.host.remove();
  }

  private render(message = ''): void {
    this.shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .bar { display:flex; align-items:center; gap:4px; max-width:calc(100vw - 24px); padding:6px; color:#f8f4ec; background:#181613; border:1px solid #3b3731; border-radius:12px; box-shadow:0 8px 24px #0004; font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif; }
        .brand { display:flex; align-items:center; gap:8px; padding:0 8px 0 5px; }
        .dot { width:8px; height:8px; border-radius:50%; background:${this.paused ? '#d8a73a' : '#e5482c'}; box-shadow:0 0 0 3px #e5482c25; }
        button { min-height:40px; border:0; border-radius:8px; padding:0 10px; color:inherit; background:transparent; cursor:pointer; font:inherit; white-space:nowrap; }
        button:hover { background:#302c27; }
        button:focus-visible { background:#302c27; outline:2px solid #f05a3c; outline-offset:1px; }
        button[data-active=true] { background:#f8f4ec; color:#181613; }
        .tools { position:relative; }
        .tools-menu { position:absolute; bottom:calc(100% + 8px); left:50%; display:grid; gap:3px; min-width:130px; padding:5px; transform:translateX(-50%); color:#f8f4ec; background:#181613; border:1px solid #3b3731; border-radius:10px; box-shadow:0 8px 24px #0004; }
        .finish { background:#b33b24; margin-left:4px; }
        .finish:hover, .finish:focus-visible { background:#922f1d; }
        .message { color:#b8d8a7; max-width:110px; overflow:hidden; white-space:nowrap; }
        @media (max-width:620px) { .brand { font-size:0; padding-right:3px; } .message { display:none; } button { min-height:44px; padding-inline:8px; } }
      </style>
      <div class="bar" role="toolbar" aria-label="Scenebook recorder">
        <span class="brand"><span class="dot"></span>Scenebook</span>
        ${message ? `<span class="message" role="status">${message}</span>` : ''}
        <button data-action="pause">${this.paused ? 'Resume' : 'Pause'}</button>
        <button data-action="step">Capture state</button>
        <span class="tools">
          <button data-action="tools" data-active="${this.checkNext || this.maskNext}" aria-expanded="${this.toolsOpen}">Tools</button>
          ${this.toolsOpen ? `<span class="tools-menu"><button data-action="check" data-active="${this.checkNext}">Add check</button><button data-action="mask" data-active="${this.maskNext}">Mask private data</button></span>` : ''}
        </span>
        <button data-action="undo">Undo</button>
        <button data-action="finish" class="finish">Finish</button>
      </div>`;
    this.shadow.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.action;
        if (action === 'pause') this.paused = !this.paused;
        if (action === 'tools') this.toolsOpen = !this.toolsOpen;
        if (action === 'mask') {
          this.maskNext = !this.maskNext;
          this.checkNext = false;
          this.toolsOpen = false;
        }
        if (action === 'check') {
          this.checkNext = !this.checkNext;
          this.maskNext = false;
          this.toolsOpen = false;
        }
        if (action === 'undo')
          void chrome.runtime.sendMessage({ type: 'undo' } satisfies RecorderMessage);
        if (action === 'finish')
          void chrome.runtime.sendMessage({ type: 'stop' } satisfies RecorderMessage);
        if (action === 'step') void this.captureCurrentState();
        this.render();
      });
    });
  }

  private async captureCurrentState(): Promise<void> {
    const title = window.prompt('Name this step', 'Show the current state')?.trim();
    if (!title) return;
    this.beginCapture();
    const privacy = applyPrivacyOverlays();
    this.setHidden(true);
    try {
      await waitForVisualCommit();
      const response = await chrome.runtime.sendMessage({
        type: 'capture',
        title,
        route: location.href,
        masks: privacy.masks,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      } satisfies RecorderMessage);
      checkpointAvailable = response?.ok === true;
      if (!checkpointAvailable) this.render('Capture failed');
    } finally {
      privacy.remove();
      this.setHidden(false);
      this.captureComplete();
    }
  }
}

export default defineUnlistedScript(() => {
  const installation = globalThis as typeof globalThis & { __scenebookRecorderInstalled?: boolean };
  if (installation.__scenebookRecorderInstalled) return;
  installation.__scenebookRecorderInstalled = true;
  let hud: RecorderHud | undefined;
  let activePrivacyCleanup: (() => void) | undefined;
  let captureGeneration = 0;
  let replayingActivation = false;

  const restoreHud = () => {
    activePrivacyCleanup?.();
    activePrivacyCleanup = undefined;
    if (hud) {
      hud.captureComplete();
      hud.setHidden(false);
    }
  };

  const refreshCheckpoint = (): Promise<boolean> => {
    const generation = captureGeneration;
    checkpointAvailable = false;
    const previous = checkpointPromise.catch(() => false);
    const next = previous.then(async () => {
      const activeHud = hud;
      if (!activeHud || generation !== captureGeneration) return false;
      activeHud.beginCapture();
      activeHud.setHidden(true);
      try {
        // The prior activation must reach the DOM and compositor before privacy is scanned.
        await waitForVisualCommit();
        if (!hud || generation !== captureGeneration) return false;
        const privacy = applyPrivacyOverlays();
        activePrivacyCleanup = privacy.remove;
        await waitForVisualCommit();
        const response = await chrome.runtime.sendMessage({
          type: 'checkpoint',
          route: location.href,
          masks: privacy.masks,
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        } satisfies RecorderMessage);
        const ready = response?.ok === true && generation === captureGeneration;
        checkpointAvailable = ready;
        if (!ready && generation === captureGeneration) activeHud.showStatus('Capture failed');
        return ready;
      } catch {
        if (generation === captureGeneration) activeHud.showStatus('Capture failed');
        return false;
      } finally {
        if (generation === captureGeneration) restoreHud();
      }
    });
    checkpointPromise = next;
    return next;
  };

  const waitForPointerActivation = (pointerId: number): Promise<void> =>
    new Promise((resolve) => {
      let timer = 0;
      const finish = () => {
        window.removeEventListener('pointerup', onPointerEnd, true);
        window.removeEventListener('pointercancel', onPointerEnd, true);
        if (timer) window.clearTimeout(timer);
        resolve();
      };
      const onPointerEnd = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        // A click is dispatched after pointerup. The zero-delay task runs after its handlers.
        timer = window.setTimeout(finish, 0);
      };
      window.addEventListener('pointerup', onPointerEnd, true);
      window.addEventListener('pointercancel', onPointerEnd, true);
      timer = window.setTimeout(finish, 1_500);
    });

  const suppressPointerActivation = (
    pointerDown: PointerEvent,
    element: HTMLElement,
  ): Promise<void> => {
    pointerDown.preventDefault();
    pointerDown.stopImmediatePropagation();
    return new Promise((resolve) => {
      let timer = 0;
      const finish = () => {
        window.removeEventListener('pointerup', onPointerEnd, true);
        window.removeEventListener('pointercancel', onPointerEnd, true);
        window.removeEventListener('click', onClick, true);
        if (timer) window.clearTimeout(timer);
        resolve();
      };
      const onPointerEnd = (event: PointerEvent) => {
        if (event.pointerId !== pointerDown.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        timer = window.setTimeout(finish, 60);
      };
      const onClick = (event: MouseEvent) => {
        if (!event.composedPath().includes(element)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        finish();
      };
      window.addEventListener('pointerup', onPointerEnd, true);
      window.addEventListener('pointercancel', onPointerEnd, true);
      window.addEventListener('click', onClick, true);
      timer = window.setTimeout(finish, 1_500);
    });
  };

  const replayPointerActivation = (
    pointerDown: PointerEvent,
    element: HTMLElement,
  ): (() => void) => {
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: pointerDown.pointerId,
      pointerType: pointerDown.pointerType,
      isPrimary: pointerDown.isPrimary,
      clientX: pointerDown.clientX,
      clientY: pointerDown.clientY,
      screenX: pointerDown.screenX,
      screenY: pointerDown.screenY,
      button: pointerDown.button,
      ctrlKey: pointerDown.ctrlKey,
      shiftKey: pointerDown.shiftKey,
      altKey: pointerDown.altKey,
      metaKey: pointerDown.metaKey,
    };
    return () => {
      if (!element.isConnected) return;
      replayingActivation = true;
      try {
        element.focus({ preventScroll: true });
        element.dispatchEvent(
          new PointerEvent('pointerdown', { ...init, buttons: pointerDown.buttons || 1 }),
        );
        if (element.isConnected) {
          element.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
          element.click();
        }
      } finally {
        replayingActivation = false;
      }
    };
  };

  const recordAction = async (
    target: TargetSnapshot,
    afterActivation: Promise<void>,
    replay?: () => void,
  ): Promise<void> => {
    const activeHud = hud;
    if (!activeHud) return;
    activeHud.beginCapture();
    activeHud.setHidden(true);
    checkpointAvailable = false;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'capture-action',
        title: `Choose ${target.accessibleName || 'the selected element'}`,
        target,
      } satisfies RecorderMessage);
      if (response?.ok !== true) {
        activeHud.showStatus('Step not recorded');
        replay?.();
        await afterActivation;
        checkpointPromise = refreshCheckpoint();
        return;
      }
      replay?.();
      await afterActivation;
      checkpointPromise = refreshCheckpoint();
      await checkpointPromise;
    } catch {
      replay?.();
      activeHud.showStatus('Step not recorded');
      restoreHud();
    }
  };

  const start = (): Promise<boolean> => {
    if (hud) return checkpointPromise;
    if (!document.documentElement) return Promise.resolve(false);
    hud = new RecorderHud();
    captureGeneration += 1;
    checkpointPromise = refreshCheckpoint();
    return checkpointPromise;
  };
  const stop = () => {
    captureGeneration += 1;
    checkpointAvailable = false;
    checkpointPromise = Promise.resolve(false);
    restoreHud();
    hud?.dispose();
    hud = undefined;
  };

  chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
    if (message.type === 'recorder-started') {
      void start().then((ready) => sendResponse({ ok: ready }));
      return true;
    }
    if (message.type === 'recorder-stopped') stop();
    if (message.type === 'capture-complete') restoreHud();
    return undefined;
  });

  void chrome.runtime.sendMessage({ type: 'status' } satisfies RecorderMessage).then((response) => {
    if (response?.ok && response.session?.status === 'recording') start();
  });

  window.addEventListener(
    'pointerdown',
    (event) => {
      const element =
        event.target instanceof HTMLElement
          ? event.target
          : event.target instanceof Element
            ? event.target.closest<HTMLElement>('button,a,input,select,textarea,[role]')
            : null;
      if (
        replayingActivation ||
        !element ||
        element.closest(`[${EXCLUDE_ATTRIBUTE}]`) ||
        !hud ||
        hud.isUserPaused
      )
        return;
      if (hud.intercept(element)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        checkpointPromise = refreshCheckpoint();
        return;
      }

      const target = targetSnapshot(element);
      if (!checkpointAvailable || hud.isCapturing) {
        const replay = replayPointerActivation(event, element);
        const activation = suppressPointerActivation(event, element);
        const pendingCheckpoint = checkpointPromise;
        void Promise.all([pendingCheckpoint, activation]).then(([ready]) => {
          if (!element.isConnected) return;
          if (!ready) {
            replay();
            checkpointPromise = refreshCheckpoint();
            return;
          }
          return recordAction(target, Promise.resolve(), replay);
        });
        return;
      }

      const activation = waitForPointerActivation(event.pointerId);
      void recordAction(target, activation);
    },
    true,
  );
});
