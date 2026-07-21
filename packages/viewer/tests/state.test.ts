import { describe, expect, it } from 'vitest';

import { findStepIndex, resolveChoice, snapshot, validateScene } from '../src/state.js';
import type { SceneDefinition } from '../src/types.js';

const scene: SceneDefinition = {
  version: 1,
  id: 'invite-member',
  title: 'Invite a teammate',
  steps: [
    { id: 'open', title: 'Open the form' },
    {
      id: 'path',
      type: 'choice',
      title: 'Choose access',
      choices: [
        { id: 'admin', label: 'Administrator', sceneId: 'admin-path', href: '/admin-path' },
      ],
    },
    { id: 'done', type: 'end', title: 'Invitation sent' },
  ],
};

describe('viewer state', () => {
  it('resolves numeric and stable-id deep links', () => {
    expect(findStepIndex(scene, 'path')).toBe(1);
    expect(findStepIndex(scene, '20')).toBe(2);
    expect(findStepIndex(scene, -4)).toBe(0);
  });

  it('describes progress and prevents skipping a choice', () => {
    expect(snapshot(scene, 1)).toMatchObject({
      index: 1,
      progress: 2 / 3,
      canGoBack: true,
      canGoForward: false,
    });
    expect(snapshot(scene, 2).complete).toBe(true);
  });

  it('resolves constrained choice destinations', () => {
    const adminPath: SceneDefinition = {
      version: 1,
      id: 'admin-path',
      title: 'Administrator path',
      steps: [{ id: 'done', type: 'end', title: 'Invitation sent' }],
    };
    expect(resolveChoice(scene.steps[1]!.choices![0]!, { 'admin-path': adminPath })).toEqual({
      scene: adminPath,
      stepIndex: 0,
    });
  });

  it('reports malformed scenes before rendering', () => {
    const malformed = structuredClone(scene);
    malformed.steps[1]!.choices![0]!.sceneId = malformed.id;
    expect(validateScene(malformed)).toContain(
      'Choice admin creates a loop back to Scene invite-member.',
    );
  });

  it('reports structurally malformed runtime data without throwing', () => {
    const malformed = { version: 1, id: 'broken', title: 'Broken', steps: null };
    expect(() => validateScene(malformed as unknown as SceneDefinition)).not.toThrow();
    expect(validateScene(malformed as unknown as SceneDefinition)).toContain(
      'Scene steps must be an array.',
    );
  });

  it('rejects loops across registered linear scenes', () => {
    const first = structuredClone(scene);
    const second: SceneDefinition = {
      version: 1,
      id: 'admin-path',
      title: 'Administrator path',
      steps: [
        {
          id: 'back',
          type: 'choice',
          title: 'Return path',
          choices: [{ id: 'return', label: 'Return', sceneId: first.id, href: '/invite-member' }],
        },
      ],
    };
    expect(validateScene(first, { [second.id]: second })).toContain(
      'Scene choices contain a loop: invite-member → admin-path → invite-member.',
    );
  });
});
