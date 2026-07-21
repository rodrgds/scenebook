import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { UnsafePathError } from './errors.js';

export interface SceneDirectoryLayout {
  readonly root: string;
  readonly sceneFile: string;
  readonly narrativeFile: string;
  readonly themeFile: string;
  readonly localesDirectory: string;
  readonly assetsDirectory: string;
  readonly automationDirectory: string;
  readonly replayFile: string;
}

export function assertPathInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relation = relative(resolvedRoot, resolvedCandidate);
  if (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  ) {
    return resolvedCandidate;
  }
  throw new UnsafePathError(candidate, root);
}

export function resolveSceneDirectoryLayout(root: string): SceneDirectoryLayout {
  const resolvedRoot = resolve(root);
  return {
    root: resolvedRoot,
    sceneFile: resolve(resolvedRoot, 'scene.yaml'),
    narrativeFile: resolve(resolvedRoot, 'narrative.mdx'),
    themeFile: resolve(resolvedRoot, 'theme.yaml'),
    localesDirectory: resolve(resolvedRoot, 'locales'),
    assetsDirectory: resolve(resolvedRoot, 'assets'),
    automationDirectory: resolve(resolvedRoot, 'automation'),
    replayFile: resolve(resolvedRoot, 'automation/replay.ts'),
  };
}

export function containingSceneDirectory(sceneFile: string): string {
  return dirname(resolve(sceneFile));
}
