import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SceneSchema } from '@scenebook/schema';

import { normalizeScene } from '../src/normalize.js';
import { renderPresentation } from '../src/presentation.js';
import type { SceneAdapterContext } from '../src/types.js';

describe('compiled presentation cards', () => {
  it('keeps image-free choice copy and options inside a fixed dark frame', async () => {
    const source = SceneSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id: 'responsive-choice-card',
      slug: 'responsive-choice-card',
      title: 'Responsive choice card',
      steps: [
        {
          id: 'choose-access',
          kind: 'choice',
          title: 'What access should this teammate-with-an-unusually-long-name receive?',
          instruction: 'Choose the least-privileged role that still lets them complete their work.',
          choices: [
            {
              id: 'member',
              label: 'Member access with a deliberately long label',
              description: 'Work in projects without changing workspace settings.',
              targetSceneId: 'member-path',
            },
            {
              id: 'administrator',
              label: 'Administrator access',
              description: 'Manage people and workspace settings.',
              targetSceneId: 'administrator-path',
            },
          ],
        },
      ],
    });
    const scene = normalizeScene(source);
    const rendered = await renderPresentation(
      { scene } as SceneAdapterContext,
      scene.steps[0]!,
      'motion',
    );
    const metadata = await sharp(rendered.buffer).metadata();
    const statistics = await sharp(rendered.buffer).stats();

    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(720);
    expect(statistics.channels.slice(0, 3).every((channel) => channel.mean < 120)).toBe(true);
  });
});
