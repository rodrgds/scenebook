import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { changedPaths, uiTargets, workspaceRoot, workspaceTarget } from './agent-tools';

const requested = process.argv
  .slice(2)
  .filter((arg) => arg !== '--')
  .map(workspaceTarget);
const targets = requested.length > 0 ? requested : uiTargets(await changedPaths());

if (targets.length === 0) {
  console.log(
    'No changed UI files found. Pass explicit repository paths to scan a broader surface.',
  );
  process.exit(0);
}

const detector = join(workspaceRoot, '.agents/skills/impeccable/scripts/detect.mjs');
if (!existsSync(detector)) throw new Error(`Impeccable detector not found at ${detector}`);

console.log(
  `Running all Impeccable detector scopes over ${targets.length} ${requested.length > 0 ? 'requested target' : 'changed UI file'}${targets.length === 1 ? '' : 's'}.`,
);

for (const scope of [undefined, 'type', 'layout'] as const) {
  const args = [detector, '--json', ...(scope ? ['--scope', scope] : []), ...targets];
  const child = Bun.spawn(['node', ...args], {
    cwd: workspaceRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Impeccable ${scope ?? 'quality'} detector exited ${exitCode}`);
  }
}
