import { basename, dirname, relative, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { slugify } from '@scenebook/core';
import { SCHEMA_VERSION, SceneSchema, serializeSceneYaml } from '@scenebook/schema';
import { CliError } from './types.js';

function posixRelative(from: string, to: string): string {
  return relative(from, to).replaceAll('\\', '/');
}

export function recordedSceneDirectory(replayPath: string): string {
  const absolute = resolve(replayPath);
  let cursor = dirname(absolute);
  while (true) {
    if (basename(cursor).endsWith('.scene')) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new CliError(
    'Recorder output must be inside a portable *.scene directory, for example scenes/onboarding.scene/automation/replay.ts.',
  );
}

export async function scaffoldRecordedScene(options: {
  readonly replayPath: string;
  readonly targetHref: string;
  readonly title?: string;
}): Promise<{ readonly manifestPath: string; readonly created: boolean }> {
  const sceneDirectory = recordedSceneDirectory(options.replayPath);
  const manifestPath = resolve(sceneDirectory, 'scene.yaml');
  try {
    await readFile(manifestPath);
    return { manifestPath, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const directoryName = basename(sceneDirectory, '.scene');
  const id = slugify(directoryName || 'recorded-flow');
  if (!id) throw new CliError('The recorder Scene directory needs a usable name before .scene.');
  const replayPath = posixRelative(sceneDirectory, resolve(options.replayPath));
  if (!replayPath || replayPath.startsWith('../')) {
    throw new CliError('The Playwright replay must stay inside its portable Scene directory.');
  }
  const target = new URL(options.targetHref);
  const title = options.title?.trim() || `Recorded ${target.hostname} flow`;
  const scene = SceneSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id,
    slug: id,
    title,
    description: 'A controlled Playwright recording draft ready for semantic steps and evidence.',
    status: 'draft',
    capability: 'captured',
    steps: [
      {
        id: 'review-recording',
        kind: 'intro',
        title: 'Review the recorded flow',
        instruction:
          'Replace this draft card with semantic browser steps and captured states before publication.',
        source: { path: replayPath, line: 1 },
      },
    ],
    automation: { level: 'none', framework: 'playwright', replayPath },
    metadata: {
      recorder: 'playwright-codegen',
      recordingOrigin: target.origin,
    },
  });
  try {
    await writeFile(manifestPath, serializeSceneYaml(scene), { flag: 'wx' });
    return { manifestPath, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { manifestPath, created: false };
    }
    throw error;
  }
}
