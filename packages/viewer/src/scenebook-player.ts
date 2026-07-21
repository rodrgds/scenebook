import { findStepIndex, resolveChoice, snapshot, validateScene } from './state.js';
import { effectiveCrop, mapPointToCrop, mapRectToCrop } from './presentation.js';
import { safeImageSource, safeNavigationUrl, safeRadius, safeThemeColor } from './security.js';
import type {
  PlayerStep,
  SceneChoice,
  SceneCta,
  SceneCtaSubmission,
  SceneCtaSubmitter,
  SceneDefinition,
} from './types.js';

const styles = String.raw`
  :host {
    --sb-paper: #f4f5f6;
    --sb-surface: #ffffff;
    --sb-ink: #1c1d1f;
    --sb-on-ink: #ffffff;
    --sb-muted: #5f646b;
    --sb-line: #d7dade;
    --sb-accent: #b83b24;
    --sb-on-accent: #ffffff;
    --sb-focus: #1c1d1f;
    --sb-focus-contrast: #f4f5f6;
    --sb-accent-soft: color-mix(in srgb, var(--sb-accent) 14%, white);
    --sb-radius: 14px;
    color: var(--sb-ink);
    display: block;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.45;
    min-width: 0;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, a { font: inherit; }
  button { color: inherit; }
  .player {
    background: var(--sb-paper);
    border: 1px solid var(--sb-line);
    border-radius: var(--sb-radius);
    overflow: clip;
  }
  .topline {
    align-items: center;
    background: var(--sb-surface);
    border-bottom: 1px solid var(--sb-line);
    display: flex;
    gap: 14px;
    justify-content: space-between;
    min-height: 54px;
    padding: 9px 14px;
  }
  :host([compact]) .topline { display: none; }
  .scene-name { font-size: 14px; font-weight: 650; letter-spacing: -.01em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .evidence { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  .verified { align-items: center; color: var(--sb-ink); display: inline-flex; font-size: 12px; font-weight: 650; gap: 6px; white-space: nowrap; }
  .verified::before { background: currentColor; border-radius: 50%; content: ""; height: 7px; width: 7px; }
  .provenance summary { align-items: center; cursor: pointer; display: inline-flex; font-size: 12px; font-weight: 650; min-height: 44px; padding: 0 4px; }
  .provenance code { color: var(--sb-muted); display: block; font-size: .75rem; max-width: 42ch; overflow-wrap: anywhere; padding: 0 4px 8px; }
  .stage {
    aspect-ratio: 16 / 10;
    background: #24221f;
    display: grid;
    margin: 0;
    overflow: hidden;
    place-items: center;
    position: relative;
  }
  .presentation-frame { display: flex; flex-direction: column; max-height: 94%; max-width: 96%; overflow: hidden; position: relative; }
  .frame-none { height: 100%; max-height: none; max-width: none; width: 100%; }
  .frame-browser { background: #dedfe1; border-radius: 9px; box-shadow: 0 4px 8px rgba(0,0,0,.28); height: 94%; width: 94%; }
  .frame-mobile { aspect-ratio: 390 / 844; background: #111; border: 2px solid #494641; border-radius: 24px; box-shadow: 0 4px 8px rgba(0,0,0,.34); height: 94%; padding: 8px; }
  .browser-chrome { align-items: center; background: #f2eee6; border-bottom: 1px solid #cfc8bc; color: #706a62; display: flex; flex: 0 0 30px; font-size: 10px; gap: 5px; min-width: 0; padding: 0 10px; }
  .browser-chrome i { background: #aaa39a; border-radius: 50%; height: 6px; width: 6px; }
  .browser-chrome i:first-child { background: #d15c48; }
  .browser-chrome span { overflow: hidden; padding-inline-start: 6px; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-chrome { align-self: center; background: #050505; border-radius: 999px; height: 6px; margin: 0 0 6px; width: 34%; }
  .media-viewport { background: #181715; container-type: inline-size; flex: 1 1 auto; min-height: 0; overflow: hidden; position: relative; width: 100%; }
  .frame-mobile .media-viewport { border-radius: 15px; }
  .image-plane { position: absolute; }
  .image-plane img { display: block; height: 100%; object-fit: fill; user-select: none; width: 100%; }
  .media-overlays { inset: 0; overflow: hidden; pointer-events: none; position: absolute; }
  .mask { background: #191816; border: 1px solid rgba(255,255,255,.25); border-radius: 4px; position: absolute; }
  .mask.blur { backdrop-filter: blur(16px); background: rgba(25,24,22,.08); }
  .annotation { align-items:center; background: var(--sb-surface); border: 1px solid var(--sb-line); border-radius: 9px; display:flex; font-size: 12px; font-weight: 600; justify-content:center; overflow:hidden; padding: 8px 10px; position: absolute; }
  .annotation.spotlight { background: transparent; border: 3px solid var(--annotation-color,var(--sb-accent)); border-radius: 50%; box-shadow: 0 0 0 999px rgba(0,0,0,.32); color: transparent; padding: 0; }
  .annotation-arrow { height:100%; inset:0; overflow:visible; pointer-events:none; position:absolute; width:100%; }
  .annotation-arrow line { stroke-linecap:round; stroke-width:.8; }
  .cursor { filter: drop-shadow(0 2px 2px rgba(0,0,0,.4)); height: 28px; position: absolute; transform: translate(-4px, -3px); width: 22px; z-index: 4; }
  .cursor svg { display: block; height: 100%; width: 100%; }
  .cursor.dot { background:white; border:3px solid var(--sb-accent); border-radius:50%; height:16px; transform:translate(-50%,-50%); width:16px; }
  .cursor.dot svg { display:none; }
  .cursor.pointer svg path { fill:var(--sb-accent-soft); }
  .cursor.click::after { animation: sb-click 900ms ease-out var(--sb-click-delay,0ms) 1 forwards; border: 3px solid var(--sb-accent); border-radius: 50%; content: ""; height: 34px; left: -13px; opacity:0; position: absolute; top: -13px; width: 34px; }
  @keyframes sb-click { from { opacity: .9; transform: scale(.35); } to { opacity: 0; transform: scale(1.3); } }
  .hotspot {
    align-items: center;
    background: var(--sb-surface);
    border: 2px solid var(--sb-accent);
    border-radius: 999px;
    box-shadow: 0 4px 22px rgba(25,24,22,.24), 0 0 0 8px color-mix(in srgb, var(--sb-accent) 22%, transparent);
    cursor: pointer;
    display: flex;
    min-height: 44px;
    min-width: 44px;
    padding: 0;
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 3;
    pointer-events: auto;
  }
  .hotspot::before { background: var(--sb-accent); border-radius: 50%; content: ""; height: 12px; margin: 0 14px; width: 12px; }
  .hotspot-label { background: var(--sb-ink); border-radius: 8px; color: var(--sb-on-ink); font-size: 12px; font-weight: 650; left: 50%; max-width: min(220px, 70vw); max-width: min(220px, 70cqw); overflow-wrap: anywhere; padding: 7px 9px; pointer-events: none; position: absolute; text-align: center; top: calc(100% + 12px); transform: translateX(-50%); white-space: normal; width: max-content; }
  .hotspot.label-left .hotspot-label { left: 50%; transform: none; }
  .hotspot.label-right .hotspot-label { left: auto; right: 50%; transform: none; }
  .hotspot.label-above .hotspot-label { bottom: calc(100% + 12px); top: auto; }
  :host([practice]) .hotspot { background: transparent; border-color: transparent; box-shadow: none; }
  :host([practice]) .hotspot::before, :host([practice]) .hotspot-label { opacity: 0; }
  :host([practice]) .hotspot:focus-visible { border-color: var(--sb-accent); box-shadow: 0 0 0 4px var(--sb-accent-soft); }
  :host([practice]) .hotspot:focus-visible::before, :host([practice]) .hotspot:focus-visible .hotspot-label { opacity: 1; }
  .copy { background: var(--sb-surface); border-top: 1px solid var(--sb-line); display: grid; gap: 6px; padding: 18px clamp(16px, 4vw, 32px); }
  .step-meta { color: var(--sb-muted); font-size: 12px; font-weight: 650; }
  h2 { font-size: 22px; letter-spacing: -.02em; line-height: 1.2; margin: 0; text-wrap: balance; }
  .instruction { color: var(--sb-muted); font-size: 14px; margin: 0; max-width: 68ch; }
  .choice-card, .end-card { align-content: center; background: var(--sb-ink); color: var(--sb-on-ink); display: grid; gap: 18px; height: 100%; overflow: auto; overscroll-behavior: contain; padding: clamp(28px, 8vw, 84px); width: 100%; }
  .choice-card p, .end-card p { color: color-mix(in srgb, var(--sb-on-ink) 76%, transparent); margin: 0; max-width: 58ch; }
  .choice-list, .cta-list { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); }
  .comparison { display:grid; grid-template-columns:1fr 1fr; height:100%; width:100%; }
  .comparison .image-plane { overflow:hidden; position:relative; }
  .comparison .image-plane img { height:100%; object-fit:contain; width:100%; }
  .choice, .cta { align-items: flex-start; background: #2c2a27; border: 1px solid #56514a; border-radius: 10px; color: white; cursor: pointer; display: flex; flex-direction: column; gap: 3px; justify-content: center; min-height: 58px; padding: 12px 14px; text-align: start; text-decoration: none; }
  .choice:hover, .cta:hover { border-color: var(--sb-accent); }
  .choice small { color: #bbb6ae; }
  .cta.primary { background: var(--sb-accent); border-color: var(--sb-accent); color: var(--sb-on-accent); }
  .cta-form { background:#2c2a27; border:1px solid #56514a; border-radius:10px; display:grid; gap:10px; padding:14px; }
  .cta-form label { display:grid; font-size:12px; gap:5px; min-height:44px; }
  .cta-form label:has(input[type="checkbox"]) { align-items:center; cursor:pointer; grid-template-columns:1fr auto; }
  .cta-form input:not([type="checkbox"]) { background:#171614; border:1px solid #6d675f; border-radius:7px; color:white; font:inherit; min-height:44px; padding:8px 10px; }
  .cta-form button { background:var(--sb-accent); border:1px solid var(--sb-accent); border-radius:8px; color:var(--sb-on-accent); cursor:pointer; font:inherit; font-weight:650; min-height:44px; padding:8px 12px; }
  .cta-result { color:#c9c5bd; font-size:12px; margin:0; }
  .cta-result[data-state="error"] { color:#ffb4a8; }
  .cta-result[data-state="success"] { color:#a9e5c8; }
  .controls { align-items: center; background: var(--sb-surface); border-top: 1px solid var(--sb-line); display: grid; gap: 14px; grid-template-columns: auto minmax(120px, 1fr) auto; padding: 11px 14px; }
  .nav { align-items: center; display: flex; gap: 8px; }
  .control { align-items: center; background: transparent; border: 1px solid var(--sb-line); border-radius: 8px; cursor: pointer; display: inline-flex; font-weight: 650; gap: 7px; justify-content: center; min-height: 44px; min-width: 44px; padding: 8px 12px; }
  .control:hover:not(:disabled) { background: var(--sb-paper); border-color: var(--sb-muted); }
  .autoplay-control[aria-pressed="true"] { background: var(--sb-paper); border-color: var(--sb-muted); }
  .autoplay-state { color: var(--sb-muted); font-size: .75rem; }
  .hotspot:focus-visible, .choice:focus-visible, .cta:focus-visible, .cta-form input:focus-visible, .cta-form button:focus-visible, .control:focus-visible, summary:focus-visible, .transcript button:focus-visible { box-shadow: 0 0 0 6px var(--sb-focus-contrast); outline: 3px solid var(--sb-focus); outline-offset: 3px; }
  .hotspot:active, .choice:active, .cta:active, .cta-form button:active:not(:disabled), .control:active:not(:disabled), summary:active, .transcript button:active { filter: brightness(.84); }
  .control:disabled { cursor: not-allowed; opacity: .38; }
  .progress { align-items: center; display: grid; gap: 7px; grid-template-columns: 1fr auto; min-width: 0; }
  .bar { background: var(--sb-line); border-radius: 999px; height: 5px; overflow: hidden; }
  .bar > span { background: var(--sb-accent); display: block; height: 100%; transform: scaleX(var(--sb-progress, 0)); transform-origin: left; transition: transform 180ms ease-out; width: 100%; }
  .progress-text { color: var(--sb-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .75rem; white-space: nowrap; }
  .transcript { background: var(--sb-paper); border-top: 1px solid var(--sb-line); }
  .transcript summary { cursor: pointer; font-size: 13px; font-weight: 650; min-height: 44px; padding: 13px 16px; }
  .transcript ol { display: grid; gap: 3px; list-style: none; margin: 0; max-height: 230px; overflow: auto; padding: 0 10px 12px; }
  .transcript button { align-items: baseline; background: transparent; border: 0; border-radius: 7px; color: var(--sb-muted); cursor: pointer; display: grid; gap: 10px; grid-template-columns: 24px 1fr; min-height: 44px; padding: 9px; text-align: start; width: 100%; }
  .transcript button[aria-current="step"] { background: var(--sb-accent-soft); color: var(--sb-ink); }
  .step-number { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .75rem; }
  .empty { background: var(--sb-paper); border: 1px dashed var(--sb-line); border-radius: var(--sb-radius); color: var(--sb-muted); padding: 40px; text-align: center; }
  .sr-only { height: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; width: 1px; clip: rect(0,0,0,0); white-space: nowrap; }
  @media (max-width: 620px) {
    .topline { min-height: 46px; }
    .provenance code { max-width: 28ch; }
    .stage { aspect-ratio: 4 / 3; }
    .copy { padding: 14px 16px; }
    .controls { grid-template-columns: 1fr auto; }
    .progress { grid-column: 1 / -1; grid-row: 1; }
    .nav { grid-row: 2; }
    .nav:last-child { justify-self: end; }
    .control .label { display: none; }
    .choice-card, .end-card { align-content: start; padding: 24px 18px; }
    h2 { font-size: 20px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
  }
  @media (forced-colors: active) {
    .hotspot, .choice, .cta, .control { forced-color-adjust: auto; }
    .bar > span { background: Highlight; }
  }
  :host(:dir(rtl)) .bar > span { transform-origin: right; }
  :host(:dir(rtl)) .directional-icon { display: inline-block; transform: scaleX(-1); }
`;

const AUTOPLAY_STORAGE_KEY = 'scenebook:autoplay-enabled';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function percent(value: number | undefined, fallback = 0): string {
  const safe = Number.isFinite(value) ? Number(value) : fallback;
  return `${Math.max(0, Math.min(1, safe)) * 100}%`;
}

function planePercent(value: number): string {
  return `${value * 100}%`;
}

interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

function parseOpaqueColor(value: string): RgbColor | null {
  const color = value.trim().toLowerCase();
  const named: Readonly<Record<string, string>> = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
  };
  const normalized = named[color] ?? color;
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/u.exec(normalized)?.[1];
  if (hex) {
    const expanded =
      hex.length === 3 ? [...hex].map((character) => character.repeat(2)).join('') : hex;
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\((.*)\)$/u.exec(normalized)?.[1];
  if (!rgb) return null;
  const [channels, alpha] = rgb.split('/').map((part) => part.trim());
  if (alpha && Number.parseFloat(alpha) < 1) return null;
  const values = channels?.split(/[\s,]+/u).filter(Boolean) ?? [];
  if (values.length !== 3) return null;
  const parsed = values.map((channel) => {
    const number = Number.parseFloat(channel);
    return channel.endsWith('%') ? (number / 100) * 255 : number;
  });
  if (parsed.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    return null;
  }
  return { red: parsed[0]!, green: parsed[1]!, blue: parsed[2]! };
}

function relativeLuminance(color: RgbColor): number {
  const linear = [color.red, color.green, color.blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(left: string, right: string): number {
  const first = parseOpaqueColor(left);
  const second = parseOpaqueColor(right);
  if (!first || !second) return 0;
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function bestTextColor(background: string): '#111315' | '#ffffff' {
  return contrastRatio(background, '#111315') >= contrastRatio(background, '#ffffff')
    ? '#111315'
    : '#ffffff';
}

function mixColor(from: string, to: string, amount: number): string {
  const start = parseOpaqueColor(from);
  const end = parseOpaqueColor(to);
  if (!start || !end) return from;
  const channel = (left: number, right: number): string =>
    Math.round(left + (right - left) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(start.red, end.red)}${channel(start.green, end.green)}${channel(start.blue, end.blue)}`;
}

function readableTone(
  foreground: string,
  background: string,
  surfaces: readonly string[],
  minimumContrast: number,
): string {
  let lower = 0;
  let upper = 1;
  let result = foreground;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const amount = (lower + upper) / 2;
    const candidate = mixColor(foreground, background, amount);
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= minimumContrast)) {
      result = candidate;
      lower = amount;
    } else {
      upper = amount;
    }
  }
  return result;
}

function accessibleTheme(theme: SceneDefinition['theme']): {
  readonly accent: string;
  readonly focus: string;
  readonly focusContrast: string;
  readonly ink: string;
  readonly line: string;
  readonly muted: string;
  readonly onAccent: string;
  readonly onInk: string;
  readonly paper: string;
  readonly surface: string;
} {
  const defaultPaper = '#f4f5f6';
  const defaultInk = '#1c1d1f';
  const defaultAccent = '#b83b24';
  const requestedPaper = safeThemeColor(theme?.paper, defaultPaper);
  const paper = parseOpaqueColor(requestedPaper) ? requestedPaper : defaultPaper;
  const requestedInk = safeThemeColor(theme?.ink, defaultInk);
  const ink =
    parseOpaqueColor(requestedInk) && contrastRatio(requestedInk, paper) >= 4.5
      ? requestedInk
      : bestTextColor(paper);
  const requestedAccent = safeThemeColor(theme?.accent, defaultAccent);
  const accent =
    parseOpaqueColor(requestedAccent) && contrastRatio(requestedAccent, '#ffffff') >= 4.5
      ? requestedAccent
      : defaultAccent;
  const mixedSurface = mixColor(paper, ink, 0.04);
  const surface = contrastRatio(ink, mixedSurface) >= 4.5 ? mixedSurface : paper;
  const surfaces = [paper, surface];
  return {
    accent,
    focus: ink,
    focusContrast: paper,
    ink,
    line: readableTone(ink, paper, surfaces, 3),
    muted: readableTone(ink, paper, surfaces, 4.5),
    onAccent: bestTextColor(accent),
    onInk: bestTextColor(ink),
    paper,
    surface,
  };
}

export class ScenebookPlayerElement extends HTMLElement {
  static readonly observedAttributes = ['step', 'transcript', 'practice'];

  readonly #root: ShadowRoot;
  #scene: SceneDefinition | null = null;
  #originScene: SceneDefinition | null = null;
  #scenes: Record<string, SceneDefinition> = {};
  #index = 0;
  #autoTimer: ReturnType<typeof setTimeout> | null = null;
  #completedStep: string | null = null;
  #ctaSubmitter: SceneCtaSubmitter | null = null;
  #formsDisabled = false;
  #transcriptOpen = false;
  #reflectingStep = false;
  #autoplayEnabled = false;
  #focusPaused = false;
  #hoverPaused = false;
  #keyboardPaused = false;
  #pointerPaused = false;
  readonly #submissionIds = new Map<string, string>();

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  get scene(): SceneDefinition | null {
    return this.#scene;
  }

  set scene(value: SceneDefinition | null) {
    this.#scene = value;
    this.#originScene = value;
    this.#index = value ? findStepIndex(value, this.getAttribute('step')) : 0;
    this.#completedStep = null;
    this.#render();
    if (value && validateScene(value, this.#scenes).length === 0) {
      this.#emit('scenebook:ready', this.#detail());
    }
  }

  get scenes(): Record<string, SceneDefinition> {
    return this.#scenes;
  }

  set scenes(value: Record<string, SceneDefinition>) {
    this.#scenes = value ?? {};
    this.#render();
  }

  get ctaSubmitter(): SceneCtaSubmitter | null {
    return this.#ctaSubmitter;
  }

  set ctaSubmitter(value: SceneCtaSubmitter | null) {
    this.#ctaSubmitter = typeof value === 'function' ? value : null;
    this.#render();
  }

  get formsDisabled(): boolean {
    return this.#formsDisabled;
  }

  set formsDisabled(value: boolean) {
    this.#formsDisabled = Boolean(value);
    this.#render();
  }

  get currentStep(): number {
    return this.#index;
  }

  set currentStep(value: number) {
    this.#setIndex(value, 'api');
  }

  connectedCallback(): void {
    this.#loadAutoplayPreference();
    this.#focusPaused = false;
    this.#hoverPaused = false;
    this.#keyboardPaused = false;
    this.#pointerPaused = false;
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    if (!this.hasAttribute('aria-label'))
      this.setAttribute('aria-label', 'Interactive walkthrough');
    this.addEventListener('keydown', this.#onKeyDown);
    this.addEventListener('keyup', this.#onKeyboardEnd);
    this.addEventListener('focusin', this.#onFocusIn);
    this.addEventListener('focusout', this.#onFocusOut);
    this.addEventListener('pointerenter', this.#onPointerEnter);
    this.addEventListener('pointerleave', this.#onPointerLeave);
    this.addEventListener('pointerdown', this.#onPointerStart);
    this.ownerDocument.addEventListener('visibilitychange', this.#onVisibilityChange);
    this.#render();
  }

  disconnectedCallback(): void {
    this.removeEventListener('keydown', this.#onKeyDown);
    this.removeEventListener('keyup', this.#onKeyboardEnd);
    this.removeEventListener('focusin', this.#onFocusIn);
    this.removeEventListener('focusout', this.#onFocusOut);
    this.removeEventListener('pointerenter', this.#onPointerEnter);
    this.removeEventListener('pointerleave', this.#onPointerLeave);
    this.removeEventListener('pointerdown', this.#onPointerStart);
    this.#removePointerReleaseListeners();
    this.ownerDocument.removeEventListener('visibilitychange', this.#onVisibilityChange);
    this.#focusPaused = false;
    this.#hoverPaused = false;
    this.#keyboardPaused = false;
    this.#pointerPaused = false;
    this.#clearTimer();
  }

  attributeChangedCallback(name: string, oldValue: string | null, value: string | null): void {
    if (oldValue === value) return;
    if (name === 'transcript') {
      this.#transcriptOpen = value !== null;
      const transcript = this.#root.querySelector<HTMLDetailsElement>('.transcript');
      if (transcript) transcript.open = this.#transcriptOpen;
      return;
    }
    if (name === 'step' && this.#scene) {
      this.#index = findStepIndex(this.#scene, value);
      if (this.#reflectingStep) return;
    }
    this.#render();
  }

  next(): void {
    this.#advance('next', false);
  }

  #advance(source: string, allowPractice: boolean): void {
    if (!this.#scene) return;
    if (validateScene(this.#scene, this.#scenes).length > 0) {
      this.#render();
      return;
    }
    const step = this.#scene.steps[this.#index];
    if (step?.type === 'choice' || (step?.practiceMode && !allowPractice)) return;
    if (this.#index >= this.#scene.steps.length - 1) {
      this.#emit('scenebook:complete', this.#detail());
      return;
    }
    this.#setIndex(this.#index + 1, source);
  }

  previous(): void {
    this.#setIndex(this.#index - 1, 'previous');
  }

  move(delta: number, source = delta < 0 ? 'previous' : 'next'): void {
    if (!Number.isFinite(delta) || !this.#scene) return;
    if (delta > 0) {
      const step = this.#scene.steps[this.#index];
      if (step?.type === 'choice' || step?.practiceMode) return;
    }
    this.#setIndex(this.#index + Math.trunc(delta), source);
  }

  goTo(index: number, source = 'api'): void {
    this.#setIndex(index, source);
  }

  restart(): void {
    if (this.#originScene) this.#scene = this.#originScene;
    this.#completedStep = null;
    this.#setIndex(0, 'restart');
  }

  #isRightToLeft(): boolean {
    const declaredDirection = this.closest<HTMLElement>('[dir]')?.dir.toLowerCase();
    if (declaredDirection === 'rtl') return true;
    if (declaredDirection === 'ltr') return false;
    return this.ownerDocument.defaultView?.getComputedStyle(this).direction === 'rtl';
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    this.#keyboardPaused = true;
    this.#clearTimer();
    const target = event.composedPath()[0];
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement &&
        (target.isContentEditable ||
          ['textbox', 'combobox', 'listbox', 'spinbutton'].includes(
            target.getAttribute('role') ?? '',
          )))
    )
      return;
    const nextArrow = this.#isRightToLeft() ? 'ArrowLeft' : 'ArrowRight';
    const previousArrow = this.#isRightToLeft() ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === nextArrow || event.key === 'PageDown') {
      event.preventDefault();
      this.next();
    } else if (event.key === previousArrow || event.key === 'PageUp') {
      event.preventDefault();
      this.previous();
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.#setIndex(0, 'keyboard');
    } else if (event.key === 'End' && this.#scene) {
      event.preventDefault();
      this.#setIndex(this.#scene.steps.length - 1, 'keyboard');
    }
  };

  #onFocusIn = (): void => {
    this.#focusPaused = true;
    this.#refreshAutoplay();
  };

  #onFocusOut = (): void => {
    queueMicrotask(() => {
      this.#focusPaused =
        Boolean(this.#root.activeElement) || this.ownerDocument.activeElement === this;
      this.#refreshAutoplay();
    });
  };

  #onPointerEnter = (): void => {
    this.#hoverPaused = true;
    this.#refreshAutoplay();
  };

  #onPointerLeave = (): void => {
    this.#hoverPaused = false;
    this.#refreshAutoplay();
  };

  #onKeyboardEnd = (): void => {
    this.#keyboardPaused = false;
    this.#refreshAutoplay();
  };

  #onPointerStart = (): void => {
    this.#pointerPaused = true;
    this.ownerDocument.addEventListener('pointerup', this.#onPointerEnd, true);
    this.ownerDocument.addEventListener('pointercancel', this.#onPointerEnd, true);
    this.#refreshAutoplay();
  };

  #onPointerEnd = (): void => {
    if (!this.#pointerPaused) return;
    this.#pointerPaused = false;
    this.#removePointerReleaseListeners();
    this.#refreshAutoplay();
  };

  #removePointerReleaseListeners(): void {
    this.ownerDocument.removeEventListener('pointerup', this.#onPointerEnd, true);
    this.ownerDocument.removeEventListener('pointercancel', this.#onPointerEnd, true);
  }

  #onVisibilityChange = (): void => {
    this.#refreshAutoplay();
  };

  #setIndex(index: number, source: string, force = false): void {
    if (!this.#scene || validateScene(this.#scene, this.#scenes).length > 0) {
      this.#render();
      return;
    }
    if (this.#scene.steps.length === 0) return;
    const next = Math.max(0, Math.min(index, this.#scene.steps.length - 1));
    if (next === this.#index && source !== 'restart' && !force) return;
    this.#index = next;
    this.#reflectingStep = true;
    try {
      this.setAttribute('step', this.#scene.steps[next]?.id ?? String(next));
    } finally {
      this.#reflectingStep = false;
    }
    this.#render();
    this.#emit('scenebook:stepchange', { ...this.#detail(), source });
    const step = this.#scene.steps[next];
    if (step?.type === 'end' && this.#completedStep !== step.id) {
      this.#completedStep = step.id;
      this.#emit('scenebook:complete', this.#detail());
    }
  }

  #choose(choice: SceneChoice): void {
    if (!this.#scene) return;
    const target = resolveChoice(choice, this.#scenes);
    const href = safeNavigationUrl(choice.href, this.ownerDocument.baseURI);
    const accepted = this.#emit('scenebook:branch', {
      ...this.#detail(),
      choice,
      resolved: Boolean(target || href),
    });
    if (!accepted) return;
    if (target) {
      this.#scene = target.scene;
      this.#completedStep = null;
      this.#setIndex(target.stepIndex, 'branch', true);
    } else if (href) window.location.assign(href);
  }

  #activateCta(cta: SceneCta): void {
    this.#emit('scenebook:cta', { ...this.#detail(), cta });
    if (cta.event === 'restart') this.restart();
  }

  #submissionId(stepId: string, ctaId: string): string {
    const key = `${stepId}:${ctaId}`;
    const existing = this.#submissionIds.get(key);
    if (existing) return existing;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = `cta-${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    this.#submissionIds.set(key, id);
    return id;
  }

  async #submitCtaForm(form: HTMLFormElement, step: PlayerStep, cta: SceneCta): Promise<void> {
    const fields = Object.fromEntries(
      (cta.fields ?? []).map((field) => {
        const input = form.elements.namedItem(field.id);
        return [
          field.id,
          field.type === 'checkbox'
            ? Boolean((input as HTMLInputElement | null)?.checked)
            : String((input as HTMLInputElement | null)?.value ?? ''),
        ];
      }),
    );
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const result = form.querySelector<HTMLElement>('.cta-result');
    const submission: SceneCtaSubmission = {
      sceneId: this.#scene?.id ?? '',
      stepId: step.id,
      ctaId: cta.id,
      cta,
      ...(cta.webhookId ? { webhookId: cta.webhookId } : {}),
      fields,
      submissionId: this.#submissionId(step.id, cta.id),
    };
    if (!this.#ctaSubmitter) {
      this.#emit('scenebook:cta', submission);
      if (result) {
        result.dataset.state = 'success';
        result.textContent = 'Response shared with the host page.';
      }
      return;
    }
    if (submit) submit.disabled = true;
    if (result) {
      result.dataset.state = 'pending';
      result.textContent = 'Sending your response…';
    }
    try {
      await this.#ctaSubmitter(submission);
      if (result) {
        result.dataset.state = 'success';
        result.textContent = 'Your response was sent.';
      }
      this.#emit('scenebook:cta', { ...submission, status: 'accepted' });
    } catch {
      if (submit) submit.disabled = false;
      if (result) {
        result.dataset.state = 'error';
        result.textContent =
          'Your response could not be sent. Check your connection and try again.';
      }
    }
  }

  #detail(): Record<string, unknown> {
    if (!this.#scene) return {};
    const state = snapshot(this.#scene, this.#index);
    return { sceneId: this.#scene.id, ...state };
  }

  #emit(name: string, detail: unknown): boolean {
    return this.dispatchEvent(
      new CustomEvent(name, {
        bubbles: true,
        cancelable: name === 'scenebook:branch',
        composed: true,
        detail,
      }),
    );
  }

  #clearTimer(): void {
    if (this.#autoTimer) clearTimeout(this.#autoTimer);
    this.#autoTimer = null;
  }

  #loadAutoplayPreference(): void {
    try {
      const stored = this.ownerDocument.defaultView?.localStorage.getItem(AUTOPLAY_STORAGE_KEY);
      if (stored === 'false') this.#autoplayEnabled = false;
      else if (stored === 'true') this.#autoplayEnabled = true;
    } catch {
      // Storage can be unavailable in sandboxed embeds; the in-memory control still works.
    }
  }

  #persistAutoplayPreference(): void {
    try {
      this.ownerDocument.defaultView?.localStorage.setItem(
        AUTOPLAY_STORAGE_KEY,
        String(this.#autoplayEnabled),
      );
    } catch {
      // Storage can be unavailable in sandboxed embeds; the in-memory control still works.
    }
  }

  #autoplayPaused(): boolean {
    const reducedMotion =
      this.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ??
      false;
    return (
      !this.isConnected ||
      !this.#autoplayEnabled ||
      this.#focusPaused ||
      this.#hoverPaused ||
      this.#keyboardPaused ||
      this.#pointerPaused ||
      this.ownerDocument.hidden ||
      reducedMotion
    );
  }

  #autoplayState(): 'Off' | 'On' | 'Paused' {
    if (!this.#autoplayEnabled) return 'Off';
    return this.#autoplayPaused() ? 'Paused' : 'On';
  }

  #updateAutoplayControl(): void {
    const control = this.#root.querySelector<HTMLButtonElement>('[data-autoplay]');
    if (!control) return;
    const state = this.#autoplayState();
    control.setAttribute('aria-pressed', String(this.#autoplayEnabled));
    control.setAttribute(
      'aria-label',
      `Autoplay ${state.toLowerCase()}. ${this.#autoplayEnabled ? 'Turn autoplay off' : 'Turn autoplay on'}`,
    );
    const stateLabel = control.querySelector<HTMLElement>('.autoplay-state');
    if (stateLabel) stateLabel.textContent = state;
  }

  #toggleAutoplay(): void {
    this.#autoplayEnabled = !this.#autoplayEnabled;
    this.#persistAutoplayPreference();
    this.#render();
  }

  #refreshAutoplay(): void {
    const step = this.#scene?.steps[this.#index];
    if (step) this.#schedule(step);
    else {
      this.#clearTimer();
      this.#updateAutoplayControl();
    }
  }

  #schedule(step: PlayerStep): void {
    this.#clearTimer();
    this.#updateAutoplayControl();
    if (
      !step.autoAdvance ||
      !step.durationMs ||
      step.type === 'choice' ||
      step.type === 'end' ||
      step.practiceMode ||
      (step.ctas?.length ?? 0) > 0
    )
      return;
    if (this.#autoplayPaused()) return;
    this.#autoTimer = setTimeout(() => this.next(), Math.max(800, step.durationMs));
  }

  #renderStage(step: PlayerStep): string {
    if (step.type === 'choice') {
      const choices = (step.choices ?? [])
        .map(
          (
            choice,
          ) => `<button class="choice" type="button" data-choice="${escapeHtml(choice.id)}" data-focus-key="choice:${escapeHtml(choice.id)}">
            <strong>${escapeHtml(choice.label)}</strong>
            ${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ''}
          </button>`,
        )
        .join('');
      return `<section class="stage"><div class="choice-card"><div><span class="step-meta">Choose a path</span><h2>${escapeHtml(step.title)}</h2></div>${step.instruction || step.caption ? `<p>${escapeHtml(step.instruction ?? step.caption ?? '')}</p>` : ''}<div class="choice-list">${choices}</div></div></section>`;
    }

    if (step.type === 'end' || step.type === 'intro' || step.type === 'separator') {
      const ctas = (step.ctas ?? [])
        .map((cta) => {
          if (cta.kind === 'form') {
            if (this.#formsDisabled) {
              return '<p class="cta-result" role="status">This form is unavailable in this publication because no submission destination is configured.</p>';
            }
            const fields = (cta.fields ?? [])
              .map(
                (field) =>
                  `<label>${escapeHtml(field.label)} <input type="${escapeHtml(field.type)}" name="${escapeHtml(field.id)}" data-focus-key="field:${escapeHtml(cta.id)}:${escapeHtml(field.id)}" ${field.required ? 'required' : ''} autocomplete="${field.type === 'email' ? 'email' : 'off'}"></label>`,
              )
              .join('');
            return `<form class="cta-form" data-cta-form="${escapeHtml(cta.id)}">${fields}<button type="submit" data-focus-key="form:${escapeHtml(cta.id)}">${escapeHtml(cta.label)}</button><p class="cta-result" role="status" aria-live="polite"></p></form>`;
          }
          const classes = `cta ${cta.variant === 'primary' ? 'primary' : ''}`;
          const href = safeNavigationUrl(cta.href, this.ownerDocument.baseURI);
          return href
            ? `<a class="${classes}" href="${escapeHtml(href)}" data-cta="${escapeHtml(cta.id)}" data-focus-key="cta:${escapeHtml(cta.id)}">${escapeHtml(cta.label)}</a>`
            : `<button class="${classes}" type="button" data-cta="${escapeHtml(cta.id)}" data-focus-key="cta:${escapeHtml(cta.id)}">${escapeHtml(cta.label)}</button>`;
        })
        .join('');
      return `<section class="stage"><div class="end-card"><span class="step-meta">${step.type === 'end' ? 'Complete' : 'Chapter'}</span><h2>${escapeHtml(step.title)}</h2>${step.instruction || step.caption ? `<p>${escapeHtml(step.instruction ?? step.caption ?? '')}</p>` : ''}${ctas ? `<div class="cta-list">${ctas}</div>` : ''}</div></section>`;
    }

    const crop = effectiveCrop(step.crop);
    const frame =
      step.frame === 'mobile' || step.frame === 'none' || step.frame === 'browser'
        ? step.frame
        : 'browser';
    const masks = (step.masks ?? [])
      .map((mask) => {
        const rect = mapRectToCrop(mask, crop);
        const mode = mask.mode === 'blur' ? 'blur' : 'opaque';
        return rect
          ? `<span class="mask ${mode}" role="img" aria-label="${escapeHtml(mask.label ?? (mode === 'blur' ? 'Blurred region' : 'Redacted content'))}" style="left:${percent(rect.x)};top:${percent(rect.y)};width:${percent(rect.width)};height:${percent(rect.height)}"></span>`
          : '';
      })
      .join('');
    const annotations = (step.annotations ?? [])
      .map((annotation, index) => {
        const color = safeThemeColor(annotation.color, 'var(--sb-accent)');
        if (annotation.kind === 'arrow') {
          const from = mapPointToCrop(
            { x: annotation.fromX ?? annotation.x - 0.08, y: annotation.fromY ?? annotation.y },
            crop,
          );
          const to = mapPointToCrop(annotation, crop);
          if (!from || !to) return '';
          const markerId = `sb-arrow-${index}`;
          return `<svg class="annotation-arrow" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(annotation.text)}"><defs><marker id="${markerId}" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="${color}"/></marker></defs><line x1="${from.x * 100}" y1="${from.y * 100}" x2="${to.x * 100}" y2="${to.y * 100}" stroke="${color}" marker-end="url(#${markerId})"/></svg>`;
        }
        const width = annotation.width ?? (annotation.kind === 'spotlight' ? 0.16 : 0.2);
        const height = annotation.height ?? (annotation.kind === 'spotlight' ? 0.16 : 0.1);
        const rect = mapRectToCrop(
          { x: annotation.x - width / 2, y: annotation.y - height / 2, width, height },
          crop,
        );
        return rect
          ? `<span class="annotation ${escapeHtml(annotation.kind ?? 'note')}" role="note" aria-label="${escapeHtml(annotation.text)}" style="left:${percent(rect.x)};top:${percent(rect.y)};width:${percent(rect.width)};height:${percent(rect.height)};--annotation-color:${color}">${annotation.kind === 'spotlight' ? '' : escapeHtml(annotation.text)}</span>`
          : '';
      })
      .join('');
    let hotspot = '';
    if (step.hotspot) {
      const width = Math.max(0, Math.min(1, step.hotspot.width ?? 0));
      const height = Math.max(0, Math.min(1, step.hotspot.height ?? 0));
      const mappedRect =
        width > 0 && height > 0
          ? mapRectToCrop(
              {
                x: step.hotspot.x - width / 2,
                y: step.hotspot.y - height / 2,
                width,
                height,
              },
              crop,
            )
          : undefined;
      const point = mappedRect
        ? { x: mappedRect.x + mappedRect.width / 2, y: mappedRect.y + mappedRect.height / 2 }
        : mapPointToCrop(step.hotspot, crop);
      if (point) {
        const labelPosition = [
          point.x <= 0.35 ? 'label-left' : point.x >= 0.65 ? 'label-right' : '',
          point.y >= 0.65 ? 'label-above' : '',
        ]
          .filter(Boolean)
          .join(' ');
        hotspot = `<button class="hotspot${labelPosition ? ` ${labelPosition}` : ''}" type="button" data-hotspot-next data-focus-key="hotspot" aria-label="${escapeHtml(step.hotspot.label)}" style="left:${percent(point.x, 0.5)};top:${percent(point.y, 0.5)}"><span class="hotspot-label">${escapeHtml(step.hotspot.label)}</span></button>`;
      }
    }
    const cursorPoint = step.cursor?.visible ? mapPointToCrop(step.cursor, crop) : undefined;
    const cursor = cursorPoint
      ? `<span class="cursor${step.cursor?.click ? ' click' : ''} ${escapeHtml(step.cursor?.style ?? 'default')}" aria-hidden="true" style="left:${percent(cursorPoint.x)};top:${percent(cursorPoint.y)};--sb-click-delay:${Math.max(0, step.cursor?.clickAtMs ?? 0)}ms"><svg viewBox="0 0 24 32" focusable="false"><path d="M2 2v24l6-6 4 10 5-2-4-9h8z" fill="white" stroke="#171512" stroke-width="2" stroke-linejoin="round"/></svg></span>`
      : '';
    const imageSource = safeImageSource(step.image, this.ownerDocument.baseURI);
    const secondaryImageSource = safeImageSource(step.secondaryImage, this.ownerDocument.baseURI);
    const image = imageSource
      ? `<div class="image-plane" style="left:${planePercent(-crop.x / crop.width)};top:${planePercent(-crop.y / crop.height)};width:${planePercent(1 / crop.width)};height:${planePercent(1 / crop.height)}"><img src="${escapeHtml(imageSource)}" alt="${escapeHtml(step.alt ?? '')}" draggable="false"></div>`
      : '<div class="empty">No screenshot for this step.</div>';
    const media = secondaryImageSource
      ? `<div class="comparison">${image}<div class="image-plane"><img src="${escapeHtml(secondaryImageSource)}" alt="${escapeHtml(`${step.alt ?? step.title} after`)}" draggable="false"></div></div>`
      : image;
    const chrome =
      frame === 'browser'
        ? `<div class="browser-chrome" aria-hidden="true"><i></i><i></i><i></i><span>${escapeHtml(step.title)}</span></div>`
        : frame === 'mobile'
          ? '<div class="mobile-chrome" aria-hidden="true"></div>'
          : '';
    return `<figure class="stage" aria-label="${escapeHtml(step.title)}" data-frame="${frame}" data-transition="${escapeHtml(step.transition ?? 'fade')}" data-crop-x="${crop.x}" data-crop-y="${crop.y}" data-crop-zoom="${1 / crop.width}"><div class="presentation-frame frame-${frame}">${chrome}<div class="media-viewport">${media}<div class="media-overlays">${masks}${annotations}${cursor}${hotspot}</div></div></div></figure>`;
  }

  #animateCursor(step: PlayerStep): void {
    const cursor = step.cursor;
    const element = this.#root.querySelector<HTMLElement>('.cursor');
    if (!cursor?.visible || !element || (cursor.path?.length ?? 0) < 2) return;
    if (this.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const crop = effectiveCrop(step.crop);
    const duration = Math.max(
      1,
      step.durationMs ?? cursor.path?.at(-1)?.atMs ?? cursor.clickAtMs ?? 1,
    );
    const frames = (cursor.path ?? []).flatMap((keyframe) => {
      const point = mapPointToCrop(keyframe, crop);
      return point
        ? [
            {
              left: percent(point.x),
              top: percent(point.y),
              offset: Math.max(0, Math.min(1, keyframe.atMs / duration)),
            },
          ]
        : [];
    });
    if (frames.length < 2 || typeof element.animate !== 'function') return;
    element.animate(frames, { duration, easing: 'linear', fill: 'forwards' });
  }

  #activeFocusKey(): string | null {
    const active = this.#root.activeElement;
    return active instanceof HTMLElement ? (active.dataset.focusKey ?? null) : null;
  }

  #restoreFocus(key: string): void {
    const focusable = [...this.#root.querySelectorAll<HTMLElement>('[data-focus-key]')].filter(
      (element) =>
        !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true',
    );
    const find = (candidate: string): HTMLElement | undefined =>
      focusable.find((element) => element.dataset.focusKey === candidate);
    const fallbackKeys =
      key === 'previous'
        ? ['next', `jump:${this.#index}`, 'transcript']
        : ['previous', 'next', `jump:${this.#index}`, 'transcript'];
    const target = find(key) ?? fallbackKeys.map(find).find(Boolean);
    if (target) target.focus({ preventScroll: true });
    else if (this.isConnected) this.focus({ preventScroll: true });
  }

  #render(): void {
    const focusKey = this.#activeFocusKey();
    try {
      this.#renderContent();
    } catch {
      this.#clearTimer();
      this.#root.innerHTML = `<style>${styles}</style><div class="empty" role="alert"><strong>This Scene cannot be played.</strong><br>Scene data is malformed.</div>`;
    }
    if (focusKey) this.#restoreFocus(focusKey);
  }

  #renderContent(): void {
    this.#clearTimer();
    const currentTranscript = this.#root.querySelector<HTMLDetailsElement>('.transcript');
    if (currentTranscript) this.#transcriptOpen = currentTranscript.open;
    const scene = this.#scene;
    if (!scene) {
      this.#root.innerHTML = `<style>${styles}</style><div class="empty">Set the <code>scene</code> property to load a walkthrough.</div>`;
      return;
    }

    const errors = validateScene(scene, this.#scenes);
    if (errors.length) {
      this.#root.innerHTML = `<style>${styles}</style><div class="empty" role="alert"><strong>This Scene cannot be played.</strong><br>${escapeHtml(errors[0])}</div>`;
      return;
    }

    const state = snapshot(scene, this.#index);
    const step = scene.steps[state.index];
    if (!step) return;
    const theme = scene.theme ?? {};
    const colors = accessibleTheme(theme);
    const transcriptOpen = this.#transcriptOpen || this.hasAttribute('transcript') ? 'open' : '';
    const verified =
      scene.verified?.status === 'passed' ? '<span class="verified">Verified</span>' : '';
    const provenance = scene.verified?.commit
      ? `<details class="provenance"><summary data-focus-key="provenance">Provenance</summary><code>${escapeHtml(scene.verified.commit)}</code></details>`
      : '';
    const evidence =
      verified || provenance ? `<div class="evidence">${verified}${provenance}</div>` : '';
    const transcript = scene.steps
      .map(
        (item, index) =>
          `<li><button type="button" data-jump="${index}" data-focus-key="jump:${index}" ${index === state.index ? 'aria-current="step"' : ''}><span class="step-number">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(item.title)}</span></button></li>`,
      )
      .join('');

    this.#root.innerHTML = `<style>${styles}</style>
      <article class="player" style="--sb-accent:${colors.accent};--sb-on-accent:${colors.onAccent};--sb-paper:${colors.paper};--sb-surface:${colors.surface};--sb-ink:${colors.ink};--sb-on-ink:${colors.onInk};--sb-muted:${colors.muted};--sb-line:${colors.line};--sb-focus:${colors.focus};--sb-focus-contrast:${colors.focusContrast};--sb-radius:${safeRadius(theme.radius)}px">
        <div class="topline"><span class="scene-name">${escapeHtml(scene.title)}</span>${evidence}</div>
        ${this.#renderStage(step)}
        ${step.type === 'screen' || !step.type ? `<section class="copy"><span class="step-meta">Step ${state.index + 1} of ${state.total}</span><h2>${escapeHtml(step.title)}</h2>${step.instruction || step.caption ? `<p class="instruction">${escapeHtml(step.instruction ?? step.caption ?? '')}</p>` : ''}</section>` : ''}
        <div class="controls" role="group" aria-label="Walkthrough controls">
          <div class="nav"><button class="control" type="button" data-previous data-focus-key="previous" ${!state.canGoBack ? 'disabled' : ''} aria-label="Previous step"><span class="directional-icon" aria-hidden="true">←</span> <span class="label">Previous</span></button><button class="control autoplay-control" type="button" data-autoplay data-focus-key="autoplay" aria-pressed="${this.#autoplayEnabled}" aria-label="Autoplay ${this.#autoplayState().toLowerCase()}. ${this.#autoplayEnabled ? 'Turn autoplay off' : 'Turn autoplay on'}"><span>Autoplay</span><span class="autoplay-state">${this.#autoplayState()}</span></button></div>
          <div class="progress" role="progressbar" aria-label="Walkthrough progress" aria-valuemin="1" aria-valuemax="${state.total}" aria-valuenow="${state.index + 1}"><span class="bar"><span style="--sb-progress:${state.progress}"></span></span><span class="progress-text">${state.index + 1} / ${state.total}</span></div>
          <div class="nav">${step.type === 'end' ? '' : `<button class="control" type="button" data-next data-focus-key="next" ${!state.canGoForward && !(state.index === state.total - 1 && step.type !== 'choice' && !step.practiceMode) ? 'disabled' : ''} aria-label="${state.index === state.total - 1 ? 'Finish walkthrough' : 'Next step'}">${state.index === state.total - 1 ? 'Finish' : '<span class="label">Next</span> <span class="directional-icon" aria-hidden="true">→</span>'}</button>`}</div>
        </div>
        <details class="transcript" ${transcriptOpen}><summary data-focus-key="transcript">Transcript · ${state.total} steps</summary><ol>${transcript}</ol></details>
        <p class="sr-only" aria-live="polite">Step ${state.index + 1} of ${state.total}: ${escapeHtml(step.title)}. ${escapeHtml(step.instruction ?? '')}</p>
      </article>`;

    this.#root
      .querySelectorAll<HTMLElement>('[data-next]')
      .forEach((element) => element.addEventListener('click', () => this.next()));
    this.#root
      .querySelectorAll<HTMLElement>('[data-hotspot-next]')
      .forEach((element) =>
        element.addEventListener('click', () => this.#advance('hotspot', true)),
      );
    this.#root
      .querySelector<HTMLElement>('[data-previous]')
      ?.addEventListener('click', () => this.previous());
    this.#root
      .querySelector<HTMLElement>('[data-autoplay]')
      ?.addEventListener('click', () => this.#toggleAutoplay());
    this.#root
      .querySelectorAll<HTMLElement>('[data-jump]')
      .forEach((element) =>
        element.addEventListener('click', () =>
          this.#setIndex(Number(element.dataset.jump), 'transcript'),
        ),
      );
    this.#root.querySelectorAll<HTMLElement>('[data-choice]').forEach((element) =>
      element.addEventListener('click', () => {
        const choice = step.choices?.find((candidate) => candidate.id === element.dataset.choice);
        if (choice) this.#choose(choice);
      }),
    );
    this.#root.querySelectorAll<HTMLElement>('[data-cta]').forEach((element) =>
      element.addEventListener('click', (event) => {
        const cta = step.ctas?.find((candidate) => candidate.id === element.dataset.cta);
        if (cta) {
          if (cta.event === 'restart' || cta.kind === 'restart') event.preventDefault();
          this.#activateCta(cta);
        }
      }),
    );
    this.#root.querySelectorAll<HTMLFormElement>('[data-cta-form]').forEach((form) =>
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const cta = step.ctas?.find((candidate) => candidate.id === form.dataset.ctaForm);
        if (cta) void this.#submitCtaForm(form, step, cta);
      }),
    );
    this.#animateCursor(step);
    this.#schedule(step);
  }
}

export function registerScenebookPlayer(tagName = 'scenebook-player'): void {
  if (!customElements.get(tagName)) customElements.define(tagName, ScenebookPlayerElement);
}
