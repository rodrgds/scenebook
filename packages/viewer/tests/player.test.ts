// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerScenebookPlayer, type ScenebookPlayerElement } from '../src/scenebook-player.js';
import type { SceneDefinition } from '../src/types.js';

const tag = 'scenebook-state-semantics-test';
registerScenebookPlayer(tag);

afterEach(() => {
  document.body.replaceChildren();
});

function player(): ScenebookPlayerElement {
  const element = document.createElement(tag) as ScenebookPlayerElement;
  document.body.append(element);
  return element;
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
