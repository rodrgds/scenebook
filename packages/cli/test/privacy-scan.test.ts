import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@scenebook/core';
import {
  ProjectSchema,
  SCHEMA_VERSION,
  SceneSchema,
  ScenebookConfigSchema,
  serializeConfigYaml,
  serializeSceneYaml,
} from '@scenebook/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';
import { createCommandOcrProvider, scanAssetFiles } from '../src/privacy-scan.js';
import { projectPrivacyPolicyDigest, readPrivacyCacheBinding } from '../src/project.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('publication OCR', () => {
  it('stages provider inputs inside the project and removes them after scanning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-ocr-staging-test-'));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, 'scenebook.config.yaml'),
      serializeConfigYaml(
        ScenebookConfigSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          project: {
            schemaVersion: SCHEMA_VERSION,
            id: 'ocr-staging',
            name: 'OCR staging',
            slug: 'ocr-staging',
          },
          output: { formats: ['html-guide'] },
        }),
      ),
    );
    const sceneDirectory = join(directory, 'scenes/example.scene');
    await mkdir(sceneDirectory, { recursive: true });
    await writeFile(
      join(sceneDirectory, 'scene.yaml'),
      serializeSceneYaml(
        SceneSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          id: 'example',
          slug: 'example',
          title: 'Example',
          steps: [{ id: 'done', kind: 'end', title: 'Done' }],
        }),
      ),
    );

    let stdout = '';
    let stderr = '';
    const code = await runCli(
      [
        'privacy',
        'scan',
        '--provider',
        'command',
        '--command-json',
        '["unused","{input}"]',
        '--scanner-version',
        '1',
      ],
      {
        cwd: directory,
        io: {
          stdout: { write: (value: string | Uint8Array) => ((stdout += String(value)), true) },
          stderr: { write: (value: string | Uint8Array) => ((stderr += String(value)), true) },
        },
      },
    );
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('Scanned 0 sanitized publication derivative(s)');
    expect(await readdir(join(directory, '.scenebook/staging'))).toEqual([]);
  });

  it('binds an atomic assessment to the exact derivative bytes and scanner provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-ocr-test-'));
    temporaryDirectories.push(directory);
    const assetPath = join(directory, 'derivative.png');
    const bytes = Buffer.from('sanitized derivative');
    const hash = sha256(bytes);
    await writeFile(assetPath, bytes);
    const provider = createCommandOcrProvider({
      command: ['fake-ocr', '{input}', '{hash}'],
      id: 'test-ocr',
      version: '1.2.3',
      run: async (_executable, arguments_) => ({
        code: 0,
        stdout: arguments_[1] === hash ? 'safe interface copy' : 'wrong hash',
        stderr: '',
      }),
    });
    const [assessment] = await scanAssetFiles({
      assets: [{ hash, path: assetPath }],
      provider,
      assessmentDirectory: join(directory, 'assessments'),
      policyDigest: sha256('policy-v1'),
    });
    expect(assessment?.status).toBe('clear');
    expect(assessment?.scannerVersion).toContain('test-ocr/1.2.3');
    expect(
      JSON.parse(await readFile(join(directory, 'assessments', `${hash}.json`), 'utf8')),
    ).toMatchObject({
      assetHash: hash,
      method: 'ocr',
      status: 'clear',
      policyDigest: sha256('policy-v1'),
      providerId: 'test-ocr',
      providerVersion: '1.2.3',
    });
    expect(
      JSON.parse(await readFile(join(directory, 'assessments/_context.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
      policyDigest: sha256('policy-v1'),
      providerId: 'test-ocr',
      providerVersion: '1.2.3',
    });
    expect(
      (await readdir(join(directory, 'assessments'))).some((name) => name.startsWith('.scan-')),
    ).toBe(false);
  });

  it('scans a private copy of the exact verified bytes instead of reopening the source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-ocr-copy-test-'));
    temporaryDirectories.push(directory);
    const assetPath = join(directory, 'derivative.png');
    const bytes = Buffer.from('safe publication derivative');
    const hash = sha256(bytes);
    await writeFile(assetPath, bytes);
    const assessmentDirectory = join(directory, 'assessments');

    const [assessment] = await scanAssetFiles({
      assets: [{ hash, path: assetPath }],
      provider: {
        id: 'copy-bound-ocr',
        version: '1',
        async scan(input) {
          expect(input.path).not.toBe(assetPath);
          expect(input.path.startsWith(`${assessmentDirectory}/.scan-`)).toBe(true);
          expect(await readFile(input.path)).toEqual(bytes);
          await writeFile(assetPath, 'changed after verification');
          return [{ text: 'safe interface copy', assetHash: input.assetHash }];
        },
      },
      assessmentDirectory,
      policyDigest: sha256('policy-v1'),
    });

    expect(assessment?.status).toBe('clear');
    expect(await readFile(assetPath, 'utf8')).toBe('changed after verification');
    expect((await readdir(assessmentDirectory)).some((name) => name.startsWith('.scan-'))).toBe(
      false,
    );
  });

  it('rejects a provider that mutates its staged input and removes the staging directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-ocr-provider-mutation-test-'));
    temporaryDirectories.push(directory);
    const assetPath = join(directory, 'derivative.png');
    const bytes = Buffer.from('safe publication derivative');
    const hash = sha256(bytes);
    await writeFile(assetPath, bytes);
    const assessmentDirectory = join(directory, 'assessments');

    await expect(
      scanAssetFiles({
        assets: [{ hash, path: assetPath }],
        provider: {
          id: 'mutating-ocr',
          version: '1',
          async scan(input) {
            await writeFile(input.path, 'mutated');
            return [{ text: 'safe interface copy', assetHash: input.assetHash }];
          },
        },
        assessmentDirectory,
        policyDigest: sha256('policy-v1'),
      }),
    ).rejects.toThrow('modified its immutable input');
    expect((await readdir(assessmentDirectory)).some((name) => name.startsWith('.scan-'))).toBe(
      false,
    );
  });

  it('does not expose the parent process secrets to an OCR command', async () => {
    const secretKey = 'SCENEBOOK_OCR_TEST_SECRET';
    const previous = process.env[secretKey];
    process.env[secretKey] = 'must-not-reach-the-provider';
    try {
      const provider = createCommandOcrProvider({
        command: [
          process.execPath,
          '-e',
          `process.stdout.write(process.env.${secretKey} ?? 'not-exposed')`,
          '{input}',
        ],
        id: 'environment-test',
        version: '1',
      });
      await expect(
        provider.scan({ path: '/unused', assetHash: sha256('unused') }),
      ).resolves.toEqual([{ text: 'not-exposed', assetHash: sha256('unused') }]);
    } finally {
      if (previous === undefined) delete process.env[secretKey];
      else process.env[secretKey] = previous;
    }
  });

  it('refuses stale bytes and never calls the provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-ocr-test-'));
    temporaryDirectories.push(directory);
    const assetPath = join(directory, 'derivative.png');
    await writeFile(assetPath, 'changed');
    let called = false;
    await expect(
      scanAssetFiles({
        assets: [{ hash: sha256('original'), path: assetPath }],
        provider: {
          id: 'injected',
          version: '1',
          async scan() {
            called = true;
            return [];
          },
        },
        assessmentDirectory: join(directory, 'assessments'),
        policyDigest: sha256('policy-v1'),
      }),
    ).rejects.toThrow('Refusing OCR assessment');
    expect(called).toBe(false);
  });

  it('rejects cached clearance after the active privacy policy changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scenebook-ocr-policy-test-'));
    temporaryDirectories.push(directory);
    const project = ProjectSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id: 'privacy-cache-test',
      name: 'Privacy cache test',
      slug: 'privacy-cache-test',
    });
    const loaded = {
      path: join(directory, 'scenebook.config.yaml'),
      directory,
      project,
      config: ScenebookConfigSchema.parse({ schemaVersion: SCHEMA_VERSION, project }),
    };
    const assetPath = join(directory, 'derivative.png');
    const bytes = Buffer.from('safe publication derivative');
    const hash = sha256(bytes);
    await writeFile(assetPath, bytes);
    await scanAssetFiles({
      assets: [{ hash, path: assetPath }],
      provider: {
        id: 'test-ocr',
        version: '1.0.0',
        async scan() {
          return [{ text: 'safe interface copy', assetHash: hash }];
        },
      },
      assessmentDirectory: join(directory, '.scenebook/privacy'),
      policyDigest: projectPrivacyPolicyDigest(loaded),
    });
    await expect(readPrivacyCacheBinding(loaded)).resolves.toMatchObject({
      providerId: 'test-ocr',
      providerVersion: '1.0.0',
    });

    const changed = {
      ...loaded,
      config: ScenebookConfigSchema.parse({
        ...loaded.config,
        privacy: { ...loaded.config.privacy, blockAt: 'medium' },
      }),
    };
    await expect(readPrivacyCacheBinding(changed)).rejects.toThrow('stale or invalid');
  });
});
