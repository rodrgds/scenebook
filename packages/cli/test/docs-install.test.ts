import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scenebook-docs-install-'));
  directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'docs-product' }));
  expect(await runCli(['init'], { cwd: root, io: output().io })).toBe(0);
  return root;
}

describe('docs adapter installation', () => {
  it('previews and installs an exact framework integration idempotently', async () => {
    const root = await project();
    const preview = output();
    expect(
      await runCli(
        [
          'docs',
          'install',
          '--adapter',
          'vitepress',
          '--base-path',
          '/team docs',
          '--destination',
          'website',
          '--dry-run',
        ],
        { cwd: root, io: preview.io },
      ),
    ).toBe(0);
    expect(preview.stdout()).toContain('Would install vitepress');
    await expect(
      readFile(join(root, 'website/.vitepress/theme/Scenebook.vue'), 'utf8'),
    ).rejects.toThrow();

    const installed = output();
    expect(
      await runCli(
        [
          'docs',
          'install',
          '--adapter',
          'vitepress',
          '--base-path',
          '/team docs',
          '--destination',
          'website',
        ],
        { cwd: root, io: installed.io },
      ),
    ).toBe(0);
    expect(installed.stdout()).toContain('3 new, 0 unchanged');
    expect(await readFile(join(root, 'website/.vitepress/theme/Scenebook.vue'), 'utf8')).toContain(
      '/team%20docs/scenebook/index.html',
    );

    const repeated = output();
    expect(
      await runCli(
        [
          'docs',
          'install',
          '--adapter',
          'vitepress',
          '--base-path',
          '/team docs',
          '--destination',
          'website',
        ],
        { cwd: root, io: repeated.io },
      ),
    ).toBe(0);
    expect(repeated.stdout()).toContain('0 new, 3 unchanged');
  });

  it('refuses conflicts, path escape, and symbolic-link destinations', async () => {
    const root = await project();
    await mkdir(join(root, 'components'), { recursive: true });
    await writeFile(join(root, 'components/Scenebook.tsx'), 'export const Mine = true;\n');
    const conflict = output();
    expect(
      await runCli(['docs', 'install', '--adapter', 'nextra'], {
        cwd: root,
        io: conflict.io,
      }),
    ).toBe(1);
    expect(conflict.stderr()).toContain('Refusing to overwrite components/Scenebook.tsx');
    expect(await readFile(join(root, 'components/Scenebook.tsx'), 'utf8')).toBe(
      'export const Mine = true;\n',
    );

    const escaped = output();
    expect(
      await runCli(['docs', 'install', '--adapter', 'nextra', '--destination', '../outside'], {
        cwd: root,
        io: escaped.io,
      }),
    ).toBe(1);
    expect(escaped.stderr()).toContain('destination must stay inside the project');

    if (process.platform !== 'win32') {
      const outside = await mkdtemp(join(tmpdir(), 'scenebook-docs-outside-'));
      directories.push(outside);
      await symlink(outside, join(root, 'linked-docs'));
      const linked = output();
      expect(
        await runCli(['docs', 'install', '--adapter', 'nextra', '--destination', 'linked-docs'], {
          cwd: root,
          io: linked.io,
        }),
      ).toBe(1);
      expect(linked.stderr()).toContain('non-directory or link');
    }
  });
});
