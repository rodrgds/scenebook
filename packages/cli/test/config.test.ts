import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  ProjectSchema,
  SceneSchema,
  ScenebookConfigSchema,
  serializeConfigYaml,
  serializeProjectYaml,
  serializeSceneYaml,
} from '@scenebook/schema';
import { loadConfig } from '../src/config.js';
import { buildProject } from '../src/project.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function configFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-config-test-'));
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
        id: 'sidecar-project',
        name: 'Sidecar Product Stories',
        slug: 'sidecar-project',
      }),
    ),
  );
  return root;
}

describe('configuration project sidecars', () => {
  it('loads and validates a relative project.yaml and uses its real catalog title', async () => {
    const root = await configFixture();
    const sceneDirectory = join(root, 'scenes/demo.scene');
    await mkdir(sceneDirectory, { recursive: true });
    await writeFile(
      join(sceneDirectory, 'scene.yaml'),
      serializeSceneYaml(
        SceneSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          id: 'demo',
          slug: 'demo',
          title: 'Demo',
          steps: [{ id: 'done', kind: 'end', title: 'Done' }],
        }),
      ),
    );
    const config = await loadConfig(root);
    expect(config.project.name).toBe('Sidecar Product Stories');
    expect(config.projectPath).toBe(await realpath(join(root, 'project.yaml')));
    await buildProject(config, { allowUnscannedPrivacy: true });
    expect(await readFile(join(root, 'scenebook-dist/index.html'), 'utf8')).toContain(
      'Sidecar Product Stories',
    );
  });

  it('rejects missing and symlinked project sidecars', async () => {
    const missing = await configFixture();
    await rm(join(missing, 'project.yaml'));
    await expect(loadConfig(missing)).rejects.toThrow('Project sidecar not found');

    const linked = await configFixture();
    const outside = join(linked, 'outside.yaml');
    await writeFile(outside, await readFile(join(linked, 'project.yaml')));
    await rm(join(linked, 'project.yaml'));
    await symlink(outside, join(linked, 'project.yaml'));
    await expect(loadConfig(linked)).rejects.toThrow('not a symbolic link');
  });
});
