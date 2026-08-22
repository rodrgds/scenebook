import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const UI_EXTENSIONS = new Set(['.css', '.html', '.js', '.jsx', '.scss', '.svelte', '.ts', '.tsx']);
const UI_PREFIXES = [
  'apps/cloud/',
  'apps/example/',
  'apps/extension/',
  'apps/gateway/',
  'apps/studio/',
  'packages/compiler/',
  'packages/gateway/',
  'packages/server/',
  'packages/viewer/',
];

const AREA_PREFIXES = [
  ['apps/studio/', 'Studio'],
  ['apps/extension/', 'Extension'],
  ['apps/example/', 'Example app'],
  ['apps/cloud/', 'Cloud app'],
  ['apps/gateway/', 'Gateway app'],
  ['packages/viewer/', 'Viewer'],
  ['packages/compiler/', 'Compiler'],
  ['packages/server/', 'Server'],
  ['packages/gateway/', 'Gateway'],
  ['packages/playwright/', 'Playwright'],
  ['packages/schema/', 'Schema'],
  ['packages/', 'Other packages'],
  ['examples/acme-product/', 'ACME fixture'],
  ['deploy/', 'Self-hosting'],
  ['docs/', 'Docs'],
  ['scripts/', 'Root tooling'],
] as const;

async function runText(command: string, args: string[], cwd = workspaceRoot): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${exitCode}: ${stderr.trim() || 'no error output'}`,
    );
  }
  return stdout;
}

function nulSeparated(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

export async function changedPaths(): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runText('git', ['diff', '--name-only', '--diff-filter=ACMRD', '-z', 'HEAD', '--']),
    runText('git', ['ls-files', '--others', '--exclude-standard', '-z', '--']),
  ]);
  return [...new Set([...nulSeparated(tracked), ...nulSeparated(untracked)])].sort();
}

export async function currentBranch(): Promise<string> {
  return (await runText('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

function extension(path: string): string {
  const match = /(\.[^./]+)$/u.exec(path);
  return match?.[1]?.toLowerCase() ?? '';
}

export function uiTargets(paths: string[]): string[] {
  return paths.filter(
    (path) =>
      UI_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
      UI_EXTENSIONS.has(extension(path)) &&
      !path.includes('/test/') &&
      !path.includes('/tests/') &&
      !/\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path) &&
      existsSync(resolve(workspaceRoot, path)),
  );
}

export function groupPaths(paths: string[]): Map<string, number> {
  const groups = new Map<string, number>();
  for (const path of paths) {
    const area =
      AREA_PREFIXES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'Root and other files';
    groups.set(area, (groups.get(area) ?? 0) + 1);
  }
  return groups;
}

export function recommendedChecks(paths: string[]): string[] {
  const checks: string[] = [];
  if (paths.length === 0) return ['No worktree changes detected.'];

  checks.push(
    `Preserve the existing ${paths.length} changed path${paths.length === 1 ? '' : 's'}; inspect overlap before editing.`,
  );
  if (uiTargets(paths).length > 0) {
    checks.push(
      'UI paths changed: run bun run check:ui, then browser-check every affected surface.',
    );
  }
  if (paths.some((path) => path.startsWith('packages/'))) {
    checks.push(
      'Public package paths changed: confirm whether a Changeset is required with bun run changeset status.',
    );
  }
  if (
    paths.some(
      (path) =>
        path.startsWith('packages/server/') ||
        path.startsWith('packages/gateway/') ||
        path.startsWith('packages/playwright/test/backend.integration') ||
        path.startsWith('deploy/'),
    )
  ) {
    checks.push(
      'Hosted/backend paths changed: use the disposable PostgreSQL/MinIO gate when the change crosses its contract.',
    );
  }
  if (
    paths.some(
      (path) =>
        path.startsWith('examples/acme-product/') || path === 'scripts/build-example-scene.ts',
    )
  ) {
    checks.push(
      'Fixture paths changed: run bun run example:test; bun run example:seed mutates committed evidence.',
    );
  }
  return checks;
}

export function workspaceTarget(input: string): string {
  const absolute = resolve(workspaceRoot, input);
  const path = relative(workspaceRoot, absolute);
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`UI target must stay inside ${workspaceRoot}: ${input}`);
  }
  return path || '.';
}
