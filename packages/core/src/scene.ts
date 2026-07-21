import {
  canonicalStepCtas,
  SceneSchema,
  type AssetRef,
  type Scene,
  type SceneCapability,
} from '@scenebook/schema';

import { canonicalJsonHash } from './canonical.js';
import { InvariantError } from './errors.js';

export function assertSceneInvariants(input: unknown): Scene {
  const scene = SceneSchema.parse(input);
  for (const step of scene.steps) {
    for (const choice of step.choices) {
      if (choice.targetSceneId === scene.id) {
        throw new InvariantError(
          'A Scene cannot branch to itself; executable and presentation paths must be acyclic',
          {
            sceneId: scene.id,
            stepId: step.id,
            choiceId: choice.id,
          },
        );
      }
    }
  }
  return scene;
}

export function collectAssetReferences(scene: Scene): AssetRef[] {
  const assets = new Map<string, AssetRef>();
  const add = (asset: AssetRef | undefined): void => {
    if (!asset) return;
    const existing = assets.get(asset.sha256);
    if (
      existing &&
      (existing.path !== asset.path ||
        existing.mediaType !== asset.mediaType ||
        existing.byteLength !== asset.byteLength)
    ) {
      throw new InvariantError(`Conflicting references for asset ${asset.sha256}`, {
        first: existing,
        second: asset,
      });
    }
    assets.set(asset.sha256, asset);
  };
  for (const asset of scene.assets) add(asset);
  for (const step of scene.steps) {
    add(step.states.before?.screenshot);
    add(step.states.after?.screenshot);
  }
  return [...assets.values()].sort((left, right) => left.sha256.localeCompare(right.sha256));
}

export function collectSceneLinks(scene: Scene): string[] {
  const links = new Set<string>();
  for (const step of scene.steps) {
    for (const choice of step.choices) links.add(choice.targetSceneId);
    for (const cta of canonicalStepCtas(step)) {
      if (cta.targetSceneId) links.add(cta.targetSceneId);
    }
  }
  return [...links].sort();
}

export function assertSceneGraph(
  scenes: readonly Scene[],
  options: { readonly allowExternalSceneIds?: readonly string[] } = {},
): void {
  const byId = new Map<string, Scene>();
  for (const scene of scenes) {
    const parsed = assertSceneInvariants(scene);
    if (byId.has(parsed.id)) throw new InvariantError(`Duplicate Scene id: ${parsed.id}`);
    byId.set(parsed.id, parsed);
  }
  const external = new Set(options.allowExternalSceneIds ?? []);
  for (const scene of byId.values()) {
    for (const linkedId of collectSceneLinks(scene)) {
      if (!byId.has(linkedId) && !external.has(linkedId)) {
        throw new InvariantError(`Scene ${scene.id} links to unknown Scene ${linkedId}`, {
          sceneId: scene.id,
          targetSceneId: linkedId,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sceneId: string, path: readonly string[]): void => {
    if (visiting.has(sceneId)) {
      const cycleStart = path.indexOf(sceneId);
      const cycle = [...path.slice(Math.max(0, cycleStart)), sceneId];
      throw new InvariantError(`Presentation branch cycle detected: ${cycle.join(' -> ')}`, {
        cycle,
      });
    }
    if (visited.has(sceneId)) return;
    const scene = byId.get(sceneId);
    if (!scene) return;
    visiting.add(sceneId);
    for (const linkedId of collectSceneLinks(scene)) {
      if (byId.has(linkedId)) visit(linkedId, [...path, sceneId]);
    }
    visiting.delete(sceneId);
    visited.add(sceneId);
  };
  for (const sceneId of byId.keys()) visit(sceneId, []);
}

export function sceneSourceRevision(scene: Scene): string {
  return canonicalJsonHash(SceneSchema.parse(scene));
}

export function deriveSceneCapability(scene: Scene): SceneCapability {
  if (scene.automation.level === 'verified') return 'verified';
  if (scene.automation.level === 'monitored') return 'monitored';
  return 'captured';
}

export function assertSceneCapabilityConsistent(scene: Scene): void {
  const actual = deriveSceneCapability(scene);
  if (actual !== scene.capability) {
    throw new InvariantError(
      `Scene capability ${scene.capability} does not match automation level ${scene.automation.level}`,
      {
        sceneId: scene.id,
        declared: scene.capability,
        derived: actual,
      },
    );
  }
}

export function getStep(scene: Scene, stepId: string) {
  const step = scene.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new InvariantError(`Unknown Step: ${stepId}`, { sceneId: scene.id, stepId });
  return step;
}
