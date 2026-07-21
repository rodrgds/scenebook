import type { PlayerSnapshot, SceneChoice, SceneDefinition } from './types.js';

export function clampIndex(scene: SceneDefinition, index: number): number {
  try {
    if (!Array.isArray(scene.steps) || scene.steps.length === 0) return 0;
    const finiteIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
    return Math.max(0, Math.min(finiteIndex, scene.steps.length - 1));
  } catch {
    return 0;
  }
}

export function findStepIndex(scene: SceneDefinition, step: string | number | null): number {
  try {
    if (typeof step === 'number' && Number.isFinite(step)) return clampIndex(scene, step);
    if (typeof step === 'string') {
      const numeric = Number(step);
      if (Number.isInteger(numeric) && step.trim() !== '') return clampIndex(scene, numeric);
      if (!Array.isArray(scene.steps)) return 0;
      const index = scene.steps.findIndex(
        (candidate) => typeof candidate === 'object' && candidate !== null && candidate.id === step,
      );
      if (index >= 0) return index;
    }
  } catch {
    return 0;
  }
  return 0;
}

export function snapshot(scene: SceneDefinition, index: number): PlayerSnapshot {
  const steps = (() => {
    try {
      return Array.isArray(scene.steps) ? scene.steps : [];
    } catch {
      return [];
    }
  })();
  const safeIndex = clampIndex(scene, index);
  const total = steps.length;
  const step = steps[safeIndex];
  const validStep = typeof step === 'object' && step !== null ? step : undefined;
  const complete = total > 0 && safeIndex === total - 1 && validStep?.type === 'end';

  return {
    index: safeIndex,
    stepId: typeof validStep?.id === 'string' ? validStep.id : null,
    total,
    progress: total === 0 ? 0 : (safeIndex + 1) / total,
    canGoBack: safeIndex > 0,
    canGoForward:
      total > 0 &&
      safeIndex < total - 1 &&
      validStep?.type !== 'choice' &&
      !validStep?.practiceMode,
    complete,
  };
}

export function resolveChoice(
  choice: SceneChoice,
  scenes: Readonly<Record<string, SceneDefinition>>,
): { scene: SceneDefinition; stepIndex: number } | null {
  try {
    if (!choice || typeof choice.sceneId !== 'string') return null;
    const target = scenes[choice.sceneId];
    if (!target) return null;
    return {
      scene: target,
      stepIndex: choice.stepId ? findStepIndex(target, choice.stepId) : 0,
    };
  } catch {
    return null;
  }
}

export function validateScene(
  scene: SceneDefinition,
  scenes: Readonly<Record<string, SceneDefinition>> = {},
): string[] {
  try {
    return validateSceneData(scene, scenes);
  } catch {
    return ['Scene data is malformed.'];
  }
}

function validateSceneData(
  scene: SceneDefinition,
  scenes: Readonly<Record<string, SceneDefinition>>,
): string[] {
  const errors: string[] = [];
  if (typeof scene !== 'object' || scene === null) return ['Scene data must be an object.'];
  if (typeof scene.id !== 'string') errors.push('Scene id must be text.');
  if (typeof scene.title !== 'string') errors.push('Scene title must be text.');
  if (!Array.isArray(scene.steps)) {
    errors.push('Scene steps must be an array.');
    return errors;
  }
  if (errors.length > 0) return errors;
  if (!scene.id.trim()) errors.push('Scene id is required.');
  if (!scene.title.trim()) errors.push('Scene title is required.');
  if (scene.steps.length === 0) errors.push('A scene needs at least one step.');

  const ids = new Set<string>();
  for (const step of scene.steps) {
    if (typeof step !== 'object' || step === null) {
      errors.push('Every step must be an object.');
      continue;
    }
    if (typeof step.id !== 'string') {
      errors.push('Every step id must be text.');
      continue;
    }
    if (typeof step.title !== 'string') {
      errors.push(`Step ${step.id || '(unknown)'} title must be text.`);
      continue;
    }
    if (!step.id.trim()) errors.push('Every step needs an id.');
    if (ids.has(step.id)) errors.push(`Duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (!step.title.trim()) errors.push(`Step ${step.id || '(unknown)'} needs a title.`);
    if (step.type === 'choice' && !step.choices?.length) {
      errors.push(`Choice step ${step.id} needs at least one option.`);
    }
    if (step.choices !== undefined && !Array.isArray(step.choices)) {
      errors.push(`Step ${step.id} choices must be an array.`);
    }
    if (step.ctas !== undefined && !Array.isArray(step.ctas)) {
      errors.push(`Step ${step.id} CTAs must be an array.`);
    }
    if (step.masks !== undefined && !Array.isArray(step.masks)) {
      errors.push(`Step ${step.id} masks must be an array.`);
    }
    if (step.annotations !== undefined && !Array.isArray(step.annotations)) {
      errors.push(`Step ${step.id} annotations must be an array.`);
    }
  }

  if (errors.length > 0) return errors;

  for (const step of scene.steps) {
    for (const choice of step.choices ?? []) {
      if (!choice.sceneId?.trim()) errors.push(`Choice ${choice.id} needs a target Scene id.`);
      if (choice.sceneId === scene.id) {
        errors.push(`Choice ${choice.id} creates a loop back to Scene ${scene.id}.`);
      }
      const linkedScene = scenes[choice.sceneId];
      if (!linkedScene && !choice.href) {
        errors.push(`Choice ${choice.id} points to unavailable Scene ${choice.sceneId}.`);
      }
      if (
        linkedScene &&
        choice.stepId &&
        !linkedScene.steps.some((candidate) => candidate.id === choice.stepId)
      ) {
        errors.push(
          `Choice ${choice.id} points to missing step ${choice.stepId} in Scene ${choice.sceneId}.`,
        );
      }
    }
  }

  const graph: Record<string, SceneDefinition> = { ...scenes, [scene.id]: scene };
  const visited = new Set<string>();
  const active = new Set<string>();
  const trail: string[] = [];
  let cycle: string[] | null = null;

  const visit = (sceneId: string): void => {
    if (cycle || visited.has(sceneId)) return;
    if (active.has(sceneId)) {
      const start = trail.indexOf(sceneId);
      cycle = [...trail.slice(Math.max(0, start)), sceneId];
      return;
    }
    const current = graph[sceneId];
    if (!current) return;
    active.add(sceneId);
    trail.push(sceneId);
    for (const currentStep of current.steps) {
      for (const choice of currentStep.choices ?? []) {
        if (graph[choice.sceneId]) visit(choice.sceneId);
      }
    }
    trail.pop();
    active.delete(sceneId);
    visited.add(sceneId);
  };

  visit(scene.id);
  const cyclePath = cycle as string[] | null;
  if (cyclePath) errors.push(`Scene choices contain a loop: ${cyclePath.join(' → ')}.`);
  return errors;
}
