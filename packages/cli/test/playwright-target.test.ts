import { describe, expect, it } from 'vitest';
import { ProjectSchema, SCHEMA_VERSION, ScenebookConfigSchema } from '@scenebook/schema';

import { playwrightTargetEnvironment, resolvePlaywrightTarget } from '../src/playwright-target.js';
import type { LoadedConfig } from '../src/types.js';

function loaded(
  options: {
    readonly forbidProductionMutations?: boolean;
    readonly targetIds?: readonly string[];
    readonly disabledTargetIds?: readonly string[];
    readonly localMutations?: boolean;
    readonly customMutations?: boolean;
    readonly productionMutations?: boolean;
    readonly productionUrl?: string;
  } = {},
): LoadedConfig {
  const targetIds = options.targetIds ?? ['local-target'];
  const environments = [
    {
      id: 'local',
      name: 'Local',
      kind: 'local' as const,
      baseUrl: 'http://127.0.0.1:4174',
      allowMutations: options.localMutations ?? true,
    },
    {
      id: 'custom',
      name: 'Custom',
      kind: 'custom' as const,
      baseUrl: 'https://custom.example.test/app',
      allowMutations: options.customMutations ?? true,
    },
    {
      id: 'production',
      name: 'Production',
      kind: 'production' as const,
      baseUrl: options.productionUrl ?? 'https://product.example.test',
      allowMutations: options.productionMutations ?? true,
    },
  ];
  const environmentFor = (id: string) => id.replace(/-target$/u, '');
  const project = ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'target-project',
    name: 'Target project',
    slug: 'target-project',
    environments,
    productVariants: [{ id: 'admin', name: 'Admin' }],
    captureProfiles: [
      {
        id: 'desktop',
        name: 'Desktop',
        viewport: { width: 1280, height: 720 },
      },
    ],
    runTargets: targetIds.map((id) => ({
      id,
      name: id,
      environmentId: environmentFor(id),
      productVariantId: 'admin',
      captureProfileId: 'desktop',
      enabled: !(options.disabledTargetIds ?? []).includes(id),
    })),
  });
  return {
    path: '/project/scenebook.config.ts',
    directory: '/project',
    config: ScenebookConfigSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      project,
      playwright: {
        forbidProductionMutations: options.forbidProductionMutations ?? true,
      },
    }),
    project,
  };
}

describe('Playwright Run Target preflight', () => {
  it('infers the sole enabled local target and emits authoritative child bindings', () => {
    const config = loaded();
    const selection = resolvePlaywrightTarget(config);
    expect(selection).toMatchObject({
      target: { id: 'local-target' },
      environment: { id: 'local', kind: 'local' },
      baseUrl: 'http://127.0.0.1:4174/',
    });
    expect(
      playwrightTargetEnvironment(config, selection, {
        SCENEBOOK_RUN_TARGET_ID: 'attacker',
        SCENEBOOK_BASE_URL: 'https://attacker.invalid',
      }),
    ).toMatchObject({
      SCENEBOOK_PROJECT_ID: 'target-project',
      SCENEBOOK_RUN_TARGET_ID: 'local-target',
      SCENEBOOK_ENVIRONMENT_ID: 'local',
      SCENEBOOK_ENVIRONMENT_KIND: 'local',
      SCENEBOOK_BASE_URL: 'http://127.0.0.1:4174/',
      SCENEBOOK_PRODUCT_VARIANT_ID: 'admin',
      SCENEBOOK_CAPTURE_PROFILE_ID: 'desktop',
      SCENEBOOK_MUTATIONS_ALLOWED: '1',
    });
  });

  it('requires explicit selection when enabled targets are ambiguous', () => {
    const config = loaded({ targetIds: ['local-target', 'custom-target'] });
    expect(() => resolvePlaywrightTarget(config)).toThrow('selection is ambiguous');
    expect(resolvePlaywrightTarget(config, 'custom-target')).toMatchObject({
      target: { id: 'custom-target' },
      environment: { id: 'custom', kind: 'custom' },
    });
  });

  it('rejects unknown and disabled targets', () => {
    const config = loaded({
      targetIds: ['local-target', 'custom-target'],
      disabledTargetIds: ['custom-target'],
    });
    expect(() => resolvePlaywrightTarget(config, 'missing')).toThrow('Unknown Run Target missing');
    expect(() => resolvePlaywrightTarget(config, 'custom-target')).toThrow(
      'Run Target custom-target is disabled',
    );
  });

  it('enforces local/custom mutation permission and production policy', () => {
    expect(() =>
      resolvePlaywrightTarget(loaded({ localMutations: false }), 'local-target'),
    ).toThrow('does not allow mutations');
    expect(() =>
      resolvePlaywrightTarget(
        loaded({ targetIds: ['custom-target'], customMutations: false }),
        'custom-target',
      ),
    ).toThrow('does not allow mutations');
    expect(() =>
      resolvePlaywrightTarget(loaded({ targetIds: ['production-target'] }), 'production-target'),
    ).toThrow('forbidProductionMutations is enabled');

    const allowed = loaded({
      targetIds: ['production-target'],
      forbidProductionMutations: false,
    });
    expect(resolvePlaywrightTarget(allowed, 'production-target').environment.kind).toBe(
      'production',
    );
    expect(() =>
      resolvePlaywrightTarget(
        loaded({
          targetIds: ['production-target'],
          forbidProductionMutations: false,
          productionUrl: 'http://product.example.test',
        }),
        'production-target',
      ),
    ).toThrow('must use an HTTPS baseUrl');
  });
});
