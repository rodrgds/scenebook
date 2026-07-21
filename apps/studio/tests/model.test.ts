import { describe, expect, it } from 'vitest';

import { catalogScenes, demoScene } from '../src/lib/demo';
import {
  cloneEditorWorkingScene,
  cloneScene,
  moveAnnotation,
  moveMask,
  duplicateStep,
  moveStep,
  normalizedPoint,
  removeStep,
  resizeAnnotation,
  resizeMask,
  toPlayerScene,
} from '../src/lib/model';

describe('Studio scene editing', () => {
  it('clones mutable history state without duplicating immutable archive payloads', () => {
    const source = cloneScene(demoScene);
    source.portableSource = { id: source.id } as never;
    source.portableAssets = { 'assets/screen.png': `data:image/png;base64,${'A'.repeat(1_000)}` };
    source.portableSidecars = { 'narrative.md': 'data:text/plain;base64,bm90ZXM=' };
    source.translations = {
      'pt-PT': {
        title: 'Convidar colega',
        steps: { [source.steps[0]!.id]: { caption: 'Legenda' } },
      },
    };
    source.steps[0]!.ctas = [
      {
        id: 'contact',
        label: 'Contact us',
        fields: [{ id: 'email', label: 'Email', type: 'email', required: true, consent: false }],
      },
    ];

    const working = cloneEditorWorkingScene(source);
    expect(working.portableSource).toBe(source.portableSource);
    expect(working.portableAssets).toBe(source.portableAssets);
    expect(working.portableSidecars).toBe(source.portableSidecars);
    expect(working.steps).not.toBe(source.steps);
    expect(working.steps[0]!.cursor.path).not.toBe(source.steps[0]!.cursor.path);
    expect(working.steps[0]!.ctas[0]!.fields).not.toBe(source.steps[0]!.ctas[0]!.fields);
    expect(working.translations?.['pt-PT']?.steps).not.toBe(source.translations['pt-PT']!.steps);

    working.tags.push('Changed');
    working.steps[0]!.cursor.path![0]!.x = 0.1;
    working.steps[0]!.annotations[0]!.text = 'Changed annotation';
    working.steps[0]!.ctas[0]!.fields![0]!.label = 'Work email';
    working.translations!['pt-PT']!.steps[source.steps[0]!.id]!.caption = 'Changed caption';

    expect(source.tags).not.toContain('Changed');
    expect(source.steps[0]!.cursor.path![0]!.x).not.toBe(0.1);
    expect(source.steps[0]!.annotations[0]!.text).not.toBe('Changed annotation');
    expect(source.steps[0]!.ctas[0]!.fields![0]!.label).toBe('Email');
    expect(source.translations['pt-PT']!.steps[source.steps[0]!.id]!.caption).toBe('Legenda');
  });

  it('reorders steps without mutating the source array', () => {
    const source = cloneScene(demoScene).steps;
    const firstId = source[0]!.id;
    const moved = moveStep(source, 0, 2);
    expect(moved[2]!.id).toBe(firstId);
    expect(source[0]!.id).toBe(firstId);
  });

  it('duplicates nested presentation objects with new ids', () => {
    const source = cloneScene(demoScene).steps;
    const duplicated = duplicateStep(source, 0, (id) => `new-${id}`);
    expect(duplicated).toHaveLength(source.length + 1);
    expect(duplicated[1]!.id).toBe(`new-${source[0]!.id}`);
    expect(duplicated[1]!.annotations[0]!.id).toBe(`new-${source[0]!.annotations[0]!.id}`);
    duplicated[1]!.title = 'Changed copy';
    expect(source[0]!.title).not.toBe('Changed copy');
  });

  it('never deletes the final step', () => {
    const only = [cloneScene(demoScene).steps[0]!];
    expect(removeStep(only, 0)).toHaveLength(1);
    expect(removeStep(cloneScene(demoScene).steps, 1)).toHaveLength(demoScene.steps.length - 1);
  });

  it('normalizes canvas coordinates', () => {
    expect(normalizedPoint(-0.2)).toBe(0);
    expect(normalizedPoint(0.45)).toBe(0.45);
    expect(normalizedPoint(1.4)).toBe(1);
  });

  it('keeps moved and resized annotation and mask geometry inside normalized bounds', () => {
    const mask = {
      id: 'mask',
      mode: 'blur' as const,
      source: 'manual' as const,
      scope: 'both' as const,
      classification: 'custom' as const,
      locator: '[data-presentation]',
      x: 0.8,
      y: 0.82,
      width: 0.18,
      height: 0.16,
    };
    expect(moveMask(mask, 0.5, 0.5).x).toBeCloseTo(0.82);
    expect(moveMask(mask, 0.5, 0.5).y).toBeCloseTo(0.84);
    expect(resizeMask(mask, 0.5, 0.5).width).toBeCloseTo(0.2);
    expect(resizeMask(mask, 0.5, 0.5).height).toBeCloseTo(0.18);
    expect(resizeMask(mask, -1, -1)).toMatchObject({ width: 0.01, height: 0.01 });
    expect(moveMask(mask, 0.1, 0.1)).toMatchObject({
      mode: 'blur',
      source: 'manual',
      scope: 'both',
      classification: 'custom',
      locator: '[data-presentation]',
    });

    const callout = {
      id: 'callout',
      kind: 'callout' as const,
      x: 0.86,
      y: 0.85,
      width: 0.24,
      height: 0.2,
      text: 'Bounded',
    };
    expect(moveAnnotation(callout, 0.5, 0.5)).toMatchObject({ x: 0.88, y: 0.9 });
    expect(resizeAnnotation(callout, 0.5, 0.5)).toMatchObject({ width: 0.74, height: 0.7 });

    const arrow = {
      id: 'arrow',
      kind: 'arrow' as const,
      fromX: 0.7,
      fromY: 0.7,
      x: 0.9,
      y: 0.9,
      text: 'Bounded arrow',
    };
    const movedArrow = moveAnnotation(arrow, 0.4, 0.4);
    expect(movedArrow.fromX).toBeCloseTo(0.8);
    expect(movedArrow.fromY).toBeCloseTo(0.8);
    expect(movedArrow).toMatchObject({ x: 1, y: 1 });
    expect(resizeAnnotation(arrow, 0.4, -2)).toMatchObject({ x: 1, y: 0 });
  });

  it('compiles presentation state into the portable viewer model', () => {
    const source = cloneScene(demoScene);
    source.steps[0]!.crop = { x: 0.78, y: 0.31, zoom: 2.4 };
    source.steps[0]!.frame = 'mobile';
    source.steps[0]!.cursor = { x: 0.81, y: 0.36, visible: true, click: true };
    const player = toPlayerScene(source);
    expect(player.id).toBe(demoScene.id);
    expect(player.steps[0]!.hotspot?.label).toBe('Choose Invite member');
    expect(player.steps[0]).toMatchObject({
      crop: { x: 0.78, y: 0.31, zoom: 2.4 },
      frame: 'mobile',
      cursor: { x: 0.81, y: 0.36, visible: true, click: true },
    });
    expect(player.steps[2]!.choices?.[0]).toMatchObject({
      sceneId: 'invite-member-access',
      href: '/scenes/invite-member-access',
    });
  });

  it('keeps bundled demonstrations synthetic and outside verification or publication counts', () => {
    expect(demoScene.sample).toBe(true);
    expect(demoScene.verified).toBeUndefined();
    expect(catalogScenes.length).toBeGreaterThan(0);
    expect(
      catalogScenes.every(
        (scene) => scene.sample && scene.status === 'stale' && scene.published === false,
      ),
    ).toBe(true);
  });
});
