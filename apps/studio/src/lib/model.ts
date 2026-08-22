import type {
  Mask,
  PlayerStep,
  SceneChoice,
  SceneCta,
  SceneDefinition,
  StepKind,
} from '@scenebook/viewer';
import type {
  Baseline,
  Cta as PortableCta,
  Review,
  RunArtifact,
  Scene as PortableScene,
} from '@scenebook/schema';

export type RunStatus = 'passed' | 'changed' | 'broken' | 'blocked' | 'stale';
export type Capability = 'captured' | 'monitored' | 'verified';
export type OutputKind = 'interactive' | 'guide' | 'motion' | 'social';

interface CropState {
  x: number;
  y: number;
  zoom: number;
}

interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  click: boolean;
  path?: CursorKeyframe[];
  clickAtMs?: number;
  style?: 'default' | 'pointer' | 'dot';
}

interface CursorKeyframe {
  atMs: number;
  x: number;
  y: number;
}

export interface EditorAnnotation {
  id: string;
  /** Center point for rectangles and arrow destination for arrows. */
  x: number;
  y: number;
  text: string;
  kind: 'callout' | 'note' | 'spotlight' | 'arrow';
  width?: number;
  height?: number;
  fromX?: number;
  fromY?: number;
  color?: string;
}

interface OutputVisibility {
  interactive: boolean;
  guide: boolean;
  motion: boolean;
  social: boolean;
}

interface StepTranslation {
  title?: string;
  instruction?: string;
  caption?: string;
  alt?: string;
}

interface SceneTranslation {
  title?: string;
  description?: string;
  steps: Record<string, StepTranslation>;
}

/**
 * Immutable, schema-validated execution evidence imported from a Scenebook Run bundle.
 *
 * Studio never derives this structure from authored Scene source. The importer verifies the exact
 * Run revision, exact Scene source revision, Review binding, optional Baseline binding, and every
 * locally available screenshot before attaching it.
 */
export interface StudioRunEvidence {
  runRevision: string;
  run: RunArtifact;
  review?: Review;
  baseline?: Baseline;
  importedAt: string;
  bundleName: string;
  verifiedAssetHashes: string[];
  missingAssetHashes: string[];
}

export interface EditorCta extends SceneCta {
  kind?: PortableCta['kind'];
  targetSceneId?: string;
  webhookId?: string;
  fields?: PortableCta['fields'];
}

type PortableMask = PortableScene['steps'][number]['masks'][number];

export interface EditorMask extends Mask {
  mode: PortableMask['mode'];
  source: PortableMask['source'];
  scope: PortableMask['scope'];
  classification: PortableMask['classification'];
  locator?: PortableMask['locator'];
}

export interface EditorStep extends Omit<
  PlayerStep,
  'type' | 'annotations' | 'masks' | 'choices' | 'ctas'
> {
  type: StepKind;
  notes: string;
  crop: CropState;
  cursor: CursorState;
  annotations: EditorAnnotation[];
  masks: EditorMask[];
  choices: SceneChoice[];
  ctas: EditorCta[];
  /** True only after the author explicitly changes CTA configuration in Studio. */
  ctaEdited?: boolean;
  outputVisibility: OutputVisibility;
  frame: 'browser' | 'mobile' | 'none';
}

export interface EditorScene extends Omit<SceneDefinition, 'steps'> {
  steps: EditorStep[];
  description: string;
  audience: string;
  tags: string[];
  theme: {
    accent: string;
    paper: string;
    ink: string;
    radius: number;
    frame: 'light' | 'dark';
  };
  /** Studio-authored translation drafts, keyed by BCP 47 language tag. */
  translations?: Record<string, SceneTranslation>;
  /** Canonical source retained so editing presentation does not discard checks or automation. */
  portableSource?: PortableScene;
  /** Imported archive assets exposed as local Blob URLs after durable content-addressed storage. */
  portableAssets?: Record<string, string>;
  /**
   * Referenced narrative, theme, locale, and replay files retained by content identity. Text stays
   * exact UTF-8; binary payloads are exposed as revocable local Blob URLs while a Scene is open.
   */
  portableSidecars?: Record<string, string>;
  /** Newest-first immutable execution history attached by the dedicated evidence importer. */
  runEvidence?: StudioRunEvidence[];
  /** Content-addressed, integrity-checked screenshot URLs keyed by SHA-256. */
  runEvidenceAssets?: Record<string, string>;
  /** True only for the bundled synthetic walkthrough; never verification or publication evidence. */
  sample?: boolean;
}

export interface CatalogScene {
  id: string;
  title: string;
  description: string;
  capability: Capability;
  status: RunStatus;
  firstImage: string;
  finalImage: string;
  audience: string;
  feature: string;
  tags: string[];
  duration: string;
  lastVerified: string;
  commit: string;
  environment: string;
  stepCount: number;
  published: boolean;
  sample?: boolean;
}

export function cloneScene(scene: EditorScene): EditorScene {
  // Editor state is intentionally JSON-portable. Serializing first also unwraps
  // Svelte's deep state proxies, which structuredClone cannot clone directly.
  return JSON.parse(JSON.stringify(scene)) as EditorScene;
}

/**
 * Clone only mutable editor state for undo/redo and pointer frames.
 *
 * Portable source, archive assets, and sidecars are immutable while a Scene is open. Keeping those
 * references avoids re-serializing tens or hundreds of megabytes of base64 media for every
 * keystroke. Persistence and export still use cloneScene at their trust boundaries.
 */
export function cloneEditorWorkingScene(scene: EditorScene): EditorScene {
  return {
    ...scene,
    tags: [...scene.tags],
    theme: { ...scene.theme },
    verified: scene.verified ? { ...scene.verified } : undefined,
    translations: scene.translations
      ? Object.fromEntries(
          Object.entries(scene.translations).map(([locale, translation]) => [
            locale,
            {
              ...translation,
              steps: Object.fromEntries(
                Object.entries(translation.steps).map(([stepId, step]) => [stepId, { ...step }]),
              ),
            },
          ]),
        )
      : undefined,
    steps: scene.steps.map((step) => ({
      ...step,
      // Images are immutable URL/data-URI strings; do not serialize their bytes into history.
      image: step.image,
      crop: { ...step.crop },
      cursor: {
        ...step.cursor,
        path: step.cursor.path?.map((keyframe) => ({ ...keyframe })),
      },
      hotspot: step.hotspot ? { ...step.hotspot } : undefined,
      annotations: step.annotations.map((annotation) => ({ ...annotation })),
      masks: step.masks.map((mask) => ({ ...mask })),
      choices: step.choices.map((choice) => ({ ...choice })),
      ctas: step.ctas.map((cta) => ({
        ...cta,
        fields: cta.fields?.map((field) => ({ ...field })),
      })),
      outputVisibility: { ...step.outputVisibility },
    })),
    portableSource: scene.portableSource,
    portableAssets: scene.portableAssets,
    portableSidecars: scene.portableSidecars,
    runEvidence: scene.runEvidence,
    runEvidenceAssets: scene.runEvidenceAssets,
  };
}

export function moveStep(steps: EditorStep[], fromIndex: number, toIndex: number): EditorStep[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= steps.length ||
    toIndex >= steps.length ||
    fromIndex === toIndex
  ) {
    return structuredClone(steps);
  }
  const copy = structuredClone(steps);
  const [moved] = copy.splice(fromIndex, 1);
  if (moved) copy.splice(toIndex, 0, moved);
  return copy;
}

export function duplicateStep(
  steps: EditorStep[],
  index: number,
  makeId: (base: string) => string = (base) => `${base}-copy`,
): EditorStep[] {
  const source = steps[index];
  if (!source) return structuredClone(steps);
  const copy = structuredClone(steps);
  const duplicate = structuredClone(source);
  duplicate.id = makeId(source.id);
  duplicate.title = `${source.title} copy`;
  duplicate.annotations = duplicate.annotations.map((annotation) => ({
    ...annotation,
    id: makeId(annotation.id),
  }));
  duplicate.masks = duplicate.masks.map((mask) => ({ ...mask, id: makeId(mask.id) }));
  copy.splice(index + 1, 0, duplicate);
  return copy;
}

export function removeStep(steps: EditorStep[], index: number): EditorStep[] {
  if (steps.length <= 1 || !steps[index]) return structuredClone(steps);
  return steps.filter((_, candidate) => candidate !== index).map((step) => structuredClone(step));
}

export function normalizedPoint(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

const MIN_OVERLAY_SIZE = 0.01;

function boundedRect(
  rect: Pick<Mask, 'x' | 'y' | 'width' | 'height'>,
  minimum = MIN_OVERLAY_SIZE,
): Pick<Mask, 'x' | 'y' | 'width' | 'height'> {
  const x = normalizedPoint(rect.x);
  const y = normalizedPoint(rect.y);
  const width = Math.max(
    minimum,
    Math.min(1 - x, Number.isFinite(rect.width) ? rect.width : minimum),
  );
  const height = Math.max(
    minimum,
    Math.min(1 - y, Number.isFinite(rect.height) ? rect.height : minimum),
  );
  return {
    x: Math.min(x, 1 - minimum),
    y: Math.min(y, 1 - minimum),
    width,
    height,
  };
}

export function moveMask<T extends Mask>(mask: T, deltaX: number, deltaY: number): T {
  const width = Math.max(MIN_OVERLAY_SIZE, Math.min(1, mask.width));
  const height = Math.max(MIN_OVERLAY_SIZE, Math.min(1, mask.height));
  return {
    ...mask,
    x: Math.max(0, Math.min(1 - width, mask.x + deltaX)),
    y: Math.max(0, Math.min(1 - height, mask.y + deltaY)),
    width,
    height,
  };
}

export function resizeMask<T extends Mask>(mask: T, deltaX: number, deltaY: number): T {
  return {
    ...mask,
    ...boundedRect({
      x: mask.x,
      y: mask.y,
      width: mask.width + deltaX,
      height: mask.height + deltaY,
    }),
  };
}

function annotationSize(annotation: EditorAnnotation): { width: number; height: number } {
  return {
    width: Math.max(
      MIN_OVERLAY_SIZE,
      Math.min(1, annotation.width ?? (annotation.kind === 'spotlight' ? 0.16 : 0.2)),
    ),
    height: Math.max(
      MIN_OVERLAY_SIZE,
      Math.min(1, annotation.height ?? (annotation.kind === 'spotlight' ? 0.16 : 0.1)),
    ),
  };
}

export function moveAnnotation(
  annotation: EditorAnnotation,
  deltaX: number,
  deltaY: number,
): EditorAnnotation {
  if (annotation.kind === 'arrow') {
    const fromX = annotation.fromX ?? normalizedPoint(annotation.x - 0.08);
    const fromY = annotation.fromY ?? annotation.y;
    const boundedDeltaX = Math.max(
      -Math.min(fromX, annotation.x),
      Math.min(deltaX, 1 - Math.max(fromX, annotation.x)),
    );
    const boundedDeltaY = Math.max(
      -Math.min(fromY, annotation.y),
      Math.min(deltaY, 1 - Math.max(fromY, annotation.y)),
    );
    return {
      ...annotation,
      fromX: normalizedPoint(fromX + boundedDeltaX),
      fromY: normalizedPoint(fromY + boundedDeltaY),
      x: normalizedPoint(annotation.x + boundedDeltaX),
      y: normalizedPoint(annotation.y + boundedDeltaY),
    };
  }
  const { width, height } = annotationSize(annotation);
  return {
    ...annotation,
    width,
    height,
    x: Math.max(width / 2, Math.min(1 - width / 2, annotation.x + deltaX)),
    y: Math.max(height / 2, Math.min(1 - height / 2, annotation.y + deltaY)),
  };
}

export function resizeAnnotation(
  annotation: EditorAnnotation,
  deltaX: number,
  deltaY: number,
): EditorAnnotation {
  if (annotation.kind === 'arrow') {
    return {
      ...annotation,
      x: normalizedPoint(annotation.x + deltaX),
      y: normalizedPoint(annotation.y + deltaY),
      fromX: normalizedPoint(annotation.fromX ?? annotation.x - 0.08),
      fromY: normalizedPoint(annotation.fromY ?? annotation.y),
    };
  }
  const size = annotationSize(annotation);
  const width = Math.max(MIN_OVERLAY_SIZE, Math.min(1, size.width + deltaX));
  const height = Math.max(MIN_OVERLAY_SIZE, Math.min(1, size.height + deltaY));
  return {
    ...annotation,
    width,
    height,
    x: Math.max(width / 2, Math.min(1 - width / 2, annotation.x)),
    y: Math.max(height / 2, Math.min(1 - height / 2, annotation.y)),
  };
}

export function toPlayerScene(scene: EditorScene): SceneDefinition {
  return {
    version: 1,
    id: scene.id,
    title: scene.title,
    description: scene.description,
    theme: {
      accent: scene.theme.accent,
      paper: scene.theme.paper,
      ink: scene.theme.ink,
      radius: scene.theme.radius,
    },
    verified: scene.verified,
    steps: scene.steps.map((step) => ({
      id: step.id,
      type: step.type,
      title: step.title,
      instruction: step.instruction,
      caption: step.caption,
      alt: step.alt,
      image: step.image,
      crop: { ...step.crop },
      frame: step.frame,
      cursor: {
        ...step.cursor,
        path: step.cursor.path?.map((keyframe) => ({ ...keyframe })),
      },
      hotspot: step.hotspot,
      masks: step.masks,
      annotations: step.annotations,
      durationMs: step.durationMs,
      autoAdvance: step.autoAdvance,
      choices: step.choices,
      ctas: step.ctas,
    })),
  };
}

export function defaultStep(id: string, image?: string): EditorStep {
  return {
    id,
    type: 'screen',
    title: 'Untitled step',
    instruction: 'Describe what someone should do here.',
    caption: '',
    notes: '',
    alt: '',
    image,
    hotspot: { x: 0.5, y: 0.5, label: 'Continue' },
    annotations: [],
    masks: [],
    crop: { x: 0.5, y: 0.5, zoom: 1 },
    cursor: {
      x: 0.5,
      y: 0.5,
      visible: true,
      click: true,
      path: [],
      clickAtMs: 300,
      style: 'default',
    },
    choices: [],
    ctas: [],
    ctaEdited: false,
    outputVisibility: { interactive: true, guide: true, motion: true, social: true },
    durationMs: 2400,
    autoAdvance: false,
    frame: 'browser',
  };
}
