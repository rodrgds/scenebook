import type { SceneDefinition } from '@scenebook/viewer';

declare global {
  namespace App {}

  interface HTMLElementTagNameMap {
    'scenebook-player': HTMLElement & {
      scene: SceneDefinition;
      scenes: Record<string, SceneDefinition>;
      currentStep: number;
    };
  }
}

export {};
