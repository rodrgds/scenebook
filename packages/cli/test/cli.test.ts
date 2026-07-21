import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@scenebook/core';
import { reviewRunEvidence } from '@scenebook/playwright';
import { BaselineSchema, RunArtifactSchema, parseSceneYaml } from '@scenebook/schema';
import { runCli } from '../src/index.js';

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

describe('Scenebook CLI', () => {
  it('can create a useful source-linked Scene during init without guessing a target URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-cli-guided-init-'));
    directories.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'guided-product' }));
    await writeFile(join(root, 'playwright.config.ts'), 'export default {};');
    await mkdir(join(root, 'e2e'), { recursive: true });
    await writeFile(
      join(root, 'e2e/onboarding.spec.ts'),
      `import { test } from '@playwright/test';
test('Complete onboarding', async () => {
  await test.step('Create a workspace', async () => {});
  await test.step('Invite the team', async () => {});
});`,
    );
    const result = output();

    expect(await runCli(['init', '--yes'], { cwd: root, io: result.io })).toBe(0);
    expect(result.stdout()).toContain('Imported first Scene Complete onboarding');
    expect(result.stdout()).toContain('remains Monitored until a controlled Run captures evidence');
    expect(result.stdout()).toContain('init` does not guess a URL');
    const scene = parseSceneYaml(
      await readFile(join(root, 'scenes/complete-onboarding.scene/scene.yaml'), 'utf8'),
    );
    expect(scene.automation).toMatchObject({
      level: 'monitored',
      linkedTest: { path: 'e2e/onboarding.spec.ts', title: 'Complete onboarding' },
    });
    expect(scene.steps.map((step) => step.title)).toEqual([
      'Create a workspace',
      'Invite the team',
    ]);
    expect(await readFile(join(root, 'scenebook.config.ts'), 'utf8')).not.toContain('baseUrl');
  });

  it('requires an explicit file when non-interactive init finds multiple candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-cli-unambiguous-init-'));
    directories.push(root);
    await writeFile(join(root, 'playwright.config.ts'), 'export default {};');
    await mkdir(join(root, 'tests'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'tests/one.spec.ts'), "test('One', () => {});"),
      writeFile(join(root, 'tests/two.spec.ts'), "test('Two', () => {});"),
    ]);
    const ambiguous = output();
    expect(await runCli(['init', '--yes'], { cwd: root, io: ambiguous.io })).toBe(1);
    expect(ambiguous.stderr()).toContain('Refusing to guess');
    await expect(readFile(join(root, 'scenebook.config.ts'), 'utf8')).rejects.toThrow();

    const explicit = output();
    expect(
      await runCli(['init', '--import', 'tests/two.spec.ts'], {
        cwd: root,
        io: explicit.io,
      }),
    ).toBe(0);
    expect(explicit.stdout()).toContain('Imported first Scene Two');
  });

  it('runs the real init → Playwright import → static build path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-cli-test-'));
    directories.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo-product' }));
    await writeFile(join(root, 'playwright.config.ts'), 'export default {};');
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(join(root, 'tests/existing.spec.ts'), "test('existing', () => {});");
    const initOutput = output();
    expect(await runCli(['init'], { cwd: root, io: initOutput.io })).toBe(0);
    expect(initOutput.stdout()).toContain('detected playwright.config.ts');
    expect(initOutput.stdout()).toContain('Detected 1 candidate test file');
    expect(initOutput.stdout()).toContain('scenebook import playwright tests/existing.spec.ts');
    expect(initOutput.stdout()).toContain('init` does not guess a URL');
    expect(await runCli(['init'], { cwd: root, io: output().io })).toBe(1);

    const doctorOutput = output();
    expect(
      await runCli(['doctor', '--allow-unscanned-privacy'], {
        cwd: root,
        io: doctorOutput.io,
      }),
    ).toBe(2);
    expect(doctorOutput.stdout()).toContain('✗ Playwright Run Targets: none enabled');
    expect(doctorOutput.stdout()).toContain('Environment, Product Variant, Capture Profile');

    await writeFile(
      join(root, 'tests/invite.spec.ts'),
      `import { test } from '@playwright/test';
test('Invite a teammate', async () => {
  await test.step('Open the invitation form', async () => {});
  await test.step('Send the invitation', async () => {});
});`,
    );
    const importOutput = output();
    expect(
      await runCli(['import', 'playwright', 'tests/invite.spec.ts'], {
        cwd: root,
        io: importOutput.io,
      }),
    ).toBe(0);
    expect(importOutput.stdout()).toContain('Invite a teammate');
    const imported = parseSceneYaml(
      await readFile(join(root, 'scenes/invite-a-teammate.scene/scene.yaml'), 'utf8'),
    );
    expect(imported.steps.map((step) => step.title)).toEqual([
      'Open the invitation form',
      'Send the invitation',
    ]);

    const buildOutput = output();
    // Authoring and publication remain independent of optional Playwright targets.
    expect(await runCli(['build'], { cwd: root, io: buildOutput.io })).toBe(0);
    expect(buildOutput.stdout()).toContain('Built 1 Scene');
    const manifest = JSON.parse(
      await readFile(join(root, 'scenebook-dist/manifest.json'), 'utf8'),
    ) as {
      scenes: Array<{ id: string }>;
    };
    expect(manifest.scenes).toEqual([expect.objectContaining({ id: 'invite-a-teammate' })]);
    expect(
      await readFile(join(root, 'scenebook-dist/standalone/invite-a-teammate.html'), 'utf8'),
    ).toContain('Interactive walkthrough');
  });

  it('exposes schemas and reports unsupported or incomplete commands as failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-cli-errors-'));
    directories.push(root);
    const schemaOutput = output();
    expect(await runCli(['schema', 'scene'], { cwd: root, io: schemaOutput.io })).toBe(0);
    expect(JSON.parse(schemaOutput.stdout())).toMatchObject({
      $schema: expect.stringContaining('json-schema'),
    });

    const versionOutput = output();
    expect(await runCli(['--version'], { cwd: root, io: versionOutput.io })).toBe(0);
    expect(versionOutput.stdout()).toBe('0.1.0\n');
    const recordOutput = output();
    expect(await runCli(['record'], { cwd: root, io: recordOutput.io })).toBe(1);
    expect(recordOutput.stderr()).toContain('Usage: scenebook record');
    expect(await runCli(['does-not-exist'], { cwd: root, io: output().io })).toBe(2);
  });

  it('preserves selected Run checks when accepting a complete baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-cli-baseline-'));
    directories.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'baseline-product' }));
    expect(await runCli(['init'], { cwd: root, io: output().io })).toBe(0);
    const screenshotBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const hash = sha256(screenshotBytes);
    const now = '2026-07-20T12:00:00.000Z';
    const privacy = {
      status: 'clear' as const,
      scannedAt: now,
      scannerVersion: 'test-ocr:1',
      counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
      findings: [],
    };
    const screenshot = {
      sha256: hash,
      path: `assets/${hash}.png`,
      mediaType: 'image/png',
      byteLength: screenshotBytes.byteLength,
      role: 'screenshot' as const,
      width: 1,
      height: 1,
    };
    const run = RunArtifactSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'run-1',
      projectId: 'baseline-product',
      kind: 'run',
      createdAt: now,
      producer: { name: 'test', version: '1.0.0' },
      sceneId: 'invite',
      runTargetId: 'primary',
      repository: { repository: 'acme/product', commit: hash.slice(0, 40) },
      sourceRevision: hash,
      status: 'passed',
      expectedStepIds: ['submit'],
      attempts: [
        {
          id: 'attempt-1',
          index: 0,
          status: 'passed',
          startedAt: now,
          endedAt: now,
          durationMs: 1,
          checks: [
            {
              checkId: 'confirmation-visible',
              stepId: 'submit',
              status: 'passed',
              expected: true,
              actual: true,
              message: 'Confirmation is visible',
            },
          ],
          states: [
            {
              id: 'submit-after',
              sceneId: 'invite',
              stepId: 'submit',
              phase: 'after',
              capturedAt: now,
              route: '/invite',
              viewport: { width: 1280, height: 720 },
              screenshot,
              screenshotHash: hash,
              privacy,
            },
          ],
          privacy,
        },
      ],
      selectedAttemptId: 'attempt-1',
      startedAt: now,
      endedAt: now,
      durationMs: 1,
      privacy,
    });
    const runPath = join(root, 'run.json');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, screenshot.path), screenshotBytes);
    await writeFile(runPath, JSON.stringify(run));
    expect(
      await runCli(['baseline', 'accept', 'run.json', '--actor', 'reviewer', '--yes'], {
        cwd: root,
        io: output().io,
      }),
    ).toBe(0);
    const baseline = BaselineSchema.parse(
      JSON.parse(await readFile(join(root, '.scenebook/baselines/invite/primary.json'), 'utf8')),
    );
    expect(baseline.checks).toEqual(run.attempts[0]?.checks);
    expect(baseline.states[0]!.screenshot.path).toBe(`assets/${hash}.png`);
    await rm(join(root, 'assets'), { recursive: true, force: true });
    await rm(runPath);
    expect(
      await readFile(join(root, '.scenebook/baselines', baseline.states[0]!.screenshot.path)),
    ).toEqual(screenshotBytes);
    expect(reviewRunEvidence(run, baseline).run.changeState).toBe('passed');
  });
});
