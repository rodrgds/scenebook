import type {
  NormalizedRect,
  PrivacySummary,
  ReviewChange,
  SemanticProjection,
  Target,
} from '@scenebook/schema';

export interface FunctionalCheckSnapshot {
  readonly id: string;
  readonly stepId: string;
  readonly status: 'passed' | 'failed' | 'blocked' | 'cancelled' | 'skipped';
  readonly message?: string;
}

export interface FunctionalSnapshot {
  readonly status: 'passed' | 'failed' | 'blocked' | 'cancelled' | 'skipped';
  readonly checks: readonly FunctionalCheckSnapshot[];
}

export interface VisualSnapshot {
  readonly contentHash: string;
  readonly perceptualHash?: string;
  readonly width: number;
  readonly height: number;
  readonly rgba?: Uint8Array;
}

export interface GeometrySnapshot {
  readonly rect?: NormalizedRect;
  readonly visible: boolean;
  readonly occluded: boolean;
}

export interface EvidenceStateSnapshot {
  readonly id: string;
  readonly stepId: string;
  readonly phase: 'before' | 'after';
  readonly visual: VisualSnapshot;
  readonly semantic?: SemanticProjection;
  readonly geometry?: GeometrySnapshot;
  readonly privacy: PrivacySummary;
}

export interface NarrativeStepSnapshot {
  readonly stepId: string;
  readonly title?: string;
  readonly instruction?: string;
  readonly caption?: string;
  readonly altText?: string;
  readonly hash?: string;
}

export interface SceneEvidenceSnapshot {
  readonly sceneId: string;
  readonly functional: FunctionalSnapshot;
  readonly states: readonly EvidenceStateSnapshot[];
  readonly narrativeRevision?: string;
  readonly narrative: readonly NarrativeStepSnapshot[];
  readonly privacy: PrivacySummary;
}

export interface RgbaDiffMetrics {
  readonly changedPixels: number;
  readonly changedRatio: number;
  readonly meanDelta: number;
  readonly maximumDelta: number;
}

export interface DiffOptions {
  readonly pixelThreshold?: number;
  readonly changedPixelRatio?: number;
  readonly perceptualDistance?: number;
  readonly geometryDistance?: number;
  readonly narrativeSimilarity?: number;
}

export interface SceneDiffResult {
  readonly state: 'passed' | 'changed' | 'broken' | 'blocked';
  readonly changes: readonly ReviewChange[];
  readonly dimensions: Readonly<
    Record<'functional' | 'visual' | 'semantic' | 'geometry' | 'narrative' | 'privacy', number>
  >;
}

export interface RectDelta {
  readonly centerDistance: number;
  readonly widthDelta: number;
  readonly heightDelta: number;
  readonly areaRatio: number;
}

export function geometryFromTarget(target: Target | undefined): GeometrySnapshot | undefined {
  if (!target) return undefined;
  return { rect: target.normalizedRect, visible: target.visible, occluded: target.occluded };
}
