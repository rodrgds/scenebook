import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_VERSION,
  BuildArtifactSchema,
  ProjectSchema,
  SCHEMA_VERSION,
  SceneSchema,
  ScenebookConfigSchema,
  serializeConfigYaml,
  serializeSceneYaml,
} from '@scenebook/schema';

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  wrapperPath: '',
  wrapperSource: '',
  arguments: [] as string[],
  environment: {} as NodeJS.ProcessEnv,
}));

vi.mock('../src/process.js', () => ({ runProcess: mocks.runProcess }));

import { runCli } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  mocks.runProcess.mockReset();
  mocks.wrapperPath = '';
  mocks.wrapperSource = '';
  mocks.arguments = [];
  mocks.environment = {};
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

async function fixture(targetIds: readonly string[] = ['local-target']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-playwright-command-'));
  roots.push(root);
  const environments = [
    {
      id: 'local',
      name: 'Local',
      kind: 'local' as const,
      baseUrl: 'http://127.0.0.1:4174',
      allowMutations: true,
    },
    {
      id: 'custom',
      name: 'Custom',
      kind: 'custom' as const,
      baseUrl: 'https://custom.example.test',
      allowMutations: true,
    },
  ];
  const project = ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: 'command-project',
    name: 'Command project',
    slug: 'command-project',
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
      environmentId: id.replace(/-target$/u, ''),
      productVariantId: 'admin',
      captureProfileId: 'desktop',
      enabled: true,
    })),
  });
  await writeFile(
    join(root, 'scenebook.config.yaml'),
    serializeConfigYaml(
      ScenebookConfigSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        project,
        playwright: {
          config: 'playwright.config.ts',
          projects: ['chromium'],
          forbidProductionMutations: true,
        },
        output: { formats: ['catalog'] },
      }),
    ),
  );
  await writeFile(
    join(root, 'playwright.config.ts'),
    `export default { projects: [{ name: 'chromium' }], use: { baseURL: process.env.SCENEBOOK_BASE_URL ?? 'http://127.0.0.1:4174' } };\n`,
  );
  const scene = join(root, 'scenes/protected.scene');
  await mkdir(scene, { recursive: true });
  await writeFile(
    join(scene, 'scene.yaml'),
    serializeSceneYaml(
      SceneSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: 'protected',
        slug: 'protected',
        title: 'Protected',
        steps: [{ id: 'done', kind: 'end', title: 'Done' }],
      }),
    ),
  );
  return root;
}

function captureSuccessfulProcess(): void {
  mocks.runProcess.mockImplementation(
    async (
      _command: string,
      arguments_: readonly string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      mocks.arguments = [...arguments_];
      mocks.environment = options.env ?? {};
      const configIndex = arguments_.indexOf('--config');
      mocks.wrapperPath = String(arguments_[configIndex + 1]);
      mocks.wrapperSource = await readFile(mocks.wrapperPath, 'utf8');
      return 0;
    },
  );
}

async function writeBuild(root: string, projectId: string, runTargetId: string): Promise<void> {
  const now = '2026-07-20T12:00:00.000Z';
  const build = BuildArtifactSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    artifactVersion: ARTIFACT_VERSION,
    id: 'build-command',
    projectId,
    kind: 'build',
    createdAt: now,
    producer: { name: '@scenebook/playwright', version: '0.1.0' },
    repository: {
      provider: 'generic',
      repository: 'acme/product',
      commit: 'a'.repeat(40),
      dirty: false,
    },
    trigger: 'local',
    status: 'passed',
    expectedRunPlan: [{ sceneId: 'protected', runTargetId, required: true }],
    runs: [
      {
        sceneId: 'protected',
        runTargetId,
        required: true,
        run: {
          id: 'run-command',
          kind: 'run',
          sha256: 'b'.repeat(64),
          path: 'runs/run-command.json',
        },
        status: 'passed',
        changeState: 'passed',
      },
    ],
    startedAt: now,
    endedAt: now,
    summary: { total: 1, passed: 1, changed: 0, broken: 0, blocked: 0, pending: 0 },
  });
  await mkdir(join(root, '.scenebook/runs'), { recursive: true });
  await writeFile(join(root, '.scenebook/runs/build.json'), JSON.stringify(build));
}

describe('CLI Playwright target enforcement', () => {
  it('binds the inferred target, forces a safety config, and removes the wrapper', async () => {
    const root = await fixture();
    captureSuccessfulProcess();
    const result = output();

    expect(await runCli(['test'], { cwd: root, io: result.io })).toBe(0);
    expect(mocks.arguments).toContain('--reporter=line,@scenebook/playwright/reporter');
    expect(mocks.arguments).toContain('--project');
    expect(mocks.environment).toMatchObject({
      SCENEBOOK_PROJECT_ID: 'command-project',
      SCENEBOOK_RUN_TARGET_ID: 'local-target',
      SCENEBOOK_ENVIRONMENT_ID: 'local',
      SCENEBOOK_BASE_URL: 'http://127.0.0.1:4174/',
      SCENEBOOK_MUTATIONS_ALLOWED: '1',
    });
    expect(mocks.wrapperSource).toContain('disagrees with selected Scenebook Environment');
    expect(mocks.wrapperSource).toContain('baseURL: expectedCanonical');
    expect(result.stdout()).toContain('Testing Run Target local-target');
    await expect(access(mocks.wrapperPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects ambiguous selection and all target/config URL bypass overrides', async () => {
    const root = await fixture(['local-target', 'custom-target']);
    captureSuccessfulProcess();

    const ambiguous = output();
    expect(await runCli(['test'], { cwd: root, io: ambiguous.io })).toBe(1);
    expect(ambiguous.stderr()).toContain('selection is ambiguous');
    expect(mocks.runProcess).not.toHaveBeenCalled();

    const doctor = output();
    expect(
      await runCli(['doctor', '--allow-unscanned-privacy'], { cwd: root, io: doctor.io }),
    ).toBe(0);
    expect(doctor.stdout()).toContain(
      '✓ Playwright Run Targets: 2 runnable (local-target, custom-target); test and ci require --target <id>',
    );

    for (const arguments_ of [
      ['test', '--target', 'missing'],
      ['test', '--target', 'local-target', '--target', 'custom-target'],
      ['test', '--target', 'local-target', '--base-url', 'https://attacker.invalid'],
      ['test', '--target', 'local-target', '--', '--config', 'attacker.config.ts'],
      ['test', '--target', 'local-target', '--', '--project=attacker'],
      ['test', '--target', 'local-target', '--', '--reporter=list'],
    ]) {
      mocks.runProcess.mockClear();
      const result = output();
      expect(await runCli(arguments_, { cwd: root, io: result.io })).toBe(1);
      expect(mocks.runProcess).not.toHaveBeenCalled();
    }

    expect(
      await runCli(['test', '--target', 'custom-target'], { cwd: root, io: output().io }),
    ).toBe(0);
    expect(mocks.environment.SCENEBOOK_ENVIRONMENT_ID).toBe('custom');
  });

  it('preflights CI before deleting evidence and validates reporter target binding', async () => {
    const ambiguousRoot = await fixture(['local-target', 'custom-target']);
    await mkdir(join(ambiguousRoot, '.scenebook/runs'), { recursive: true });
    await writeFile(join(ambiguousRoot, '.scenebook/runs/build.json'), 'preserve-me');
    const blocked = output();
    expect(await runCli(['ci'], { cwd: ambiguousRoot, io: blocked.io })).toBe(1);
    expect(await readFile(join(ambiguousRoot, '.scenebook/runs/build.json'), 'utf8')).toBe(
      'preserve-me',
    );

    const hostedRoot = await fixture();
    await mkdir(join(hostedRoot, '.scenebook/runs'), { recursive: true });
    await writeFile(join(hostedRoot, '.scenebook/runs/build.json'), 'preserve-hosted');
    for (const arguments_ of [
      ['ci', '--server-url', 'https://scenebook.example.test'],
      ['ci', '--upload', '--allow-unscanned-privacy'],
    ]) {
      mocks.runProcess.mockClear();
      const hosted = output();
      expect(await runCli(arguments_, { cwd: hostedRoot, io: hosted.io })).toBe(1);
      expect(mocks.runProcess).not.toHaveBeenCalled();
      expect(await readFile(join(hostedRoot, '.scenebook/runs/build.json'), 'utf8')).toBe(
        'preserve-hosted',
      );
    }

    const root = await fixture();
    mocks.runProcess.mockImplementation(
      async (
        _command: string,
        _arguments: readonly string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        mocks.environment = options.env ?? {};
        await writeBuild(root, 'command-project', 'local-target');
        return 0;
      },
    );
    const successful = output();
    expect(
      await runCli(['ci', '--target', 'local-target', '--allow-unscanned-privacy'], {
        cwd: root,
        io: successful.io,
      }),
      successful.stderr(),
    ).toBe(0);
    expect(mocks.environment.SCENEBOOK_RUN_TARGET_ID).toBe('local-target');

    mocks.runProcess.mockImplementation(async () => {
      await writeBuild(root, 'command-project', 'wrong-target');
      return 0;
    });
    const mismatched = output();
    expect(
      await runCli(['ci', '--target', 'local-target', '--allow-unscanned-privacy'], {
        cwd: root,
        io: mismatched.io,
      }),
    ).toBe(2);
    expect(mismatched.stderr()).toContain('Playwright reporter binding mismatch');
  });
});
