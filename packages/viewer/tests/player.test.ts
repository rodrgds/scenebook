// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerScenebookPlayer, type ScenebookPlayerElement } from '../src/scenebook-player.js';
import type { SceneDefinition } from '../src/types.js';

const tag = 'scenebook-state-semantics-test';
registerScenebookPlayer(tag);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.replaceChildren();
});

function player(): ScenebookPlayerElement {
  const element = document.createElement(tag) as ScenebookPlayerElement;
  document.body.append(element);
  return element;
}

function contrast(left: string, right: string): number {
  const luminance = (value: string): number => {
    const channels = value
      .slice(1)
      .match(/.{2}/gu)!
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const first = luminance(left);
  const second = luminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const origin: SceneDefinition = {
  version: 1,
  id: 'origin',
  title: 'Choose a route',
  steps: [
    {
      id: 'route',
      type: 'choice',
      title: 'Route',
      choices: [{ id: 'finish', label: 'Finish', sceneId: 'target', stepId: 'target-end' }],
    },
  ],
};

const target: SceneDefinition = {
  version: 1,
  id: 'target',
  title: 'Target',
  steps: [{ id: 'target-end', type: 'end', title: 'Finished' }],
};

describe('player runtime state', () => {
  it('applies normal reflected-step and completion semantics to branch transitions', () => {
    const element = player();
    element.scenes = { target };
    element.scene = origin;
    const stepChanges: Array<Record<string, unknown>> = [];
    const completions: Array<Record<string, unknown>> = [];
    element.addEventListener('scenebook:stepchange', (event) =>
      stepChanges.push((event as CustomEvent<Record<string, unknown>>).detail),
    );
    element.addEventListener('scenebook:complete', (event) =>
      completions.push((event as CustomEvent<Record<string, unknown>>).detail),
    );

    element.shadowRoot!.querySelector<HTMLButtonElement>('[data-choice="finish"]')!.click();

    expect(element.scene).toBe(target);
    expect(element.currentStep).toBe(0);
    expect(element.getAttribute('step')).toBe('target-end');
    expect(stepChanges).toEqual([
      expect.objectContaining({
        sceneId: 'target',
        stepId: 'target-end',
        complete: true,
        source: 'branch',
      }),
    ]);
    expect(completions).toEqual([
      expect.objectContaining({ sceneId: 'target', stepId: 'target-end', complete: true }),
    ]);
  });

  it('honors cancellation of a branch event before changing Scene state', () => {
    const element = player();
    element.scenes = { target };
    element.scene = origin;
    element.addEventListener('scenebook:branch', (event) => event.preventDefault());
    const change = vi.fn();
    element.addEventListener('scenebook:stepchange', change);

    element.shadowRoot!.querySelector<HTMLButtonElement>('[data-choice="finish"]')!.click();

    expect(element.scene).toBe(origin);
    expect(element.getAttribute('step')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });

  it('renders malformed runtime input as an accessible alert without throwing', () => {
    const element = player();
    const malformed = {
      version: 1,
      id: 'broken',
      title: 'Broken',
      steps: null,
    } as unknown as SceneDefinition;

    expect(() => {
      element.scene = malformed;
    }).not.toThrow();

    const alert = element.shadowRoot!.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain('This Scene cannot be played.');
    expect(alert?.textContent).toContain('Scene steps must be an array.');
  });

  it('lets the final non-end step complete from the visible Finish control', () => {
    const element = player();
    element.scene = {
      version: 1,
      id: 'single-screen',
      title: 'Single screen',
      steps: [{ id: 'only', type: 'screen', title: 'Only step' }],
    };
    const complete = vi.fn();
    element.addEventListener('scenebook:complete', complete);

    const finish = element.shadowRoot!.querySelector<HTMLButtonElement>('[data-next]');
    expect(finish?.disabled).toBe(false);
    expect(finish?.textContent).toContain('Finish');
    finish?.click();

    expect(complete).toHaveBeenCalledOnce();
  });

  it('advances practice steps only through their authored hotspot', () => {
    const element = player();
    element.scene = {
      version: 1,
      id: 'practice',
      title: 'Practice',
      steps: [
        {
          id: 'try-it',
          type: 'screen',
          title: 'Try it',
          practiceMode: true,
          hotspot: { x: 0.5, y: 0.5, label: 'Continue' },
        },
        { id: 'done', type: 'end', title: 'Done' },
      ],
    };

    element.next();
    expect(element.currentStep).toBe(0);

    element.shadowRoot!.querySelector<HTMLButtonElement>('[data-hotspot-next]')!.click();
    expect(element.currentStep).toBe(1);
  });

  it('preserves logical keyboard focus across full shadow-root rerenders', () => {
    const element = player();
    element.scene = {
      version: 1,
      id: 'keyboard-navigation',
      title: 'Keyboard navigation',
      steps: [
        { id: 'first', type: 'screen', title: 'First' },
        { id: 'second', type: 'screen', title: 'Second' },
        { id: 'done', type: 'end', title: 'Done' },
      ],
    };

    const firstNext = element.shadowRoot!.querySelector<HTMLButtonElement>('[data-next]')!;
    firstNext.focus();
    firstNext.click();

    const secondNext = element.shadowRoot!.querySelector<HTMLButtonElement>('[data-next]')!;
    expect(element.currentStep).toBe(1);
    expect(secondNext).not.toBe(firstNext);
    expect(element.shadowRoot!.activeElement).toBe(secondNext);

    secondNext.click();

    const previous = element.shadowRoot!.querySelector<HTMLButtonElement>('[data-previous]')!;
    expect(element.currentStep).toBe(2);
    expect(element.shadowRoot!.querySelector('[data-next]')).toBeNull();
    expect(element.shadowRoot!.activeElement).toBe(previous);
  });

  it('mirrors directional keyboard navigation for right-to-left players', () => {
    const element = player();
    element.dir = 'rtl';
    element.scene = {
      version: 1,
      id: 'rtl-keyboard-navigation',
      title: 'RTL keyboard navigation',
      steps: [
        { id: 'first', type: 'screen', title: 'First' },
        { id: 'second', type: 'screen', title: 'Second' },
      ],
    };

    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, composed: true }),
    );
    expect(element.currentStep).toBe(1);

    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, composed: true }),
    );
    expect(element.currentStep).toBe(0);
  });

  it('names the control group and keeps edge hotspot labels inside the media overlay', () => {
    const element = player();
    element.scene = {
      version: 1,
      id: 'edge-hotspot',
      title: 'Edge hotspot',
      steps: [
        {
          id: 'edge',
          type: 'screen',
          title: 'Edge',
          practiceMode: true,
          hotspot: { x: 0.98, y: 0.98, label: 'Continue from the lower-right edge' },
        },
        { id: 'done', type: 'end', title: 'Done' },
      ],
    };

    const controls = element.shadowRoot!.querySelector<HTMLElement>('.controls');
    expect(controls?.getAttribute('role')).toBe('group');
    expect(controls?.getAttribute('aria-label')).toBe('Walkthrough controls');

    const overlay = element.shadowRoot!.querySelector<HTMLElement>('.media-overlays')!;
    const hotspot = overlay.querySelector<HTMLButtonElement>('[data-hotspot-next]')!;
    expect(hotspot.classList.contains('label-right')).toBe(true);
    expect(hotspot.classList.contains('label-above')).toBe(true);
    expect(overlay.contains(hotspot)).toBe(true);
  });

  it('derives readable surfaces, metadata, lines, and focus colors for dark themes', () => {
    const element = player();
    element.scene = {
      version: 1,
      id: 'dark-theme',
      title: 'Dark theme',
      theme: { paper: '#000000', ink: '#ffffff' },
      steps: [{ id: 'done', type: 'end', title: 'Done' }],
    };

    const article = element.shadowRoot!.querySelector<HTMLElement>('.player')!;
    const value = (name: string): string => article.style.getPropertyValue(`--sb-${name}`);
    expect(value('surface')).toBe('#0a0a0a');
    expect(contrast(value('muted'), value('paper'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(value('muted'), value('surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(value('line'), value('paper'))).toBeGreaterThanOrEqual(3);
    expect(contrast(value('line'), value('surface'))).toBeGreaterThanOrEqual(3);
    expect(value('focus')).toBe('#ffffff');
    expect(value('focus-contrast')).toBe('#000000');
  });

  it('keeps commit provenance in a collapsed disclosure', () => {
    const element = player();
    element.scene = {
      version: 1,
      id: 'provenance',
      title: 'Provenance',
      verified: { status: 'passed', commit: 'abc123def456' },
      steps: [{ id: 'done', type: 'end', title: 'Done' }],
    };

    const verified = element.shadowRoot!.querySelector<HTMLElement>('.verified')!;
    const provenance = element.shadowRoot!.querySelector<HTMLDetailsElement>('.provenance')!;
    expect(verified.textContent).toBe('Verified');
    expect(verified.textContent).not.toContain('abc123def456');
    expect(provenance.open).toBe(false);
    expect(provenance.querySelector('code')?.textContent).toBe('abc123def456');
  });

  it('exposes and persists the autoplay preference', () => {
    const element = player();
    element.scene = {
      version: 1,
      id: 'autoplay-preference',
      title: 'Autoplay preference',
      steps: [{ id: 'done', type: 'end', title: 'Done' }],
    };

    const toggle = element.shadowRoot!.querySelector<HTMLButtonElement>('[data-autoplay]')!;
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    expect(
      element
        .shadowRoot!.querySelector<HTMLButtonElement>('[data-autoplay]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(localStorage.getItem('scenebook:autoplay-enabled')).toBe('true');

    element.remove();
    const persisted = player();
    persisted.scene = {
      version: 1,
      id: 'persisted-autoplay-preference',
      title: 'Persisted autoplay preference',
      steps: [{ id: 'done', type: 'end', title: 'Done' }],
    };
    expect(
      persisted
        .shadowRoot!.querySelector<HTMLButtonElement>('[data-autoplay]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('pauses authored autoplay for focus, hover, visibility, and active interaction', () => {
    vi.useFakeTimers();
    localStorage.setItem('scenebook:autoplay-enabled', 'true');
    const autoplayScene = (): SceneDefinition => ({
      version: 1,
      id: 'autoplay',
      title: 'Autoplay',
      steps: [
        {
          id: 'auto',
          type: 'screen',
          title: 'Auto',
          autoAdvance: true,
          durationMs: 1_000,
        },
        { id: 'done', type: 'end', title: 'Done' },
      ],
    });
    const pausedPlayer = (): ScenebookPlayerElement => {
      const element = player();
      element.scene = autoplayScene();
      return element;
    };
    const remainsPaused = (element: ScenebookPlayerElement): void => {
      vi.advanceTimersByTime(1_500);
      expect(element.currentStep).toBe(0);
      element.remove();
    };

    const focused = pausedPlayer();
    focused.shadowRoot!.querySelector<HTMLButtonElement>('[data-next]')!.focus();
    remainsPaused(focused);

    const hovered = pausedPlayer();
    hovered.dispatchEvent(new Event('pointerenter'));
    remainsPaused(hovered);

    const interacting = pausedPlayer();
    interacting.dispatchEvent(new Event('pointerdown'));
    remainsPaused(interacting);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const backgrounded = pausedPlayer();
    remainsPaused(backgrounded);
    hidden.mockRestore();
  });

  it('resumes authored autoplay after a pointer is released outside the player', () => {
    vi.useFakeTimers();
    localStorage.setItem('scenebook:autoplay-enabled', 'true');
    const element = player();
    element.scene = {
      version: 1,
      id: 'outside-pointer-release',
      title: 'Outside pointer release',
      steps: [
        {
          id: 'auto',
          type: 'screen',
          title: 'Auto',
          autoAdvance: true,
          durationMs: 1_000,
        },
        { id: 'done', type: 'end', title: 'Done' },
      ],
    };

    element.dispatchEvent(new Event('pointerdown'));
    document.body.dispatchEvent(new Event('pointerup', { bubbles: true }));
    vi.advanceTimersByTime(1_500);

    expect(element.currentStep).toBe(1);
  });

  it('falls back to an accessible text color for low-contrast authored themes', () => {
    const element = player();
    element.scene = {
      version: 1,
      id: 'contrast',
      title: 'Contrast',
      theme: { paper: '#000000', ink: '#111111', accent: '#ffff00' },
      steps: [{ id: 'done', type: 'end', title: 'Done' }],
    };

    const article = element.shadowRoot!.querySelector<HTMLElement>('.player');
    expect(article?.getAttribute('style')).toContain('--sb-ink:#ffffff');
    expect(article?.getAttribute('style')).toContain('--sb-accent:#b83b24');
  });
});
