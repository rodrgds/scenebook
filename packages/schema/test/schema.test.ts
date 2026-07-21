import { describe, expect, it } from 'vitest';

import {
  BaselineSchema,
  canonicalStepCtas,
  CompilerPublicationManifestSchema,
  IdSchema,
  legacyStepCtaId,
  PublicationInventorySchema,
  ProjectSchema,
  ReleasePublicationSchema,
  ReleaseSchema,
  ReviewSchema,
  RunArtifactSchema,
  SceneSchema,
  UnsupportedSchemaVersionError,
  parseSceneYaml,
  serializeSceneYaml,
} from '../src/index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = '2026-07-20T12:00:00.000Z';

const PUBLICATION_MANIFEST_FILE = {
  path: 'manifest.json',
  sha256: HASH_A,
  byteLength: 100,
  mediaType: 'application/json',
} as const;

const PUBLICATION_OUTPUT_FILE = {
  path: 'scenes/invite-member/index.html',
  sha256: HASH_B,
  byteLength: 200,
  mediaType: 'text/html',
} as const;

function publicationInventory() {
  return {
    format: 'scenebook-publication-archive',
    version: 1,
    archive: { sha256: HASH_A, byteLength: 250, mediaType: 'application/zip' },
    treeHash: HASH_B,
    byteLength: 300,
    compilerManifest: PUBLICATION_MANIFEST_FILE,
    files: [PUBLICATION_MANIFEST_FILE, PUBLICATION_OUTPUT_FILE],
  } as const;
}

function privacy(status: 'clear' | 'unknown' = 'clear') {
  return {
    status,
    scannedAt: NOW,
    scannerVersion: '1.0.0',
    counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
    findings: [],
  } as const;
}

function asset(hash = HASH_A) {
  return {
    sha256: hash,
    path: `assets/${hash}.webp`,
    mediaType: 'image/webp',
    byteLength: 42,
    role: 'screenshot' as const,
    width: 1280,
    height: 720,
  };
}

function sceneInput() {
  return {
    schemaVersion: 1,
    id: 'invite-member',
    title: 'Invite a teammate',
    slug: 'invite-a-teammate',
    steps: [
      {
        id: 'open-form',
        title: 'Open invitation form',
        states: {
          before: {
            id: 'open-form-before',
            route: '/settings/members',
            screenshot: asset(),
            viewport: { width: 1280, height: 720 },
          },
        },
        target: {
          role: 'button',
          accessibleName: 'Invite member',
          normalizedRect: { x: 0.7, y: 0.2, width: 0.2, height: 0.1 },
        },
      },
    ],
    assets: [asset()],
  };
}

function stateEvidence() {
  return {
    id: 'open-form-before',
    sceneId: 'invite-member',
    stepId: 'open-form',
    phase: 'before' as const,
    capturedAt: NOW,
    route: '/settings/members',
    viewport: { width: 1280, height: 720 },
    screenshot: asset(),
    screenshotHash: HASH_A,
    privacy: privacy(),
  };
}

describe('hosted publication integrity schemas', () => {
  it('accepts a bounded deterministic inventory and exact object binding', () => {
    expect(PublicationInventorySchema.parse(publicationInventory())).toEqual(
      publicationInventory(),
    );
    expect(
      ReleasePublicationSchema.parse({
        archive: publicationInventory().archive,
        inventory: { sha256: HASH_B, byteLength: 500, mediaType: 'application/json' },
        compilerManifest: {
          sha256: HASH_A,
          byteLength: 100,
          mediaType: 'application/json',
        },
        treeHash: HASH_B,
      }),
    ).toBeDefined();
  });

  it('rejects reordered, duplicate, mis-sized, and misidentified inventory members', () => {
    expect(
      PublicationInventorySchema.safeParse({
        ...publicationInventory(),
        files: [PUBLICATION_OUTPUT_FILE, PUBLICATION_MANIFEST_FILE],
      }).success,
    ).toBe(false);
    expect(
      PublicationInventorySchema.safeParse({
        ...publicationInventory(),
        files: [PUBLICATION_MANIFEST_FILE, PUBLICATION_MANIFEST_FILE],
        byteLength: 200,
      }).success,
    ).toBe(false);
    expect(
      PublicationInventorySchema.safeParse({ ...publicationInventory(), byteLength: 301 }).success,
    ).toBe(false);
    expect(
      PublicationInventorySchema.safeParse({
        ...publicationInventory(),
        compilerManifest: { ...PUBLICATION_MANIFEST_FILE, sha256: HASH_B },
      }).success,
    ).toBe(false);
  });

  it('types exact compiler Scene revisions and unique output ownership', () => {
    const manifest = {
      format: 'scenebook-catalog',
      version: 1,
      privacy: { status: 'passed', scanner: 'fixture' },
      scenes: [
        {
          id: 'invite-member',
          slug: 'invite-member',
          sourceHash: HASH_A,
          locale: 'en',
          evidence: 'scenes/invite-member/evidence.json',
          outputs: { catalog: ['scenes/invite-member/index.html'] },
        },
      ],
    };
    expect(CompilerPublicationManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      CompilerPublicationManifestSchema.safeParse({
        ...manifest,
        privacy: { status: 'overridden', scanner: 'fixture' },
      }).success,
    ).toBe(false);
    expect(
      CompilerPublicationManifestSchema.safeParse({
        ...manifest,
        scenes: [
          manifest.scenes[0],
          {
            ...manifest.scenes[0],
            id: 'invite-reviewer',
            slug: 'invite-member',
            evidence: manifest.scenes[0]!.evidence,
            outputs: { catalog: ['scenes/invite-reviewer/index.html'] },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      CompilerPublicationManifestSchema.safeParse({
        ...manifest,
        scenes: [
          {
            ...manifest.scenes[0],
            evidence: 'scenes/another-scene/evidence.json',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      CompilerPublicationManifestSchema.safeParse({
        ...manifest,
        scenes: [manifest.scenes[0], { ...manifest.scenes[0] }],
      }).success,
    ).toBe(false);
    expect(
      CompilerPublicationManifestSchema.safeParse({
        ...manifest,
        scenes: [
          { ...manifest.scenes[0], outputs: { invented: ['scenes/invite-member/index.html'] } },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('portable Scene schema', () => {
  it('round-trips canonical YAML and applies safe defaults', () => {
    const scene = SceneSchema.parse(sceneInput());
    const serialized = serializeSceneYaml(scene);
    const reparsed = parseSceneYaml(serialized);

    expect(reparsed).toEqual(scene);
    expect(reparsed.capability).toBe('captured');
    expect(reparsed.steps[0]?.presentation.durationMs).toBe(3_000);
    expect(serializeSceneYaml(reparsed)).toBe(serialized);
  });

  it('round-trips canonical multiple CTAs and inline translations while accepting legacy CTA input', () => {
    const original = sceneInput().steps[0]!;
    const scene = SceneSchema.parse({
      ...sceneInput(),
      translations: {
        'pt-PT': {
          title: 'Convidar colega',
          steps: {
            'open-form': {
              instruction: 'Escolha Convidar membro.',
              altText: 'Formulário de convite.',
              ctas: {
                'request-access': {
                  label: 'Pedir acesso',
                  fields: { email: { label: 'Email de trabalho' } },
                },
              },
            },
          },
        },
      },
      steps: [
        {
          ...original,
          ctas: [
            {
              id: 'request-access',
              variant: 'primary',
              kind: 'form',
              label: 'Request access',
              fields: [{ id: 'email', label: 'Work email', type: 'email', required: true }],
            },
            { id: 'restart', variant: 'secondary', kind: 'restart', label: 'Start over' },
          ],
          cta: {
            kind: 'external',
            label: 'Deprecated fallback',
            url: 'https://legacy.example.test',
          },
        },
      ],
    });
    expect(parseSceneYaml(serializeSceneYaml(scene))).toEqual(scene);
    expect(scene.steps[0]!.ctas.map((cta) => cta.id)).toEqual(['request-access', 'restart']);
    expect(canonicalStepCtas(scene.steps[0]!).map((cta) => cta.id)).toEqual([
      'request-access',
      'restart',
    ]);
    expect(scene.translations['pt-PT']!.steps['open-form']!.altText).toBe('Formulário de convite.');

    const legacyScene = SceneSchema.parse({
      ...sceneInput(),
      steps: [
        {
          ...original,
          cta: { kind: 'external', label: 'Read docs', url: 'https://docs.example.test' },
        },
      ],
    });
    expect(canonicalStepCtas(legacyScene.steps[0]!).map((cta) => cta.id)).toEqual([
      'open-form-cta',
    ]);

    const maximalStepId = `s${'a'.repeat(127)}`;
    const fallbackId = legacyStepCtaId(maximalStepId);
    expect(fallbackId).toHaveLength(128);
    expect(IdSchema.parse(fallbackId)).toBe(fallbackId);
  });

  it('rejects duplicate CTA IDs and dangling inline translation bindings', () => {
    const original = sceneInput().steps[0]!;
    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        steps: [
          {
            ...original,
            ctas: [
              { id: 'continue', kind: 'restart', label: 'Again' },
              { id: 'continue', kind: 'restart', label: 'Once more' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        translations: { 'pt-PT': { steps: { missing: { title: 'Não existe' } } } },
      }).success,
    ).toBe(false);
    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        translations: {
          'pt-PT': {
            steps: {
              'open-form': {
                ctas: { missing: { label: 'Não existe' } },
              },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('migrates the legacy version/name shape deterministically', () => {
    const migrated = parseSceneYaml(`
version: 0
name: Welcome flow
steps:
  - caption: Welcome to the product
`);

    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.id).toBe('welcome-flow');
    expect(migrated.slug).toBe('welcome-flow');
    expect(migrated.steps[0]).toMatchObject({
      id: 'step-01',
      kind: 'explanation',
      title: 'Welcome to the product',
    });
  });

  it('rejects future schemas and ambiguous YAML aliases', () => {
    expect(() => parseSceneYaml('schemaVersion: 99\nid: future')).toThrow(
      UnsupportedSchemaVersionError,
    );
    expect(() =>
      parseSceneYaml(`
version: 0
name: Alias
steps: &steps
  - caption: One
copy: *steps
`),
    ).toThrow();
  });

  it('enforces stable IDs, capability truth, and irreversible automatic masks', () => {
    const duplicate = sceneInput();
    duplicate.steps.push({ ...duplicate.steps[0]!, title: 'Duplicate' });
    expect(SceneSchema.safeParse(duplicate).success).toBe(false);

    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        capability: 'verified',
        automation: { level: 'none' },
      }).success,
    ).toBe(false);

    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        capability: 'captured',
        automation: { level: 'monitored', framework: 'playwright' },
      }).success,
    ).toBe(false);

    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        steps: [
          {
            ...sceneInput().steps[0],
            masks: [
              {
                id: 'secret-mask',
                source: 'automatic',
                mode: 'blur',
                rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        steps: [
          {
            ...sceneInput().steps[0],
            masks: [
              {
                id: 'locator-blur',
                source: 'locator',
                mode: 'blur',
                classification: 'custom',
                rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        steps: [
          {
            ...sceneInput().steps[0],
            masks: [
              {
                id: 'presentation-blur',
                source: 'manual',
                mode: 'blur',
                classification: 'custom',
                rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
              },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects ambiguous nested IDs, unsafe CTA schemes, and raw fixture values', () => {
    const original = sceneInput().steps[0]!;
    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        steps: [
          {
            ...original,
            actions: [
              {
                id: 'fill-email',
                kind: 'fill',
                target: original.target,
                value: {
                  kind: 'fixture',
                  name: 'invitee-email',
                  value: 'private@example.test',
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        steps: [
          {
            ...original,
            cta: { kind: 'external', label: 'Continue', url: 'javascript:alert(1)' },
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      SceneSchema.safeParse({
        ...sceneInput(),
        steps: [
          {
            ...original,
            checks: [
              { id: 'visible', kind: 'visible', description: 'First' },
              { id: 'visible', kind: 'visible', description: 'Second' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('project and immutable evidence schemas', () => {
  it('rejects dangling Run Target references', () => {
    const result = ProjectSchema.safeParse({
      schemaVersion: 1,
      id: 'acme',
      name: 'Acme',
      slug: 'acme',
      runTargets: [
        {
          id: 'primary',
          name: 'Primary',
          environmentId: 'missing',
          productVariantId: 'default',
          captureProfileId: 'desktop',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('keeps Channel and Collection selectors unambiguous while allowing ordered Scene reuse', () => {
    const collection = {
      id: 'start-here',
      title: 'Start here',
      slug: 'start-here',
      entries: [
        { id: 'first', sceneId: 'welcome' },
        { id: 'repeat', sceneId: 'welcome' },
      ],
    };
    const valid = ProjectSchema.safeParse({
      schemaVersion: 1,
      id: 'acme',
      name: 'Acme',
      slug: 'acme',
      collections: [collection],
      channels: [
        {
          id: 'docs',
          name: 'Documentation',
          slug: 'docs',
          description: 'Customer-facing guidance.',
          kind: 'public-catalog',
          collectionIds: ['start-here'],
        },
      ],
    });
    expect(valid.success).toBe(true);
    if (!valid.success) throw new Error('Expected a valid publication project fixture.');

    expect(
      ProjectSchema.safeParse({
        ...valid.data,
        collections: [collection, { ...collection, id: 'other' }],
      }).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse({
        schemaVersion: 1,
        id: 'acme',
        name: 'Acme',
        slug: 'acme',
        public: {
          analytics: {
            endpoint:
              'http://api.example.test/v1/public/workspaces/acme/projects/product/channels/public/analytics',
            tokenEnv: 'TRACKING_TOKEN',
            releaseId: 'release-1',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse({
        schemaVersion: 1,
        id: 'acme',
        name: 'Acme',
        slug: 'acme',
        public: {
          analytics: {
            endpoint:
              'http://127.0.0.1:4100/v1/public/workspaces/acme/projects/product/channels/public/analytics',
            tokenEnv: 'TRACKING_TOKEN',
            releaseId: 'release-1',
          },
        },
      }).success,
    ).toBe(true);
    expect(
      ProjectSchema.safeParse({
        ...valid.data,
        channels: [{ ...valid.data.channels[0], collectionIds: ['start-here', 'start-here'] }],
      }).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse({
        ...valid.data,
        channels: [valid.data.channels[0], { ...valid.data.channels[0], id: 'other-docs' }],
      }).success,
    ).toBe(false);
  });

  it('types public URLs, SEO, remix, and opt-in analytics without accepting arbitrary sinks', () => {
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'acme',
      name: 'Acme',
      slug: 'acme',
      public: {
        baseUrl: 'https://stories.example.test/product/',
        customDomain: 'stories.example.test',
        seo: { index: false, follow: false },
        attribution: true,
        remix: true,
        cta: {
          endpoint:
            'https://api.example.test/v1/public/workspaces/acme/projects/product/channels/public/cta',
          tokenEnv: 'SCENEBOOK_PUBLIC_CTA_TOKEN',
          releaseId: 'release-1',
        },
      },
      channels: [
        {
          id: 'public',
          name: 'Public stories',
          slug: 'public',
          kind: 'public-catalog',
          public: {
            seo: { index: true, follow: true },
            analytics: {
              endpoint:
                'https://api.example.test/v1/public/workspaces/acme/projects/product/channels/public/analytics',
              tokenEnv: 'SCENEBOOK_PUBLIC_ANALYTICS_TOKEN',
              releaseId: 'release-1',
            },
          },
        },
      ],
    });
    expect(project.public.remix).toBe(true);
    expect(project.public.cta?.tokenEnv).toBe('SCENEBOOK_PUBLIC_CTA_TOKEN');
    expect(project.channels[0]?.public.analytics?.respectDoNotTrack).toBe(true);

    for (const publicConfig of [
      { baseUrl: 'https://user:secret@stories.example.test/' },
      { baseUrl: 'https://stories.example.test/?campaign=private' },
      { baseUrl: 'https://other.example.test/', customDomain: 'stories.example.test' },
    ]) {
      expect(
        ProjectSchema.safeParse({
          schemaVersion: 1,
          id: 'acme',
          name: 'Acme',
          slug: 'acme',
          public: publicConfig,
        }).success,
      ).toBe(false);
    }

    expect(
      ProjectSchema.safeParse({
        schemaVersion: 1,
        id: 'acme',
        name: 'Acme',
        slug: 'acme',
        public: {
          analytics: {
            endpoint: 'https://collector.example.test/events',
            tokenEnv: 'TRACKING_TOKEN',
            releaseId: 'release-1',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse({
        schemaVersion: 1,
        id: 'acme',
        name: 'Acme',
        slug: 'acme',
        public: {
          cta: {
            endpoint: 'https://collector.example.test/forms',
            tokenEnv: 'CTA_TOKEN',
            releaseId: 'release-1',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse({
        schemaVersion: 1,
        id: 'acme',
        name: 'Acme',
        slug: 'acme',
        public: {
          cta: {
            endpoint:
              'http://api.example.test/v1/public/workspaces/acme/projects/product/channels/public/cta',
            tokenEnv: 'CTA_TOKEN',
            releaseId: 'release-1',
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse({
        schemaVersion: 1,
        id: 'acme',
        name: 'Acme',
        slug: 'acme',
        channels: [
          {
            id: 'private',
            name: 'Private portal',
            slug: 'private',
            kind: 'private-portal',
            public: { seo: { index: true } },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires a selected Run attempt whose status agrees with the Run', () => {
    const run = {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'run-1',
      kind: 'run',
      projectId: 'acme',
      sceneId: 'invite-member',
      runTargetId: 'primary',
      createdAt: NOW,
      producer: { name: 'scenebook', version: '0.1.0' },
      repository: { repository: 'acme/product', commit: HASH_A.slice(0, 40) },
      sourceRevision: HASH_A,
      status: 'passed',
      expectedStepIds: ['open-form'],
      attempts: [
        {
          id: 'attempt-1',
          index: 0,
          status: 'passed',
          startedAt: NOW,
          endedAt: NOW,
          durationMs: 1,
          states: [stateEvidence()],
          privacy: privacy(),
        },
      ],
      selectedAttemptId: 'missing',
      startedAt: NOW,
      endedAt: NOW,
      durationMs: 1,
      privacy: privacy(),
    };
    expect(RunArtifactSchema.safeParse(run).success).toBe(false);
    expect(RunArtifactSchema.safeParse({ ...run, selectedAttemptId: 'attempt-1' }).success).toBe(
      true,
    );
    expect(
      RunArtifactSchema.safeParse({
        ...run,
        selectedAttemptId: 'attempt-1',
        attempts: [
          {
            ...run.attempts[0],
            checks: [
              {
                checkId: 'orphan-check',
                stepId: 'outside-run-plan',
                status: 'passed',
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('cannot construct a fictional complete Baseline with missing Step evidence', () => {
    const result = BaselineSchema.safeParse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'baseline-1',
      kind: 'baseline',
      projectId: 'acme',
      sceneId: 'invite-member',
      runTargetId: 'primary',
      createdAt: NOW,
      producer: { name: 'scenebook', version: '0.1.0' },
      sourceRunId: 'run-1',
      sourceAttemptId: 'attempt-1',
      sourceRevision: HASH_A,
      completeness: 'complete',
      sourceRunStatus: 'passed',
      expectedStepIds: ['open-form', 'send-invite'],
      states: [
        {
          sceneId: 'invite-member',
          stepId: 'open-form',
          phase: 'before',
          stateId: 'open-form-before',
          screenshot: asset(),
          screenshotHash: HASH_A,
          route: '/settings/members',
          viewport: { width: 1280, height: 720 },
          privacy: privacy(),
        },
      ],
      checksHash: HASH_B,
      approvals: [
        {
          id: 'approval-1',
          kind: 'visual',
          decision: 'approved',
          actorId: 'reviewer-1',
          createdAt: NOW,
          revision: HASH_A,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('requires atomic Release inputs and prevents approval of blocked Reviews', () => {
    const release = {
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'release-1',
      kind: 'release',
      projectId: 'acme',
      createdAt: NOW,
      producer: { name: 'scenebook', version: '0.1.0' },
      channelId: 'public',
      sequence: 1,
      status: 'published',
      scenes: [
        {
          sceneId: 'invite-member',
          sourceRevision: HASH_A,
          outputs: [{ format: 'catalog', asset: asset() }],
        },
      ],
      approvals: [
        {
          id: 'approval-1',
          kind: 'release',
          decision: 'approved',
          actorId: 'reviewer-1',
          createdAt: NOW,
          revision: HASH_A,
        },
      ],
      manifestHash: HASH_B,
    };
    expect(ReleaseSchema.safeParse(release).success).toBe(false);

    expect(
      ReviewSchema.safeParse({
        schemaVersion: 1,
        artifactVersion: 1,
        id: 'review-1',
        kind: 'review',
        projectId: 'acme',
        createdAt: NOW,
        producer: { name: 'scenebook', version: '0.1.0' },
        subject: { kind: 'run', id: 'run-1', revision: HASH_A },
        status: 'approved',
        changeState: 'blocked',
        openedAt: NOW,
        closedAt: NOW,
      }).success,
    ).toBe(false);
  });
});
