import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectSchema,
  SCHEMA_VERSION,
  SceneSchema,
  ScenebookConfigSchema,
  parseProjectYaml,
  serializeConfigYaml,
  serializeProjectYaml,
  serializeSceneYaml,
} from '@scenebook/schema';
import { runCli } from '../src/index.js';
import {
  projectPublicationAnalytics,
  projectPublicationCta,
  projectPublicationPlan,
} from '../src/publication.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write(value: string | Uint8Array) {
          stdout += String(value);
          return true;
        },
      },
      stderr: {
        write(value: string | Uint8Array) {
          stderr += String(value);
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function publicationFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-publication-test-'));
  directories.push(root);
  await writeFile(
    join(root, 'scenebook.config.yaml'),
    serializeConfigYaml(
      ScenebookConfigSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        project: 'project.yaml',
        output: { formats: ['catalog'] },
      }),
    ),
  );
  await writeFile(
    join(root, 'project.yaml'),
    serializeProjectYaml(
      ProjectSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: 'stories',
        name: 'All product stories',
        slug: 'stories',
        description: 'The complete project catalog.',
        defaultLocale: 'pt-PT',
        locales: ['pt-PT'],
        collections: [
          {
            id: 'start-here',
            slug: 'start-here',
            title: 'Start here',
            description: 'Core onboarding.',
            entries: [
              {
                id: 'beta-first',
                sceneId: 'beta',
                title: 'Beta entry title',
                description: 'Curated Beta description.',
              },
            ],
          },
          {
            id: 'advanced',
            slug: 'advanced-guides',
            title: 'Advanced guides',
            description: 'Specialist workflows.',
            entries: [
              { id: 'beta-again', sceneId: 'beta' },
              { id: 'alpha-entry', sceneId: 'alpha' },
            ],
          },
        ],
        channels: [
          {
            id: 'public-docs',
            slug: 'public',
            name: 'Public documentation',
            description: 'Approved customer-facing guidance.',
            kind: 'public-catalog',
            collectionIds: ['start-here', 'advanced'],
          },
          {
            id: 'empty',
            slug: 'empty',
            name: 'Empty Channel',
            kind: 'static',
            collectionIds: [],
          },
        ],
      }),
    ),
  );
  for (const [id, title] of [
    ['alpha', 'Alpha source'],
    ['beta', 'Beta source'],
    ['loose', 'Loose source'],
  ]) {
    const directory = join(root, 'scenes', `${id}.scene`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'scene.yaml'),
      serializeSceneYaml(
        SceneSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          id,
          slug: id,
          title,
          steps: [{ id: 'done', kind: 'end', title: 'Done' }],
        }),
      ),
    );
  }
  return root;
}

async function manifest(
  root: string,
  directory: string,
): Promise<{
  scenes: Array<{ id: string }>;
  publication: {
    title: string;
    description?: string;
    locale?: string;
    selection: {
      mode: string;
      projectId?: string;
      channelId?: string;
      collectionIds: string[];
    };
    groups: Array<{ id: string; kind: string; entries: Array<{ sceneId: string }> }>;
    policy: Record<string, unknown>;
  };
}> {
  return JSON.parse(await readFile(join(root, directory, 'manifest.json'), 'utf8'));
}

describe('project publication selection', () => {
  it('builds the default grouped project catalog with deterministic first placement and ungrouped Scenes', async () => {
    const root = await publicationFixture();
    const result = output();
    expect(await runCli(['build', '--allow-unscanned-privacy'], { cwd: root, io: result.io })).toBe(
      0,
    );
    const built = await manifest(root, 'scenebook-dist');
    expect(built.scenes.map((scene) => scene.id)).toEqual(['beta', 'alpha', 'loose']);
    expect(built.publication.selection).toEqual({
      mode: 'project',
      projectId: 'stories',
      collectionIds: ['start-here', 'advanced'],
    });
    expect(built.publication.locale).toBe('pt-PT');
    expect(built.publication.groups).toEqual([
      expect.objectContaining({
        id: 'start-here',
        entries: [
          { sceneId: 'beta', title: 'Beta entry title', description: 'Curated Beta description.' },
        ],
      }),
      expect.objectContaining({ id: 'advanced', entries: [{ sceneId: 'alpha' }] }),
      expect.objectContaining({
        id: 'scenebook:ungrouped',
        kind: 'ungrouped',
        entries: [{ sceneId: 'loose' }],
      }),
    ]);
    const html = await readFile(join(root, 'scenebook-dist/index.html'), 'utf8');
    expect(html).toContain('<html lang="pt-PT">');
    expect(html).toContain('The complete project catalog.');
    expect(html).toContain('Beta entry title');
    expect(html).toContain('Curated Beta description.');
    expect(html.indexOf('Start here')).toBeLessThan(html.indexOf('Advanced guides'));
    expect(html.indexOf('Advanced guides')).toBeLessThan(html.indexOf('Ungrouped Scenes'));
  });

  it('inherits, overrides, and explicitly disables public analytics per Channel', () => {
    const endpoint =
      'https://api.example.test/v1/public/workspaces/acme/projects/product/channels/inherited/analytics';
    const overrideEndpoint =
      'https://api.example.test/v1/public/workspaces/acme/projects/product/channels/override/analytics';
    const project = ProjectSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id: 'stories',
      name: 'Stories',
      slug: 'stories',
      public: {
        analytics: {
          endpoint,
          tokenEnv: 'PROJECT_ANALYTICS_TOKEN',
          releaseId: 'release-project',
        },
      },
      channels: [
        { id: 'inherited', name: 'Inherited', slug: 'inherited', kind: 'static' },
        {
          id: 'override',
          name: 'Override',
          slug: 'override',
          kind: 'static',
          public: {
            analytics: {
              endpoint: overrideEndpoint,
              tokenEnv: 'OVERRIDE_ANALYTICS_TOKEN',
              releaseId: 'release-override',
            },
          },
        },
        {
          id: 'disabled',
          name: 'Disabled',
          slug: 'disabled',
          kind: 'offline',
          public: { analytics: null },
        },
      ],
    });
    const environment = {
      PROJECT_ANALYTICS_TOKEN: 'project-public-token',
      OVERRIDE_ANALYTICS_TOKEN: 'override-public-token',
    };

    expect(
      projectPublicationPlan(project, { channel: 'inherited' }).distribution.analytics,
    ).toEqual(expect.objectContaining({ endpoint, releaseId: 'release-project' }));
    expect(
      projectPublicationAnalytics(project, { channel: 'inherited' }, environment),
    ).toMatchObject({ endpoint, token: 'project-public-token' });
    expect(projectPublicationPlan(project, { channel: 'override' }).distribution.analytics).toEqual(
      expect.objectContaining({ endpoint: overrideEndpoint, releaseId: 'release-override' }),
    );
    expect(
      projectPublicationAnalytics(project, { channel: 'override' }, environment),
    ).toMatchObject({ endpoint: overrideEndpoint, token: 'override-public-token' });
    expect(projectPublicationPlan(project, { channel: 'disabled' }).distribution.analytics).toBe(
      undefined,
    );
    expect(projectPublicationAnalytics(project, { channel: 'disabled' }, environment)).toBe(
      undefined,
    );
  });

  it('keeps public CTA configuration reviewed and independently disable-able', () => {
    const endpoint =
      'https://api.example.test/v1/public/workspaces/acme/projects/product/channels/forms/cta';
    const project = ProjectSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id: 'stories',
      name: 'Stories',
      slug: 'stories',
      public: {
        cta: {
          endpoint,
          tokenEnv: 'PUBLIC_CTA_TOKEN',
          releaseId: 'release-forms',
        },
      },
      channels: [
        { id: 'forms', name: 'Forms', slug: 'forms', kind: 'static' },
        {
          id: 'offline',
          name: 'Offline',
          slug: 'offline',
          kind: 'offline',
          public: { cta: null },
        },
      ],
    });
    const environment = { PUBLIC_CTA_TOKEN: 'independent-public-cta-token' };

    expect(projectPublicationPlan(project, { channel: 'forms' }).distribution.cta).toEqual({
      endpoint,
      releaseId: 'release-forms',
    });
    expect(projectPublicationCta(project, { channel: 'forms' }, environment)).toEqual({
      endpoint,
      token: 'independent-public-cta-token',
      releaseId: 'release-forms',
    });
    expect(
      projectPublicationPlan(project, { channel: 'offline' }).distribution.cta,
    ).toBeUndefined();
    expect(projectPublicationCta(project, { channel: 'offline' }, environment)).toBeUndefined();
    expect(() => projectPublicationCta(project, { channel: 'forms' }, {})).toThrow(
      /PUBLIC_CTA_TOKEN.*Form submissions were not enabled/u,
    );
  });

  it('wires Channel and Collection narrowing through builds and rejects publish-time rebuilding', async () => {
    const root = await publicationFixture();
    const exported = output();
    expect(
      await runCli(
        [
          'export',
          '--format',
          'catalog',
          '--channel',
          'public',
          '--output',
          'channel-dist',
          '--allow-unscanned-privacy',
        ],
        { cwd: root, io: exported.io },
      ),
    ).toBe(0);
    const channel = await manifest(root, 'channel-dist');
    expect(channel.scenes.map((scene) => scene.id)).toEqual(['beta', 'alpha']);
    expect(channel.publication.title).toBe('Public documentation');
    expect(channel.publication.description).toBe('Approved customer-facing guidance.');
    expect(channel.publication.selection).toEqual({
      mode: 'channel',
      projectId: 'stories',
      channelId: 'public-docs',
      collectionIds: ['start-here', 'advanced'],
    });
    expect(channel.publication.policy).toMatchObject({
      ungroupedScenes: 'exclude',
      channel: { publication: 'manual', nonCriticalFailure: 'block' },
    });

    const collectionBuild = output();
    expect(
      await runCli(
        [
          'build',
          '--collection',
          'start-here',
          '--output',
          'collection-dist',
          '--allow-unscanned-privacy',
        ],
        { cwd: root, io: collectionBuild.io },
      ),
    ).toBe(0);
    const collection = await manifest(root, 'collection-dist');
    expect(collection.scenes.map((scene) => scene.id)).toEqual(['beta']);
    expect(collection.publication.title).toBe('Start here');
    expect(collection.publication.selection).toEqual({
      mode: 'collection',
      projectId: 'stories',
      collectionIds: ['start-here'],
    });

    const published = output();
    expect(
      await runCli(
        [
          'publish',
          '--destination',
          'published',
          '--channel',
          'public-docs',
          '--actor',
          'release-manager',
          '--yes',
          '--collection',
          'advanced-guides',
          '--allow-unscanned-privacy',
        ],
        { cwd: root, io: published.io },
      ),
    ).toBe(1);
    expect(published.stderr()).toContain(
      'promotion consumes the already sealed candidate without rebuilding',
    );
  });

  it('rejects missing entries, unknown or repeated selectors, membership mistakes, and empty Channels', async () => {
    const root = await publicationFixture();
    for (const [arguments_, message] of [
      [['build', '--channel', 'missing'], 'Unknown channel missing'],
      [
        ['build', '--channel', 'empty', '--collection', 'start-here'],
        'Collection start-here is not part of Channel empty',
      ],
      [['build', '--channel', 'empty'], 'Channel empty has no publishable Scenes'],
      [
        ['build', '--channel', 'public', '--channel', 'public-docs'],
        'Option --channel may only be provided once',
      ],
    ] as const) {
      const result = output();
      expect(await runCli(arguments_, { cwd: root, io: result.io })).toBe(1);
      expect(result.stderr()).toContain(message);
    }

    const project = parseProjectYaml(await readFile(join(root, 'project.yaml'), 'utf8'));
    await writeFile(
      join(root, 'project.yaml'),
      serializeProjectYaml(
        ProjectSchema.parse({
          ...project,
          collections: project.collections.map((collection, index) =>
            index === 0
              ? {
                  ...collection,
                  entries: collection.entries.map((entry, entryIndex) =>
                    entryIndex === 0 ? { ...entry, sceneId: 'missing-scene' } : entry,
                  ),
                }
              : collection,
          ),
        }),
      ),
    );
    const missing = output();
    expect(await runCli(['build'], { cwd: root, io: missing.io })).toBe(1);
    expect(missing.stderr()).toContain(
      'Publication collection start-here references missing Scene missing-scene',
    );
  });
});
