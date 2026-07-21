import { readFile } from 'node:fs/promises';
import { createDeterministicId, sha256, stableStringify } from '@scenebook/core';
import { SceneSchema, serializeSceneYaml, type AssetRef, type Scene } from '@scenebook/schema';
import { strToU8 } from 'fflate';
import sharp from 'sharp';
import { canonicalJson, writeOutputFile } from './io.js';
import { mapPresentationRect, presentationAsset, renderPresentation } from './presentation.js';
import { deterministicRemixArchive } from './remix-archive.js';
import type { NormalizedStep, SceneAdapterContext, SceneOutputAdapter } from './types.js';

interface RemixAsset {
  readonly asset: AssetRef;
  readonly bytes: Uint8Array;
}

function stateId(context: SceneAdapterContext, step: NormalizedStep, phase: string): string {
  return createDeterministicId('state', `${context.scene.id}:${step.id}:public:${phase}`, 20);
}

async function flattenedAsset(
  context: SceneAdapterContext,
  step: NormalizedStep,
  secondary = false,
): Promise<RemixAsset> {
  const outputPath = await presentationAsset(context, step, 'interactive', { secondary });
  const bytes = await readFile(`${context.outputDirectory}/${outputPath}`);
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Cannot determine public remix dimensions for Scene ${context.scene.id}.`);
  }
  const digest = sha256(bytes);
  return {
    asset: {
      sha256: digest,
      path: `assets/${digest}.png`,
      mediaType: 'image/png',
      byteLength: bytes.byteLength,
      role: 'screenshot',
      width: metadata.width,
      height: metadata.height,
    },
    bytes,
  };
}

async function publicRemixScene(context: SceneAdapterContext): Promise<{
  readonly scene: Scene;
  readonly assets: ReadonlyMap<string, RemixAsset>;
}> {
  const assets = new Map<string, RemixAsset>();
  const steps: Scene['steps'] = [];
  for (const step of context.scene.steps) {
    let primary: RemixAsset | undefined;
    let secondary: RemixAsset | undefined;
    if (step.imageReference) {
      primary = await flattenedAsset(context, step);
      assets.set(primary.asset.path, primary);
    }
    if (step.secondaryImageReference) {
      secondary = await flattenedAsset(context, step, true);
      assets.set(secondary.asset.path, secondary);
    }
    const rendered = primary ? await renderPresentation(context, step, 'interactive') : undefined;
    const target =
      step.target && rendered
        ? mapPresentationRect(step, step.target, rendered.contentWidth, rendered.contentHeight)
        : undefined;
    steps.push({
      id: step.id,
      kind: (step.kind === 'browser' && !primary
        ? 'explanation'
        : step.kind) as Scene['steps'][number]['kind'],
      title: step.title,
      ...(step.instruction ? { instruction: step.instruction } : {}),
      ...(step.caption ? { caption: step.caption } : {}),
      ...(step.altText ? { altText: step.altText } : {}),
      states: {
        ...(primary
          ? {
              before: {
                id: stateId(context, step, 'before'),
                route: '/',
                screenshot: primary.asset,
                viewport: {
                  width: primary.asset.width!,
                  height: primary.asset.height!,
                  deviceScaleFactor: 1,
                  isMobile: false,
                },
                scroll: { x: 0, y: 0 },
              },
            }
          : {}),
        ...(secondary
          ? {
              after: {
                id: stateId(context, step, 'after'),
                route: '/',
                screenshot: secondary.asset,
                viewport: {
                  width: secondary.asset.width!,
                  height: secondary.asset.height!,
                  deviceScaleFactor: 1,
                  isMobile: false,
                },
                scroll: { x: 0, y: 0 },
              },
            }
          : {}),
      },
      ...(target
        ? {
            target: {
              ...(step.target?.role ? { role: step.target.role } : {}),
              ...(step.target?.label ? { accessibleName: step.target.label } : {}),
              selectors: [],
              normalizedRect: target,
              visible: true,
              occluded: false,
            },
          }
        : {}),
      actions: [],
      checks: [],
      presentation: {
        durationMs: step.durationMs,
        annotations: [],
        autoAdvance: step.autoAdvance,
        transition: step.transition,
        state: secondary ? 'both' : 'before',
        visibility: step.visibility,
        practiceMode: Boolean(step.practiceMode && target),
        frame: { kind: 'none', showAddressBar: false },
      },
      masks: [],
      choices: step.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        ...(choice.description ? { description: choice.description } : {}),
        targetSceneId: choice.targetSceneId,
        ...(choice.targetStepId ? { targetStepId: choice.targetStepId } : {}),
      })),
      ctas: step.ctas.map((cta) => ({
        id: cta.id,
        variant: cta.variant,
        kind: cta.kind,
        label: cta.label,
        ...(cta.url ? { url: cta.url } : {}),
        ...(cta.targetSceneId ? { targetSceneId: cta.targetSceneId } : {}),
        ...(cta.webhookId ? { webhookId: cta.webhookId } : {}),
        fields: cta.fields.map((field) => ({ ...field })),
      })),
      ...(step.cta
        ? {
            cta: {
              kind: step.cta.kind,
              label: step.cta.label,
              ...(step.cta.url ? { url: step.cta.url } : {}),
              ...(step.cta.targetSceneId ? { targetSceneId: step.cta.targetSceneId } : {}),
              ...(step.cta.webhookId ? { webhookId: step.cta.webhookId } : {}),
              fields: step.cta.fields.map((field) => ({ ...field })),
            },
          }
        : {}),
    });
  }
  return {
    scene: SceneSchema.parse({
      schemaVersion: 1,
      id: context.scene.id,
      title: context.scene.title,
      slug: context.scene.slug,
      ...(context.scene.description ? { description: context.scene.description } : {}),
      status: 'published',
      capability: 'captured',
      criticality: context.loaded.scene.criticality,
      audience: [],
      tags: [...context.scene.tags],
      defaultLocale: context.scene.locale,
      locales: [],
      ...(Object.keys(context.scene.theme).length > 0
        ? { theme: { variables: { ...context.scene.theme } } }
        : {}),
      steps,
      assets: [...assets.values()]
        .map((entry) => entry.asset)
        .sort((left, right) => left.path.localeCompare(right.path)),
      automation: { level: 'none' },
      metadata: {
        scenebookPublicRemix: {
          format: 'flattened-publication-source',
          version: 1,
          sourceRevision: sha256(stableStringify(context.loaded.scene)),
          privacyBasis: 'post-publication-mask',
        },
      },
    }),
    assets,
  };
}

export const remixSourceAdapter: SceneOutputAdapter = {
  format: 'remix-source',
  async render(context) {
    const root = `remix/${context.scene.slug}.scene`;
    const archivePath = `remix/${context.scene.slug}.scene.zip`;
    const { scene, assets } = await publicRemixScene(context);
    const source = strToU8(serializeSceneYaml(scene));
    const readme = strToU8(
      `# ${context.scene.title}\n\nPublic remix source generated from privacy-gated publication derivatives. Import this ZIP in Scenebook Studio. Visual presentation is flattened so private routes, selectors, automation, checks, and raw captures are not redistributed.\n`,
    );
    const files = new Map<string, Uint8Array>([
      ['README.md', readme],
      ['scene.yaml', source],
    ]);
    for (const entry of assets.values()) files.set(entry.asset.path, entry.bytes);
    const inventory = {
      format: 'scenebook-public-remix-integrity',
      version: 1,
      sceneId: context.scene.id,
      sourceRevision: sha256(stableStringify(context.loaded.scene)),
      entries: [...files.entries()]
        .map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.byteLength }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    files.set('INTEGRITY.json', strToU8(canonicalJson(inventory)));
    const outputs: string[] = [];
    for (const [path, bytes] of [...files.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      outputs.push(await writeOutputFile(context.outputDirectory, `${root}/${path}`, bytes));
    }
    outputs.push(
      await writeOutputFile(context.outputDirectory, archivePath, deterministicRemixArchive(files)),
    );
    return outputs;
  },
};
