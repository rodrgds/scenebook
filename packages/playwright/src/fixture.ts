import { expect, test as base } from '@playwright/test';
import { isValidId, slugify } from '@scenebook/core';
import { fileURLToPath } from 'node:url';
import { captureState } from './capture.js';
import type {
  Beat,
  CapturedBeatMetadata,
  CapturedStateMetadata,
  SceneMetadata,
  ScenebookFixtures,
} from './types.js';

const FIXTURE_FILE = fileURLToPath(import.meta.url);

function sceneDefinitionLocation():
  { readonly file: string; readonly line: number; readonly column: number } | undefined {
  for (const frame of new Error().stack?.split('\n').slice(1) ?? []) {
    const match = frame.match(/\((.+):(\d+):(\d+)\)$/u) ?? frame.match(/at (.+):(\d+):(\d+)$/u);
    if (!match) continue;
    const rawFile = match[1]!;
    if (rawFile.startsWith('node:')) continue;
    let file: string;
    try {
      file = rawFile.startsWith('file://') ? fileURLToPath(rawFile) : rawFile;
    } catch {
      continue;
    }
    if (file === FIXTURE_FILE || file.includes('/node_modules/')) continue;
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (Number.isInteger(line) && line > 0 && Number.isInteger(column) && column > 0) {
      return { file, line, column };
    }
  }
  return undefined;
}

function sceneAnnotation(annotations: readonly { type: string; description?: string }[]): {
  id: string;
  title?: string;
} {
  const annotation = annotations.find((candidate) => candidate.type === 'scenebook:scene');
  if (!annotation?.description) return { id: 'scene' };
  try {
    const parsed = JSON.parse(annotation.description) as { id?: string; title?: string };
    return {
      id: parsed.id ?? slugify(parsed.title ?? 'scene'),
      ...(parsed.title ? { title: parsed.title } : {}),
    };
  } catch {
    return { id: 'scene' };
  }
}

export const test = base.extend<ScenebookFixtures>({
  scenebookOptions: [
    {
      automaticMasks: true,
      maskColor: '#151515',
      captureSemanticProjection: true,
      animations: 'disabled',
      scale: 'css',
    },
    { option: true },
  ],
  scenebook: async ({ page }, use, testInfo) => {
    await use({ page, testInfo });
  },
  beat: async ({ page, scenebookOptions }, use, testInfo) => {
    const scene = sceneAnnotation(testInfo.annotations);
    let counter = 0;
    const beat: Beat = async (id, options, action) => {
      counter += 1;
      const stepId = slugify(id, `step-${counter}`);
      const title = options.title ?? id;
      const states: CapturedStateMetadata[] = [];
      if (options.capture !== 'after') {
        states.push(
          await captureState(page, testInfo, scene.id, stepId, 'before', options, scenebookOptions),
        );
      }
      let result: Awaited<ReturnType<typeof action>> | undefined;
      let actionError: unknown;
      try {
        result = await test.step(title, action, { timeout: options.timeout });
      } catch (error) {
        actionError = error;
      }
      if (options.capture !== 'before' && !page.isClosed()) {
        try {
          states.push(
            await captureState(
              page,
              testInfo,
              scene.id,
              stepId,
              'after',
              options,
              scenebookOptions,
            ),
          );
        } catch (captureError) {
          if (actionError === undefined) throw captureError;
        }
      }
      const metadata: CapturedBeatMetadata = {
        version: 1,
        sceneId: scene.id,
        stepId,
        title,
        ...(options.instruction ? { instruction: options.instruction } : {}),
        states,
      };
      await testInfo.attach(`scenebook-beat-${String(counter).padStart(4, '0')}-${stepId}.json`, {
        body: Buffer.from(JSON.stringify(metadata)),
        contentType: 'application/vnd.scenebook.beat+json',
      });
      if (actionError !== undefined) throw actionError;
      return result as Awaited<ReturnType<typeof action>>;
    };
    await use(beat);
  },
  step: async ({ beat }, use) => {
    await use(beat);
  },
});

export function scene(
  title: string,
  metadata: SceneMetadata,
  body: Parameters<typeof test>[2],
): void {
  if (metadata.id && !isValidId(metadata.id)) {
    throw new Error(
      `Invalid Scene id "${metadata.id}". Use lowercase letters, numbers, dots, colons, underscores, or hyphens.`,
    );
  }
  const id = metadata.id ?? slugify(title);
  const tags = ['@scenebook', ...(metadata.tags ?? []).map((tag) => `@${slugify(tag)}`)];
  const definition = sceneDefinitionLocation();
  test(
    title,
    {
      tag: tags,
      annotation: [
        {
          type: 'scenebook:scene',
          description: JSON.stringify({
            ...metadata,
            id,
            title,
            ...(definition ? { definition } : {}),
          }),
        },
      ],
    },
    body,
  );
}

export { expect };
