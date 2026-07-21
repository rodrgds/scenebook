export { registerScenebookPlayer, ScenebookPlayerElement } from './scenebook-player.js';
export {
  effectiveCrop,
  mapPointToCrop,
  mapRectToCrop,
  safePresentationPoint,
  safePresentationRect,
  safePresentationZoom,
} from './presentation.js';
export type { PresentationPoint, PresentationRect } from './presentation.js';
export { safeImageSource, safeNavigationUrl, safeRadius, safeThemeColor } from './security.js';
export { clampIndex, findStepIndex, resolveChoice, snapshot, validateScene } from './state.js';
export type {
  Annotation,
  CropPresentation,
  CursorPresentation,
  FrameKind,
  Hotspot,
  Mask,
  PlayerSnapshot,
  PlayerStep,
  SceneChoice,
  SceneCta,
  SceneCtaSubmission,
  SceneCtaSubmitter,
  SceneDefinition,
  SceneTheme,
  StepKind,
} from './types.js';
