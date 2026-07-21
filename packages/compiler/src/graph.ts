import type { NormalizedScene } from './types.js';

export function validateSceneGraph(scenes: readonly NormalizedScene[]): void {
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const edges = new Map<string, Set<string>>();

  for (const scene of scenes) {
    const targets = new Set<string>();
    for (const step of scene.steps) {
      for (const choice of step.choices) {
        const target = byId.get(choice.targetSceneId);
        if (!target) {
          throw new Error(
            `Scene ${scene.id} Step ${step.id} choice ${choice.id} links to unknown Scene ${choice.targetSceneId}.`,
          );
        }
        if (
          choice.targetStepId &&
          !target.steps.some((candidate) => candidate.id === choice.targetStepId)
        ) {
          throw new Error(
            `Scene ${scene.id} Step ${step.id} choice ${choice.id} links to unknown Step ${choice.targetSceneId}#${choice.targetStepId}.`,
          );
        }
        targets.add(choice.targetSceneId);
      }
      for (const cta of step.ctas) {
        if (cta.kind === 'view-scene' && cta.targetSceneId && !byId.has(cta.targetSceneId)) {
          throw new Error(
            `Scene ${scene.id} Step ${step.id} CTA ${cta.id} links to unknown Scene ${cta.targetSceneId}.`,
          );
        }
      }
    }
    edges.set(scene.id, targets);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (sceneId: string): void => {
    if (visited.has(sceneId)) return;
    if (visiting.has(sceneId)) {
      const start = stack.indexOf(sceneId);
      const cycle = [...stack.slice(start), sceneId];
      throw new Error(`Presentation branch graph contains a loop: ${cycle.join(' → ')}.`);
    }
    visiting.add(sceneId);
    stack.push(sceneId);
    for (const target of edges.get(sceneId) ?? []) visit(target);
    stack.pop();
    visiting.delete(sceneId);
    visited.add(sceneId);
  };

  for (const scene of scenes) visit(scene.id);
}
