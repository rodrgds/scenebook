import { createHash } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { createDeterministicId, slugify } from '@scenebook/core';
import {
  combinePrivacyScanResults,
  scanAndRedactText,
  type PrivacyScanResult,
} from '@scenebook/privacy';
import {
  PrivacySummarySchema,
  type PrivacySummary,
  type SemanticProjection,
  type Target,
  type Viewport,
} from '@scenebook/schema';
import type {
  BeatOptions,
  CapturedStateMetadata,
  MaskInput,
  ScenebookFixtureOptions,
} from './types.js';

const DEFAULT_SENSITIVE_SELECTOR = [
  '[data-scenebook-redact]',
  'input[type="password"]',
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete^="cc-"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="password" i]',
  'input[name*="secret" i]',
  'input[name*="token" i]',
  'textarea[name*="secret" i]',
  'textarea[name*="token" i]',
].join(',');

function normalizedRoute(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '/';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.split(/[?#]/u, 1)[0] ?? '/';
  }
}

function cleanText(
  value: string | null | undefined,
  limit: number,
  path: string,
  capturedAt: string,
): { readonly value?: string; readonly scan?: PrivacyScanResult } {
  if (!value) return {};
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  if (!cleaned) return {};
  const result = scanAndRedactText(cleaned.slice(0, limit), {
    blockAt: 'medium',
    path,
    now: () => new Date(capturedAt),
  });
  return { value: result.value, scan: result.scan };
}

async function viewport(page: Page): Promise<Viewport> {
  const size = page.viewportSize();
  if (size)
    return { width: size.width, height: size.height, deviceScaleFactor: 1, isMobile: false };
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio || 1,
    isMobile: navigator.maxTouchPoints > 0 && window.innerWidth < 768,
  }));
}

async function targetMetadata(
  locator: Locator | undefined,
  capturedAt: string,
  targetSelector?: string,
): Promise<{ readonly target?: Target; readonly scans: readonly PrivacyScanResult[] }> {
  if (!locator) return { scans: [] };
  const box = await locator.boundingBox();
  const page = locator.page();
  const size = await viewport(page);
  const attributes = await locator
    .evaluate((element, sensitiveSelector) => {
      const html = element as HTMLElement;
      const isSensitive = (candidate: Element | null): boolean =>
        Boolean(candidate?.closest(sensitiveSelector));
      const composedParent = (candidate: Element): Element | null => {
        if (candidate.parentElement) return candidate.parentElement;
        const root = candidate.getRootNode();
        return root instanceof ShadowRoot ? root.host : null;
      };
      const isRendered = (candidate: Element): boolean => {
        if (!candidate.isConnected) return false;
        let current: Element | null = candidate;
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
      };
      const belongsToTarget = (candidate: Element | undefined): boolean => {
        let current: Element | null = candidate ?? null;
        while (current) {
          if (current === element) return true;
          current = composedParent(current);
        }
        // document.elementsFromPoint() retargets nodes inside a shadow tree to
        // their host. Accept only hosts reached through an actual shadow boundary,
        // not arbitrary light-DOM ancestors that may be covering the target.
        current = element;
        while (current) {
          const root = current.getRootNode();
          if (!(root instanceof ShadowRoot)) break;
          if (root.host === candidate) return true;
          current = root.host;
        }
        return false;
      };
      const visibility = (): { visible: boolean; occluded: boolean } => {
        if (!isRendered(element)) return { visible: false, occluded: false };
        const rect = element.getBoundingClientRect();
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(window.innerWidth, rect.right);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        if (right <= left || bottom <= top) return { visible: false, occluded: false };

        // Sample the action point and the interior perimeter. A target is occluded only
        // when none of its visible area can receive pointer input. Descendants, including
        // descendants inside an open shadow root, still belong to the target.
        const insetX = Math.min(2, (right - left) / 4);
        const insetY = Math.min(2, (bottom - top) / 4);
        const xValues = [left + insetX, (left + right) / 2, right - insetX];
        const yValues = [top + insetY, (top + bottom) / 2, bottom - insetY];
        const reachable = xValues.some((x) =>
          yValues.some((y) => belongsToTarget(document.elementsFromPoint(x, y)[0])),
        );
        return { visible: true, occluded: !reachable };
      };
      const safeText = (root: Element): string | undefined => {
        if (isSensitive(root)) return '[REDACTED]';
        const values: string[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && values.length < 200) {
          const parent = node.parentElement;
          if (parent && !isSensitive(parent) && !parent.closest('[hidden],[aria-hidden="true"]')) {
            const style = getComputedStyle(parent);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const value = node.textContent?.replace(/\s+/gu, ' ').trim();
              if (value) values.push(value);
            }
          }
          node = walker.nextNode();
        }
        const value = values.join(' ').replace(/\s+/gu, ' ').trim();
        return value || undefined;
      };
      const explicitRole = element
        .getAttribute('role')
        ?.trim()
        .split(/\s+/u)
        .find(
          (role) =>
            /^[a-z][a-z0-9-]{0,99}$/u.test(role) && role !== 'none' && role !== 'presentation',
        );
      const implicitRole = (): string | undefined => {
        if (html instanceof HTMLAnchorElement)
          return html.hasAttribute('href') ? 'link' : undefined;
        if (html instanceof HTMLButtonElement) return 'button';
        if (html instanceof HTMLInputElement) {
          if (html.type === 'hidden') return undefined;
          if (['button', 'image', 'reset', 'submit'].includes(html.type)) return 'button';
          if (html.type === 'checkbox') return 'checkbox';
          if (html.type === 'radio') return 'radio';
          if (html.type === 'range') return 'slider';
          if (html.type === 'number') return 'spinbutton';
          if (html.type === 'search') return 'searchbox';
          return 'textbox';
        }
        if (html instanceof HTMLSelectElement)
          return html.multiple || html.size > 1 ? 'listbox' : 'combobox';
        if (html instanceof HTMLTextAreaElement || html.isContentEditable) return 'textbox';
        return undefined;
      };
      const redacted = isSensitive(element);
      const labelled = element
        .getAttribute('aria-labelledby')
        ?.split(/\s+/u)
        .map((id) => document.getElementById(id))
        .filter(
          (candidate): candidate is HTMLElement => Boolean(candidate) && !isSensitive(candidate),
        )
        .map((candidate) => safeText(candidate))
        .filter(Boolean)
        .join(' ');
      const nativeLabel =
        html instanceof HTMLInputElement ||
        html instanceof HTMLSelectElement ||
        html instanceof HTMLTextAreaElement
          ? [...(html.labels ?? [])]
              .filter((candidate) => !isSensitive(candidate))
              .map((candidate) => safeText(candidate))
              .filter(Boolean)
              .join(' ')
          : undefined;
      const label = redacted
        ? '[REDACTED]'
        : (element.getAttribute('aria-label') ?? labelled ?? nativeLabel ?? safeText(element));
      const rendered = visibility();
      return {
        role: explicitRole ?? implicitRole(),
        accessibleName: label,
        nearbyText: redacted ? '[REDACTED]' : safeText(element),
        ...rendered,
      };
    }, DEFAULT_SENSITIVE_SELECTOR)
    .catch(() => ({
      role: undefined,
      accessibleName: undefined,
      nearbyText: undefined,
      visible: false,
      occluded: false,
    }));
  const selector = cleanText(targetSelector, 2_000, '$state/target/selectors/0/value', capturedAt);
  const selectors = selector.value
    ? [
        {
          engine: targetSelector!.startsWith('//') ? ('xpath' as const) : ('css' as const),
          value: selector.value,
          confidence: 1,
          generated: false,
        },
      ]
    : [];
  const hasBox = Boolean(
    box &&
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.width > 0 &&
    box.height > 0,
  );
  const clipped = hasBox
    ? {
        left: Math.max(0, box!.x),
        top: Math.max(0, box!.y),
        right: Math.min(size.width, box!.x + box!.width),
        bottom: Math.min(size.height, box!.y + box!.height),
      }
    : undefined;
  const intersectsViewport = Boolean(
    clipped && clipped.right > clipped.left && clipped.bottom > clipped.top,
  );
  const role = cleanText(attributes.role, 100, '$state/target/role', capturedAt);
  const accessibleName = cleanText(
    attributes.accessibleName,
    500,
    '$state/target/accessibleName',
    capturedAt,
  );
  const nearbyText = cleanText(
    attributes.nearbyText,
    1_000,
    '$state/target/nearbyText',
    capturedAt,
  );
  const target: Target = {
    ...(role.value ? { role: role.value } : {}),
    ...(accessibleName.value ? { accessibleName: accessibleName.value } : {}),
    ...(nearbyText.value ? { nearbyText: nearbyText.value } : {}),
    selectors,
    ...(hasBox
      ? {
          pixelRect: {
            x: Math.max(0, box!.x),
            y: Math.max(0, box!.y),
            width: box!.width,
            height: box!.height,
          },
          ...(intersectsViewport
            ? {
                normalizedRect: {
                  x: clipped!.left / size.width,
                  y: clipped!.top / size.height,
                  width: (clipped!.right - clipped!.left) / size.width,
                  height: (clipped!.bottom - clipped!.top) / size.height,
                },
              }
            : {}),
        }
      : {}),
    visible: hasBox && intersectsViewport && attributes.visible,
    occluded: hasBox && intersectsViewport && attributes.visible ? attributes.occluded : false,
  };
  return {
    target,
    scans: [role.scan, accessibleName.scan, nearbyText.scan, selector.scan].filter(
      (scan): scan is PrivacyScanResult => scan !== undefined,
    ),
  };
}

async function semanticProjection(
  page: Page,
  capturedAt: string,
): Promise<{
  readonly semantic: SemanticProjection;
  readonly scans: readonly PrivacyScanResult[];
}> {
  const result = await page.evaluate((sensitiveSelector) => {
    const title = document.title;
    const language = document.documentElement.lang || undefined;
    const text: string[] = [];
    const nodes: Array<{
      role: string;
      name: string;
      states: Record<string, boolean | number | string>;
      level?: number;
    }> = [];
    const concreteRoles = new Set([
      'alert',
      'alertdialog',
      'application',
      'article',
      'banner',
      'blockquote',
      'button',
      'caption',
      'cell',
      'checkbox',
      'code',
      'columnheader',
      'combobox',
      'complementary',
      'contentinfo',
      'definition',
      'deletion',
      'dialog',
      'document',
      'emphasis',
      'feed',
      'figure',
      'form',
      'generic',
      'grid',
      'gridcell',
      'group',
      'heading',
      'img',
      'insertion',
      'link',
      'list',
      'listbox',
      'listitem',
      'log',
      'main',
      'marquee',
      'math',
      'menu',
      'menubar',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'meter',
      'navigation',
      'note',
      'option',
      'paragraph',
      'progressbar',
      'radio',
      'radiogroup',
      'region',
      'row',
      'rowgroup',
      'rowheader',
      'scrollbar',
      'search',
      'searchbox',
      'separator',
      'slider',
      'spinbutton',
      'status',
      'strong',
      'subscript',
      'suggestion',
      'superscript',
      'switch',
      'tab',
      'table',
      'tablist',
      'tabpanel',
      'term',
      'textbox',
      'time',
      'timer',
      'toolbar',
      'tooltip',
      'tree',
      'treegrid',
      'treeitem',
    ]);
    const interactiveRoles = new Set([
      'button',
      'checkbox',
      'combobox',
      'link',
      'listbox',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'radio',
      'scrollbar',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'textbox',
      'treeitem',
    ]);
    const composedParent = (element: Element): Element | null => {
      if (element.parentElement) return element.parentElement;
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    };
    const isSensitive = (element: Element): boolean => {
      let current: Element | null = element;
      while (current) {
        if (current.matches(sensitiveSelector)) return true;
        current = composedParent(current);
      }
      return false;
    };
    const isRenderedInViewport = (element: Element): boolean => {
      if (!element.isConnected) return false;
      let current: Element | null = element;
      while (current) {
        if (
          current.hasAttribute('hidden') ||
          current.hasAttribute('inert') ||
          current.getAttribute('aria-hidden') === 'true'
        ) {
          return false;
        }
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
      return [...element.getClientRects()].some(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight,
      );
    };
    const safeText = (root: Element): string => {
      if (isSensitive(root)) return '';
      const values: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && values.length < 100) {
        const parent = node.parentElement;
        if (
          parent &&
          !isSensitive(parent) &&
          !parent.closest('script,style,noscript,template,[hidden],[aria-hidden="true"]')
        ) {
          const style = getComputedStyle(parent);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const value = node.textContent?.replace(/\s+/gu, ' ').trim();
            if (value) values.push(value);
          }
        }
        node = walker.nextNode();
      }
      return values.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 2_000);
    };
    const labelledByText = (element: Element): string => {
      const ids = element.getAttribute('aria-labelledby')?.trim().split(/\s+/u) ?? [];
      const root = element.getRootNode();
      const scope = root instanceof Document || root instanceof ShadowRoot ? root : document;
      return ids
        .slice(0, 20)
        .map((id) => scope.querySelector(`#${CSS.escape(id)}`))
        .filter((candidate): candidate is Element => candidate !== null)
        .filter((candidate) => !isSensitive(candidate))
        .map((candidate) => safeText(candidate))
        .filter(Boolean)
        .join(' ');
    };
    const accessibleName = (element: Element): string => {
      if (isSensitive(element)) return '';
      const html = element as HTMLElement;
      const ariaLabel = element.getAttribute('aria-label')?.trim();
      if (ariaLabel) return ariaLabel;
      const labelled = labelledByText(element);
      if (labelled) return labelled;
      if (
        html instanceof HTMLInputElement ||
        html instanceof HTMLSelectElement ||
        html instanceof HTMLTextAreaElement ||
        html instanceof HTMLProgressElement ||
        html instanceof HTMLMeterElement ||
        html instanceof HTMLOutputElement
      ) {
        const labels = [...(html.labels ?? [])]
          .filter((label) => !isSensitive(label))
          .map((label) => safeText(label))
          .filter(Boolean)
          .join(' ');
        if (labels) return labels;
      }
      if (html instanceof HTMLImageElement || html instanceof HTMLAreaElement) {
        const alt = html.alt.trim();
        if (alt) return alt;
      }
      if (
        html instanceof HTMLInputElement &&
        ['button', 'image', 'reset', 'submit'].includes(html.type) &&
        html.value.trim()
      ) {
        return html.value.trim();
      }
      const titleAttribute = element.getAttribute('title')?.trim();
      if (titleAttribute) return titleAttribute;
      return safeText(element);
    };
    const explicitRole = (element: Element): string | undefined =>
      element
        .getAttribute('role')
        ?.trim()
        .toLowerCase()
        .split(/\s+/u)
        .find((role) => concreteRoles.has(role));
    const implicitRole = (element: Element, name: string): string | undefined => {
      const html = element as HTMLElement;
      const tag = element.tagName;
      if (html instanceof HTMLAnchorElement || html instanceof HTMLAreaElement)
        return html.hasAttribute('href') ? 'link' : undefined;
      if (html instanceof HTMLButtonElement) return 'button';
      if (html instanceof HTMLInputElement) {
        if (html.type === 'hidden') return undefined;
        if (['button', 'image', 'reset', 'submit'].includes(html.type)) return 'button';
        if (html.type === 'checkbox') return 'checkbox';
        if (html.type === 'radio') return 'radio';
        if (html.type === 'range') return 'slider';
        if (html.type === 'number') return 'spinbutton';
        if (html.type === 'search') return 'searchbox';
        return 'textbox';
      }
      if (html instanceof HTMLSelectElement)
        return html.multiple || html.size > 1 ? 'listbox' : 'combobox';
      if (html instanceof HTMLTextAreaElement || html.isContentEditable) return 'textbox';
      if (/^H[1-6]$/u.test(tag)) return 'heading';
      if (tag === 'ARTICLE') return 'article';
      if (tag === 'ASIDE') return 'complementary';
      if (tag === 'BLOCKQUOTE') return 'blockquote';
      if (tag === 'CAPTION') return 'caption';
      if (tag === 'CODE') return 'code';
      if (tag === 'DIALOG') return 'dialog';
      if (tag === 'DL' || tag === 'OL' || tag === 'UL') return 'list';
      if (tag === 'DT') return 'term';
      if (tag === 'DD') return 'definition';
      if (tag === 'FIGURE') return 'figure';
      if (tag === 'FORM') return name ? 'form' : undefined;
      if (tag === 'HEADER')
        return element.closest('article,aside,main,nav,section') ? undefined : 'banner';
      if (tag === 'FOOTER')
        return element.closest('article,aside,main,nav,section') ? undefined : 'contentinfo';
      if (tag === 'IMG') return element.getAttribute('alt') === '' ? undefined : 'img';
      if (tag === 'LI') return 'listitem';
      if (tag === 'MAIN') return 'main';
      if (tag === 'MATH') return 'math';
      if (tag === 'METER') return 'meter';
      if (tag === 'NAV') return 'navigation';
      if (tag === 'OPTION') return 'option';
      if (tag === 'OUTPUT') return 'status';
      if (tag === 'P') return 'paragraph';
      if (tag === 'PROGRESS') return 'progressbar';
      if (tag === 'SECTION') return name ? 'region' : undefined;
      if (tag === 'SUMMARY') return 'button';
      if (tag === 'TABLE') return 'table';
      if (tag === 'TBODY' || tag === 'TFOOT' || tag === 'THEAD') return 'rowgroup';
      if (tag === 'TR') return 'row';
      if (tag === 'TD') return 'cell';
      if (tag === 'TH')
        return element.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
      if (tag === 'TIME') return 'time';
      return undefined;
    };
    const booleanAriaState = (
      element: Element,
      attribute: string,
    ): boolean | 'mixed' | undefined => {
      const value = element.getAttribute(attribute)?.trim().toLowerCase();
      if (value === 'true') return true;
      if (value === 'false') return false;
      if (value === 'mixed') return 'mixed';
      return undefined;
    };
    const semanticStates = (
      element: Element,
      role: string,
    ): Record<string, boolean | number | string> => {
      const html = element as HTMLElement;
      const states: Record<string, boolean | number | string> = {};
      if (interactiveRoles.has(role) || element.hasAttribute('aria-disabled')) {
        states.disabled =
          element.matches(':disabled') || booleanAriaState(element, 'aria-disabled') === true;
      }
      const checked =
        html instanceof HTMLInputElement && ['checkbox', 'radio'].includes(html.type)
          ? html.checked
          : booleanAriaState(element, 'aria-checked');
      if (checked !== undefined) states.checked = checked;
      const selected =
        html instanceof HTMLOptionElement
          ? html.selected
          : booleanAriaState(element, 'aria-selected');
      if (selected !== undefined) states.selected = selected;
      for (const [attribute, key] of [
        ['aria-expanded', 'expanded'],
        ['aria-pressed', 'pressed'],
        ['aria-busy', 'busy'],
        ['aria-modal', 'modal'],
        ['aria-multiselectable', 'multiselectable'],
        ['aria-atomic', 'atomic'],
      ] as const) {
        const state = booleanAriaState(element, attribute);
        if (state !== undefined) states[key] = state;
      }
      if (
        html instanceof HTMLInputElement ||
        html instanceof HTMLSelectElement ||
        html instanceof HTMLTextAreaElement
      ) {
        states.required = html.required;
      } else {
        const required = booleanAriaState(element, 'aria-required');
        if (required !== undefined) states.required = required;
      }
      if (html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement) {
        states.readonly = html.readOnly;
      } else {
        const readonly = booleanAriaState(element, 'aria-readonly');
        if (readonly !== undefined) states.readonly = readonly;
      }
      const invalid = element.getAttribute('aria-invalid')?.trim().toLowerCase();
      if (invalid && ['false', 'grammar', 'spelling', 'true'].includes(invalid)) {
        states.invalid = invalid === 'true' ? true : invalid === 'false' ? false : invalid;
      }
      const current = element.getAttribute('aria-current')?.trim().toLowerCase();
      if (
        current &&
        ['date', 'false', 'location', 'page', 'step', 'time', 'true'].includes(current)
      ) {
        states.current = current === 'true' ? true : current === 'false' ? false : current;
      }
      const hasPopup = element.getAttribute('aria-haspopup')?.trim().toLowerCase();
      if (
        hasPopup &&
        ['dialog', 'false', 'grid', 'listbox', 'menu', 'tree', 'true'].includes(hasPopup)
      ) {
        states.hasPopup = hasPopup === 'true' ? true : hasPopup === 'false' ? false : hasPopup;
      }
      const orientation = element.getAttribute('aria-orientation')?.trim().toLowerCase();
      if (orientation === 'horizontal' || orientation === 'vertical')
        states.orientation = orientation;
      for (const [attribute, key] of [
        ['aria-valuemin', 'valueMin'],
        ['aria-valuemax', 'valueMax'],
        ['aria-valuenow', 'valueNow'],
      ] as const) {
        const raw = element.getAttribute(attribute);
        const value = raw === null ? Number.NaN : Number(raw);
        if (Number.isFinite(value)) states[key] = value;
      }
      return states;
    };
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && text.length < 400) {
        const parent = node.parentElement;
        if (
          parent &&
          !parent.closest(sensitiveSelector) &&
          !parent.closest('[hidden],[aria-hidden="true"]')
        ) {
          const style = getComputedStyle(parent);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            const value = node.textContent?.replace(/\s+/gu, ' ').trim();
            if (value) text.push(value);
          }
        }
        node = walker.nextNode();
      }
      const pending: Element[] = [document.body];
      const visited = new Set<Element>();
      while (pending.length > 0 && nodes.length < 5_000 && visited.size < 50_000) {
        const element = pending.pop()!;
        if (visited.has(element)) continue;
        visited.add(element);
        // Open shadow roots participate in the browser accessibility tree even
        // though querySelectorAll() cannot cross that boundary. Traverse both
        // shadow and light children; the identity set prevents duplicate slots.
        const children = [...element.children];
        if (element instanceof HTMLElement && element.shadowRoot) {
          children.push(...element.shadowRoot.children);
        }
        for (let index = children.length - 1; index >= 0; index -= 1) {
          pending.push(children[index]!);
        }
        if (isSensitive(element) || !isRenderedInViewport(element)) continue;
        const name = accessibleName(element);
        const role = explicitRole(element) ?? implicitRole(element, name);
        if (!role) continue;
        const rawLevel =
          role === 'heading'
            ? (element.getAttribute('aria-level') ??
              (/^H[1-6]$/u.test(element.tagName) ? element.tagName.slice(1) : undefined))
            : undefined;
        const parsedLevel = rawLevel === undefined ? undefined : Number(rawLevel);
        nodes.push({
          role,
          name,
          states: semanticStates(element, role),
          ...(Number.isInteger(parsedLevel) && parsedLevel! >= 0 && parsedLevel! <= 100
            ? { level: parsedLevel }
            : {}),
        });
      }
    }
    return { title, language, text, nodes };
  }, DEFAULT_SENSITIVE_SELECTOR);
  const scans: PrivacyScanResult[] = [];
  const visibleText = result.text
    .map((line, index) => {
      const cleaned = cleanText(line, 5_000, `$state/semantic/visibleText/${index}`, capturedAt);
      if (cleaned.scan) scans.push(cleaned.scan);
      return cleaned.value ?? '';
    })
    .filter(Boolean);
  const title = cleanText(result.title, 1_000, '$state/semantic/title', capturedAt);
  if (title.scan) scans.push(title.scan);
  const nodes = result.nodes.flatMap((node, index) => {
    const role = cleanText(node.role, 100, `$state/semantic/nodes/${index}/role`, capturedAt);
    const name = cleanText(node.name, 1_000, `$state/semantic/nodes/${index}/name`, capturedAt);
    if (role.scan) scans.push(role.scan);
    if (name.scan) scans.push(name.scan);
    if (!role.value) return [];
    return [
      {
        role: role.value,
        name: name.value ?? '',
        states: node.states,
        ...(node.level === undefined ? {} : { level: node.level }),
      },
    ];
  });
  const semantic: SemanticProjection = {
    visibleText,
    nodes,
    ...(title.value ? { title: title.value } : {}),
    ...(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(result.language ?? '')
      ? { language: result.language }
      : {}),
  };
  return { semantic, scans };
}

const EMPTY_COUNTS = { info: 0, low: 0, medium: 0, high: 0, blocking: 0 } as const;

function capturePrivacy(
  scans: readonly PrivacyScanResult[],
  capturedAt: string,
  exactPixelsPending: boolean,
): PrivacySummary {
  const structured = combinePrivacyScanResults(scans, {
    blockAt: 'medium',
    now: () => new Date(capturedAt),
  });
  if (structured.status !== 'clear') return PrivacySummarySchema.parse(structured);
  if (!exactPixelsPending) return PrivacySummarySchema.parse(structured);
  return {
    status: 'unknown',
    scannedAt: capturedAt,
    scannerVersion: `@scenebook/privacy/${structured.scannerVersion};pixels-unscanned`,
    counts: EMPTY_COUNTS,
    findings: [],
  };
}

function maskLocators(
  page: Page,
  inputs: readonly MaskInput[],
  automatic: boolean,
): { locators: Locator[]; ids: string[] } {
  const locators: Locator[] = [];
  const ids: string[] = [];
  if (automatic) {
    locators.push(page.locator(DEFAULT_SENSITIVE_SELECTOR));
    ids.push('automatic-sensitive-fields');
  }
  for (const [index, input] of inputs.entries()) {
    locators.push(typeof input === 'string' ? page.locator(input) : input);
    ids.push(
      typeof input === 'string'
        ? createDeterministicId('mask', input)
        : `locator-mask-${index + 1}`,
    );
  }
  return { locators, ids };
}

export async function captureState(
  page: Page,
  testInfo: TestInfo,
  sceneId: string,
  stepId: string,
  phase: 'before' | 'after',
  beat: BeatOptions,
  fixture: ScenebookFixtureOptions,
): Promise<CapturedStateMetadata> {
  const masks = maskLocators(page, beat.masks ?? [], fixture.automaticMasks);
  // Playwright applies masks in the browser screenshot operation. No unmasked pixel buffer is ever persisted.
  const screenshot = await page.screenshot({
    animations: fixture.animations,
    caret: 'hide',
    fullPage: false,
    mask: masks.locators,
    maskColor: fixture.maskColor,
    scale: fixture.scale,
    type: 'png',
  });
  const screenshotHash = createHash('sha256').update(screenshot).digest('hex');
  const attachment = `scenebook-state-${slugify(sceneId)}-${slugify(stepId)}-${phase}-${screenshotHash.slice(0, 12)}.png`;
  await testInfo.attach(attachment, { body: screenshot, contentType: 'image/png' });
  const capturedAt = new Date().toISOString();
  const target = beat.target
    ? await targetMetadata(beat.target, capturedAt, beat.targetSelector)
    : { scans: [] };
  const semantic: {
    readonly semantic?: SemanticProjection;
    readonly scans: readonly PrivacyScanResult[];
  } = fixture.captureSemanticProjection
    ? await semanticProjection(page, capturedAt)
    : { scans: [] };
  const privacy = capturePrivacy([...target.scans, ...semantic.scans], capturedAt, true);
  return {
    version: 1,
    sceneId,
    stepId,
    phase,
    capturedAt,
    route: normalizedRoute(page.url()),
    viewport: await viewport(page),
    screenshotHash,
    screenshotAttachment: attachment,
    masksApplied: masks.ids,
    privacy,
    ...(target.target ? { target: target.target } : {}),
    ...(semantic.semantic ? { semantic: semantic.semantic } : {}),
  };
}

export { DEFAULT_SENSITIVE_SELECTOR };
