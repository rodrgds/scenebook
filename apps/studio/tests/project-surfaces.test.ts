import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STUDIO_PRIVACY,
  effectiveLocalProject,
  freshnessLabel,
  readStudioPrivacyDefaults,
  summarizeChannelCoverage,
  summarizeVersionChange,
  summarizeWorkspaceMetrics,
  uniqueProjectId,
  writeStudioPrivacyDefaults,
} from '../src/lib/project-surfaces';
import type { SceneSummary, SceneVersionSummary } from '../src/lib/scene-library';

function summary(id: string, overrides: Partial<SceneSummary> = {}): SceneSummary {
  return {
    id,
    title: id,
    description: '',
    stepCount: 3,
    savedAt: Date.parse('2026-07-20T10:00:00.000Z'),
    revision: 2,
    tags: [],
    publicationStatus: 'draft',
    audiences: [],
    capability: 'captured',
    runStatus: 'stale',
    evidenceRuns: [],
    automationLevel: 'none',
    checkCount: 0,
    translationCount: 0,
    screenStepCount: 2,
    screenAssetCount: 2,
    opaqueMaskCount: 0,
    hiddenStepCount: 0,
    sample: false,
    ...overrides,
  };
}

function version(
  revision: number,
  overrides: Partial<SceneVersionSummary> = {},
): SceneVersionSummary {
  return {
    id: 'checkout',
    revision,
    savedAt: Date.parse('2026-07-20T10:00:00.000Z') - revision,
    title: 'Checkout',
    stepCount: 3,
    translationCount: 0,
    hasPortableSource: true,
    verification: null,
    runRevisions: [],
    theme: { accent: '#b83b24', paper: '#fff', ink: '#111', radius: 10, frame: 'dark' },
    steps: [{ id: 'start', title: 'Start', type: 'screen' }],
    ...overrides,
  };
}

describe('local Project surfaces', () => {
  it('derives an honest default Project and keeps Studio privacy metadata portable', () => {
    const scenes = [summary('checkout'), summary('receipt')];
    const project = effectiveLocalProject(null, scenes);

    expect(project.collections[0]?.entries.map((entry) => entry.sceneId)).toEqual([
      'checkout',
      'receipt',
    ]);
    expect(readStudioPrivacyDefaults(project)).toEqual(DEFAULT_STUDIO_PRIVACY);

    const updated = writeStudioPrivacyDefaults(project, {
      blockAt: 'medium',
      scanBeforeExport: true,
      ocrBeforePublication: false,
    });
    expect(readStudioPrivacyDefaults(updated)).toEqual({
      blockAt: 'medium',
      scanBeforeExport: true,
      ocrBeforePublication: false,
    });

    updated.metadata.scenebookStudioPrivacy = {
      blockAt: 'invalid',
      scanBeforeExport: 'yes',
    };
    expect(readStudioPrivacyDefaults(updated)).toEqual(DEFAULT_STUDIO_PRIVACY);
  });

  it('updates privacy metadata without cloning a reactive Project proxy', () => {
    const project = effectiveLocalProject(null, [summary('checkout')]);
    const reactive = new Proxy(project, {});
    expect(() => structuredClone(reactive)).toThrow();

    const updated = writeStudioPrivacyDefaults(reactive, {
      blockAt: 'blocking',
      scanBeforeExport: false,
      ocrBeforePublication: true,
    });
    expect(readStudioPrivacyDefaults(updated)).toEqual({
      blockAt: 'blocking',
      scanBeforeExport: false,
      ocrBeforePublication: true,
    });
    expect(project.metadata).not.toHaveProperty('scenebookStudioPrivacy');
  });

  it('summarizes actual retained revision fields without inventing a diff', () => {
    const current = version(2, {
      stepCount: 4,
      translationCount: 1,
      verification: 'changed',
      steps: [
        { id: 'start', title: 'Begin', type: 'screen' },
        { id: 'finish', title: 'Finish', type: 'end' },
      ],
    });
    const previous = version(1);
    const change = summarizeVersionChange(summary('checkout'), [current, previous]);

    expect(change.changedFields).toEqual([
      'Step count',
      'translations',
      'Run evidence',
      'Step structure',
    ]);
    expect(summarizeVersionChange(summary('checkout'), [current]).changedFields).toEqual([]);
  });

  it('keeps local Channel preflight separate from external approvals and compilation', () => {
    const scenes = [
      summary('checkout', {
        runStatus: 'passed',
        verification: {
          status: 'passed',
          at: '2026-07-20T10:00:00.000Z',
          commit: 'abc123',
        },
      }),
      summary('receipt', { runStatus: 'changed' }),
    ];
    const project = effectiveLocalProject(null, scenes);
    project.channels.push({
      id: 'docs',
      name: 'Docs',
      slug: 'docs',
      kind: 'static',
      collectionIds: ['all-scenes'],
      policy: {
        requireCriticalPassing: true,
        requireVisualApproval: true,
        requireEditorialApproval: true,
        requireCompleteLocalization: false,
        publication: 'manual',
        nonCriticalFailure: 'block',
      },
      public: {},
    });

    const [coverage] = summarizeChannelCoverage(project, scenes);
    expect(coverage?.sceneIds).toEqual(['checkout', 'receipt']);
    expect(coverage?.passedSceneCount).toBe(1);
    expect(coverage?.releaseBlockers).toContain('1 Scene lack a passed attached Run');
    expect(coverage?.handoffChecks).toContain('Visual approval is evaluated by the CLI or Console');
    expect(coverage?.handoffChecks.at(-1)).toBe(
      'Privacy scanning and compilation run outside browser Studio',
    );
  });

  it('computes coverage and freshness from local truth only', () => {
    const scenes = [
      summary('checkout', {
        capability: 'verified',
        automationLevel: 'verified',
        runStatus: 'passed',
        translationCount: 2,
        verification: { status: 'passed', at: '2026-07-15T00:00:00.000Z' },
      }),
      summary('receipt', { screenAssetCount: 1 }),
    ];
    const project = effectiveLocalProject(null, scenes);
    project.channels.push({
      id: 'docs',
      name: 'Docs',
      slug: 'docs',
      kind: 'static',
      collectionIds: ['all-scenes'],
      policy: {
        requireCriticalPassing: false,
        requireVisualApproval: false,
        requireEditorialApproval: false,
        requireCompleteLocalization: false,
        publication: 'manual',
        nonCriticalFailure: 'block',
      },
      public: {},
    });

    expect(summarizeWorkspaceMetrics(project, scenes)).toMatchObject({
      sceneCount: 2,
      passedCount: 1,
      monitoredCount: 1,
      verifiedSourceCount: 1,
      collectionSceneCount: 2,
      channelSceneCount: 2,
      screenStepCount: 4,
      screenAssetCount: 3,
      translationCount: 2,
    });
    expect(freshnessLabel(scenes[0]!, Date.parse('2026-07-20T00:00:00.000Z'))).toEqual({
      label: 'fresh',
      ageDays: 5,
    });
    expect(freshnessLabel(scenes[1]!, Date.parse('2026-07-20T00:00:00.000Z'))).toEqual({
      label: 'no evidence',
      ageDays: null,
    });
  });

  it('creates deterministic collision-free IDs for local curation', () => {
    expect(uniqueProjectId('Release Notes', new Set(['release-notes', 'release-notes-2']))).toBe(
      'release-notes-3',
    );
  });
});
