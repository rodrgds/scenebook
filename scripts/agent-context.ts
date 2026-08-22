import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  changedPaths,
  currentBranch,
  groupPaths,
  recommendedChecks,
  workspaceRoot,
} from './agent-tools';

const options = new Set(process.argv.slice(2).filter((arg) => arg !== '--'));
for (const option of options) {
  if (option !== '--paths') throw new Error(`Unknown option ${option}`);
}

const manifest = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')) as {
  engines?: { node?: string };
  packageManager?: string;
};
const paths = await changedPaths();
const groups = groupPaths(paths);

console.log('Scenebook agent context');
console.log(`branch: ${await currentBranch()}`);
console.log(
  `runtime: Bun ${Bun.version} (required ${manifest.packageManager ?? 'version not declared'}); Node ${process.version} (required ${manifest.engines?.node ?? 'version not declared'})`,
);
console.log(`worktree: ${paths.length} changed path${paths.length === 1 ? '' : 's'}`);

if (groups.size > 0) {
  console.log('areas:');
  for (const [area, count] of groups) console.log(`  - ${area}: ${count}`);
}

console.log('next checks:');
for (const check of recommendedChecks(paths)) console.log(`  - ${check}`);

if (options.has('--paths') && paths.length > 0) {
  console.log('paths:');
  for (const path of paths) console.log(`  - ${path}`);
}
