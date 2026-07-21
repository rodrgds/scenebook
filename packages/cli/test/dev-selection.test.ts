import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectSchema,
  SCHEMA_VERSION,
  ScenebookConfigSchema,
  serializeConfigYaml,
} from '@scenebook/schema';

const mocks = vi.hoisted(() => ({
  startDevServer: vi.fn(async (_config: unknown, _options: unknown) => undefined),
}));
vi.mock('../src/dev-server.js', () => ({ startDevServer: mocks.startDevServer }));

import { runCli } from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  mocks.startDevServer.mockClear();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('dev publication selection', () => {
  it('passes Channel and Collection selectors into every watched build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-dev-selection-test-'));
    directories.push(root);
    const project = ProjectSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id: 'stories',
      name: 'Stories',
      slug: 'stories',
      collections: [
        {
          id: 'start-here',
          title: 'Start here',
          slug: 'start-here',
          entries: [{ id: 'welcome', sceneId: 'welcome' }],
        },
      ],
      channels: [
        {
          id: 'public-docs',
          name: 'Public documentation',
          slug: 'public',
          kind: 'public-catalog',
          collectionIds: ['start-here'],
        },
      ],
    });
    await writeFile(
      join(root, 'scenebook.config.yaml'),
      serializeConfigYaml(ScenebookConfigSchema.parse({ schemaVersion: SCHEMA_VERSION, project })),
    );

    expect(
      await runCli(
        [
          'dev',
          '--channel',
          'public',
          '--collection',
          'start-here',
          '--host',
          '127.0.0.1',
          '--port',
          '6123',
          '--output',
          'dev-dist',
          '--allow-unscanned-privacy',
        ],
        { cwd: root },
      ),
    ).toBe(0);
    expect(mocks.startDevServer).toHaveBeenCalledOnce();
    expect(mocks.startDevServer.mock.calls[0]?.[1]).toEqual({
      host: '127.0.0.1',
      port: 6123,
      allowUnscannedPrivacy: true,
      output: 'dev-dist',
      channel: 'public',
      collection: 'start-here',
    });
  });
});
