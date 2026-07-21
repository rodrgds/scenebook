import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function resultCode(environment) {
  return spawnSync('bash', [resolve(ROOT, 'scripts/github-action-result.sh')], {
    env: { PATH: process.env.PATH, ...environment },
    encoding: 'utf8',
  }).status;
}

describe('composite GitHub Action contract', () => {
  it('retains a report with the fully pinned official artifact action before returning status', async () => {
    const source = await readFile(resolve(ROOT, 'action.yml'), 'utf8');
    const action = parse(source);
    const steps = action.runs.steps;
    const setupNode = steps.find((step) => step.name === 'Install pinned Node.js runtime');
    expect(setupNode.uses).toBe('actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e');
    expect(setupNode.with['node-version']).toBe('24.18.0');
    const upload = steps.find((step) => step.id === 'artifact');
    expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(upload.if).toContain('always()');
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with['include-hidden-files']).toBe(false);
    expect(action.inputs['post-checks'].default).toBe('false');
    expect(action.inputs['github-token'].default).toBe('');
    expect(action.outputs['artifact-digest'].value).toBe(
      '${{ steps.artifact.outputs.artifact-digest }}',
    );
    const checks = steps.find((step) => step.id === 'checks');
    expect(checks.if).toContain("github.event_name != 'pull_request_target'");
    expect(checks.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    for (const step of steps) {
      const environmentNames = Object.keys(step.env ?? {}).map((name) => name.toLowerCase());
      expect(new Set(environmentNames).size).toBe(environmentNames.length);
    }
    expect(steps.at(-1).name).toBe('Return verification result');
  });

  it('pins every first-party workflow artifact upload to the reviewed current commit', async () => {
    for (const path of ['.github/workflows/ci.yml', '.github/workflows/publish-packages.yml']) {
      const source = await readFile(resolve(ROOT, path), 'utf8');
      expect(parse(source)).toHaveProperty('jobs');
      const references = source.match(/actions\/upload-artifact@[^\s]+/gu) ?? [];
      expect(references.length).toBeGreaterThan(0);
      expect(new Set(references)).toEqual(
        new Set(['actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a']),
      );
    }
  });

  it('installs Chromium before running browser-backed unit tests', async () => {
    const source = await readFile(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const workflow = parse(source);
    const steps = workflow.jobs.verify.steps;
    const browserInstallIndex = steps.findIndex(
      (step) => step.name === 'Install reference browser',
    );
    const testIndex = steps.findIndex((step) => step.name === 'Unit and contract tests');
    expect(browserInstallIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(browserInstallIndex);
    const seedIndex = steps.findIndex((step) => step.name === 'Regenerate reference Scene');
    const semanticAssertion = steps.find(
      (step) => step.name === 'Assert generated Scene semantics are committed',
    );
    expect(seedIndex).toBeGreaterThan(testIndex);
    expect(semanticAssertion.run).toContain('--ignore-matching-lines=');
    expect(semanticAssertion.run).toContain('invite-member.scene/scene.yaml');
  });

  it('approves a disposable changed baseline before expecting the Action self-test to pass', async () => {
    const source = await readFile(resolve(ROOT, '.github/workflows/scenebook.yml'), 'utf8');
    const workflow = parse(source);
    const steps = workflow.jobs.journeys.steps;
    const seedIndex = steps.findIndex((step) => step.name === 'Seed a reviewed self-test baseline');
    const actionIndex = steps.findIndex((step) => step.uses === './');
    expect(seedIndex).toBeGreaterThan(-1);
    expect(actionIndex).toBeGreaterThan(seedIndex);
    expect(steps[seedIndex].run).toContain('seed_exit_code');
    expect(steps[seedIndex].run).toContain('baseline accept');
    expect(steps[seedIndex].run).toContain('github-action-self-test');
  });

  it('returns the original verification exit before report, artifact, or Checks failures', () => {
    expect(
      resultCode({
        SCENEBOOK_ACTION_VERIFICATION_EXIT_CODE: '2',
        SCENEBOOK_ACTION_REPORT_EXIT_CODE: '3',
        SCENEBOOK_ACTION_REPORT_READY: 'false',
        SCENEBOOK_ACTION_ARTIFACT_OUTCOME: 'failure',
        SCENEBOOK_ACTION_POST_CHECKS: 'true',
        SCENEBOOK_ACTION_CHECKS_OUTCOME: 'failure',
      }),
    ).toBe(2);
  });

  it('fails closed on support-stage errors only after a successful verification', () => {
    const common = {
      SCENEBOOK_ACTION_VERIFICATION_EXIT_CODE: '0',
      SCENEBOOK_ACTION_REPORT_EXIT_CODE: '0',
      SCENEBOOK_ACTION_REPORT_READY: 'true',
      SCENEBOOK_ACTION_ARTIFACT_OUTCOME: 'success',
      SCENEBOOK_ACTION_POST_CHECKS: 'false',
      SCENEBOOK_ACTION_CHECKS_ALLOWED: 'true',
      SCENEBOOK_ACTION_CHECKS_OUTCOME: '',
    };
    expect(resultCode(common)).toBe(0);
    expect(resultCode({ ...common, SCENEBOOK_ACTION_REPORT_EXIT_CODE: '3' })).toBe(3);
    expect(resultCode({ ...common, SCENEBOOK_ACTION_ARTIFACT_OUTCOME: 'failure' })).toBe(3);
    expect(
      resultCode({
        ...common,
        SCENEBOOK_ACTION_POST_CHECKS: 'true',
        SCENEBOOK_ACTION_CHECKS_ALLOWED: 'true',
        SCENEBOOK_ACTION_CHECKS_OUTCOME: 'failure',
      }),
    ).toBe(4);
    expect(
      resultCode({
        ...common,
        SCENEBOOK_ACTION_POST_CHECKS: 'true',
        SCENEBOOK_ACTION_CHECKS_ALLOWED: 'false',
        SCENEBOOK_ACTION_CHECKS_OUTCOME: 'skipped',
      }),
    ).toBe(0);
  });

  it('passes action inputs as literal argv and returns the CLI status', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'scenebook-action-contract-'));
    directories.push(workspace);
    const executable = resolve(workspace, 'node_modules/.bin/scenebook');
    const argumentsPath = resolve(workspace, 'arguments.txt');
    await mkdir(resolve(workspace, 'node_modules/.bin'), { recursive: true });
    await writeFile(
      executable,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$SCENEBOOK_TEST_ARGUMENTS"\nexit "${SCENEBOOK_TEST_EXIT:-0}"\n',
    );
    await chmod(executable, 0o700);
    const result = spawnSync('bash', [resolve(ROOT, 'scripts/github-action-verify.sh')], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        SCENEBOOK_ACTION_VERSION: '0.1.0',
        SCENEBOOK_ACTION_CONFIG: 'config with spaces.ts',
        SCENEBOOK_ACTION_TARGET: 'preview; false',
        SCENEBOOK_ACTION_UPLOAD: 'false',
        SCENEBOOK_ACTION_POST_CHECKS: 'false',
        SCENEBOOK_ACTION_ARTIFACT_NAME: 'scenebook-review',
        SCENEBOOK_ACTION_OCR_PROVIDER: 'tesseract',
        SCENEBOOK_ACTION_OCR_COMMAND_JSON: '',
        SCENEBOOK_ACTION_OCR_SCANNER_ID: '',
        SCENEBOOK_ACTION_OCR_SCANNER_VERSION: '',
        SCENEBOOK_TEST_ARGUMENTS: argumentsPath,
        SCENEBOOK_TEST_EXIT: '7',
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(7);
    expect((await readFile(argumentsPath, 'utf8')).split('\n').filter(Boolean)).toEqual([
      'ci',
      '--config',
      'config with spaces.ts',
      '--target',
      'preview; false',
      '--provider',
      'tesseract',
    ]);
  });

  it('uses the checked-out action build for its unpublished self-test', async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), 'scenebook-action-self-test-'));
    directories.push(sandbox);
    const workspace = resolve(sandbox, 'consumer');
    const actionRoot = resolve(sandbox, 'action');
    const executable = resolve(actionRoot, 'packages/cli/dist/bin.js');
    const argumentsPath = resolve(sandbox, 'arguments.txt');
    await mkdir(workspace, { recursive: true });
    await mkdir(resolve(actionRoot, 'packages/cli/dist'), { recursive: true });
    await writeFile(
      executable,
      "const { writeFileSync } = require('node:fs');\nwriteFileSync(process.env.SCENEBOOK_TEST_ARGUMENTS, `${process.argv.slice(2).join('\\n')}\\n`);\n",
    );

    const result = spawnSync('bash', [resolve(ROOT, 'scripts/github-action-verify.sh')], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        GITHUB_ACTION_PATH: actionRoot,
        SCENEBOOK_ACTION_VERSION: '0.1.0',
        SCENEBOOK_ACTION_CONFIG: 'scenebook.config.ts',
        SCENEBOOK_ACTION_UPLOAD: 'false',
        SCENEBOOK_ACTION_POST_CHECKS: 'false',
        SCENEBOOK_ACTION_ARTIFACT_NAME: 'scenebook-review',
        SCENEBOOK_ACTION_OCR_PROVIDER: 'tesseract',
        SCENEBOOK_TEST_ARGUMENTS: argumentsPath,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect((await readFile(argumentsPath, 'utf8')).split('\n').filter(Boolean)).toEqual([
      'ci',
      '--config',
      'scenebook.config.ts',
      '--provider',
      'tesseract',
    ]);
  });
});
