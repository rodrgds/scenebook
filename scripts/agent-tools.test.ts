import { describe, expect, test } from 'vitest';

import { groupPaths, recommendedChecks, uiTargets, workspaceTarget } from './agent-tools';

describe('agent workflow helpers', () => {
  test('groups changed paths by the repository owner', () => {
    expect([
      ...groupPaths(['apps/studio/src/routes/+page.svelte', 'packages/viewer/src/player.ts']),
    ]).toEqual([
      ['Studio', 1],
      ['Viewer', 1],
    ]);
  });

  test('selects existing UI source files and ignores docs and deleted paths', () => {
    expect(
      uiTargets([
        'apps/studio/src/app.css',
        'apps/studio/tests/components.test.ts',
        'docs/studio.md',
        'apps/studio/src/does-not-exist.svelte',
      ]),
    ).toEqual(['apps/studio/src/app.css']);
  });

  test('recommends the recurring gates implied by changed areas', () => {
    const checks = recommendedChecks([
      'apps/studio/src/app.css',
      'packages/server/src/app.ts',
      'examples/acme-product/scene.yaml',
    ]);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.stringContaining('bun run check:ui'),
        expect.stringContaining('Changeset'),
        expect.stringContaining('PostgreSQL/MinIO'),
        expect.stringContaining('bun run example:test'),
      ]),
    );
  });

  test('keeps explicit UI targets inside the workspace', () => {
    expect(workspaceTarget('apps/studio/src')).toBe('apps/studio/src');
    expect(() => workspaceTarget('../outside')).toThrow('must stay inside');
  });
});
