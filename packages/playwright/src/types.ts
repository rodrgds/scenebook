import type { Locator, Page, TestInfo } from '@playwright/test';
import type { PrivacySummary, SemanticProjection, Target, Viewport } from '@scenebook/schema';

export interface SceneMetadata {
  readonly id?: string;
  readonly audience?: string | readonly string[];
  readonly tags?: readonly string[];
  readonly criticality?: 'low' | 'normal' | 'important' | 'critical';
  readonly description?: string;
}

export type MaskInput = Locator | string;

export interface BeatOptions {
  readonly title?: string;
  readonly instruction?: string;
  readonly target?: Locator;
  readonly targetSelector?: string;
  readonly masks?: readonly MaskInput[];
  readonly capture?: 'both' | 'before' | 'after';
  readonly timeout?: number;
}

export type Beat = <T>(id: string, options: BeatOptions, action: () => Promise<T>) => Promise<T>;
/** Primary public term for an authored Scene interaction. */
export type Step = Beat;

export interface ScenebookFixtureOptions {
  readonly automaticMasks: boolean;
  readonly maskColor: string;
  readonly captureSemanticProjection: boolean;
  readonly animations: 'allow' | 'disabled';
  readonly scale: 'css' | 'device';
}

export interface ScenebookFixtures {
  readonly step: Step;
  /** Compatibility alias for early Scenebook integrations. */
  readonly beat: Beat;
  readonly scenebook: {
    readonly page: Page;
    readonly testInfo: TestInfo;
  };
  readonly scenebookOptions: ScenebookFixtureOptions;
}

export interface CapturedStateMetadata {
  readonly version: 1;
  readonly sceneId: string;
  readonly stepId: string;
  readonly phase: 'before' | 'after';
  readonly capturedAt: string;
  readonly route: string;
  readonly viewport: Viewport;
  readonly screenshotHash: string;
  readonly screenshotAttachment: string;
  readonly masksApplied: readonly string[];
  /** Structured capture scan; exact screenshot OCR may leave this `unknown`. */
  readonly privacy?: PrivacySummary;
  readonly target?: Target;
  readonly semantic?: SemanticProjection;
}

export interface CapturedBeatMetadata {
  readonly version: 1;
  readonly sceneId: string;
  readonly stepId: string;
  readonly title: string;
  readonly instruction?: string;
  readonly states: readonly CapturedStateMetadata[];
}

export interface ImportedPlaywrightStep {
  readonly id: string;
  readonly title: string;
  readonly line: number;
  readonly column: number;
}

export interface ImportedPlaywrightScene {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly line: number;
  readonly steps: readonly ImportedPlaywrightStep[];
}
