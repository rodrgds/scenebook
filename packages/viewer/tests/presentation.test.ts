// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

import { registerScenebookPlayer, type ScenebookPlayerElement } from '../src/scenebook-player.js';
import {
  effectiveCrop,
  mapPointToCrop,
  mapRectToCrop,
  safePresentationPoint,
  safePresentationRect,
} from '../src/presentation.js';
import type { SceneDefinition } from '../src/types.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('viewer presentation geometry', () => {
  it('bounds malformed crop, point, and rectangle geometry', () => {
    const crop = effectiveCrop({ x: 4, y: -3, zoom: 99 });
    expect(crop).toEqual({ x: 0.9, y: 0, width: 0.1, height: 0.1 });
    expect(safePresentationPoint({ x: -4, y: 8 })).toEqual({ x: 0, y: 1 });
    const bounded = safePresentationRect({ x: 0.8, y: 0.7, width: 4, height: 3 });
    expect(bounded.x).toBe(0.8);
    expect(bounded.y).toBe(0.7);
    expect(bounded.width).toBeCloseTo(0.2);
    expect(bounded.height).toBeCloseTo(0.3);
    const mappedPoint = mapPointToCrop({ x: 1, y: 0.05 }, crop)!;
    expect(mappedPoint.x).toBeCloseTo(1);
    expect(mappedPoint.y).toBeCloseTo(0.5);
    const mappedRect = mapRectToCrop({ x: 0.95, y: 0.05, width: 1, height: 1 }, crop)!;
    expect(mappedRect.x).toBeCloseTo(0.5);
    expect(mappedRect.y).toBeCloseTo(0.5);
    expect(mappedRect.width).toBeCloseTo(0.5);
    expect(mappedRect.height).toBeCloseTo(0.5);
  });

  it('renders authored crop, frame, cursor, masks, annotations, and hotspot safely', () => {
    const tag = 'scenebook-presentation-test';
    registerScenebookPlayer(tag);
    const player = document.createElement(tag) as ScenebookPlayerElement;
    document.body.append(player);
    const scene: SceneDefinition = {
      version: 1,
      id: 'presentation-scene',
      title: 'Presentation proof',
      steps: [
        {
          id: 'proof',
          type: 'screen',
          title: 'Apply presentation',
          alt: 'A safely presented product screen',
          image: 'data:image/png;base64,iVBORw0KGgo=',
          crop: { x: 0.75, y: 0.25, zoom: 2 },
          frame: 'browser',
          cursor: {
            x: 0.9,
            y: 0.4,
            visible: true,
            click: true,
            clickAtMs: 700,
            style: 'dot',
            path: [
              { atMs: 0, x: 0.55, y: 0.3 },
              { atMs: 600, x: 0.9, y: 0.4 },
            ],
          },
          hotspot: { x: 0.8, y: 0.35, width: 0.1, height: 0.1, label: 'Continue' },
          masks: [
            { id: 'mask', mode: 'opaque', x: 0.7, y: 0.3, width: 0.6, height: 0.6 },
            {
              id: 'blur',
              mode: 'blur',
              x: 0.55,
              y: 0.18,
              width: 0.12,
              height: 0.08,
              label: 'De-emphasized total',
            },
          ],
          annotations: [
            {
              id: 'note',
              kind: 'callout',
              x: 0.76,
              y: 0.2,
              width: 0.18,
              height: 0.1,
              text: 'Notice this',
            },
            {
              id: 'spotlight',
              kind: 'spotlight',
              x: 0.82,
              y: 0.32,
              width: 0.16,
              height: 0.14,
              text: 'Important region',
              color: '#7c3aed',
            },
            {
              id: 'arrow',
              kind: 'arrow',
              fromX: 0.56,
              fromY: 0.24,
              x: 0.86,
              y: 0.36,
              text: 'Follow this arrow',
              color: '#237a57',
            },
          ],
        },
      ],
    };
    player.scene = scene;

    const root = player.shadowRoot!;
    const stage = root.querySelector<HTMLElement>('.stage')!;
    expect(stage.dataset.frame).toBe('browser');
    expect(stage.dataset.cropZoom).toBe('2');
    expect(root.querySelector('.browser-chrome')).toBeTruthy();
    expect(root.querySelector('.cursor.click.dot')).toBeTruthy();
    expect(root.querySelector('.annotation')?.textContent).toContain('Notice this');
    expect(root.querySelector('.annotation.spotlight')).toBeTruthy();
    expect(root.querySelector('.mask.opaque')).toBeTruthy();
    expect(root.querySelector('.mask.blur')?.getAttribute('aria-label')).toBe(
      'De-emphasized total',
    );
    expect(root.querySelector('.annotation-arrow')?.getAttribute('aria-label')).toBe(
      'Follow this arrow',
    );
    expect(root.querySelector<HTMLButtonElement>('.hotspot')?.getAttribute('aria-label')).toBe(
      'Continue',
    );

    for (const element of root.querySelectorAll<HTMLElement>(
      '.mask,.annotation,.cursor,.hotspot',
    )) {
      for (const property of ['left', 'top'] as const) {
        const value = Number.parseFloat(element.style[property]);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });
});
