export type StepKind = 'screen' | 'choice' | 'end' | 'intro' | 'separator';

export interface Hotspot {
  x: number;
  y: number;
  width?: number;
  height?: number;
  label: string;
}

export interface Mask {
  id: string;
  mode?: 'opaque' | 'blur';
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

export interface Annotation {
  id: string;
  x: number;
  y: number;
  text: string;
  kind?: 'note' | 'callout' | 'spotlight' | 'arrow';
  /** Rectangle size for callouts and spotlights. x/y remain the rectangle center. */
  width?: number;
  height?: number;
  /** Arrow origin. x/y are the arrow destination. */
  fromX?: number;
  fromY?: number;
  color?: string;
}

export interface CropPresentation {
  /** Normalized focal point in the uncropped source image. */
  x: number;
  /** Normalized focal point in the uncropped source image. */
  y: number;
  /** Scale from 1x through 10x. Invalid values are bounded by the renderer. */
  zoom: number;
}

export type FrameKind = 'browser' | 'mobile' | 'none';

export interface CursorPresentation {
  x: number;
  y: number;
  visible: boolean;
  click: boolean;
  path?: Array<{ atMs: number; x: number; y: number }>;
  clickAtMs?: number;
  style?: 'default' | 'pointer' | 'dot';
}

export interface SceneChoice {
  id: string;
  label: string;
  description?: string;
  /** A choice always enters another linear Scene. It never creates an intra-Scene graph. */
  sceneId: string;
  stepId?: string;
  /** Portable fallback when the target Scene is not registered in the host player. */
  href?: string;
}

export interface SceneCta {
  id: string;
  label: string;
  kind?:
    | 'open-product'
    | 'read-docs'
    | 'restart'
    | 'view-scene'
    | 'book-call'
    | 'external'
    | 'form';
  href?: string;
  event?: string;
  variant?: 'primary' | 'secondary';
  webhookId?: string;
  fields?: Array<{
    id: string;
    label: string;
    type: 'email' | 'text' | 'checkbox';
    required: boolean;
    consent: boolean;
  }>;
}

export interface SceneCtaSubmission {
  sceneId: string;
  stepId: string;
  /** Stable authored CTA identity, independent of its mutable label or webhook. */
  ctaId: string;
  cta: SceneCta;
  webhookId?: string;
  fields: Record<string, string | boolean>;
  submissionId: string;
}

export type SceneCtaSubmitter = (submission: SceneCtaSubmission) => Promise<void>;

export interface PlayerStep {
  id: string;
  type?: StepKind;
  title: string;
  instruction?: string;
  caption?: string;
  alt?: string;
  image?: string;
  secondaryImage?: string;
  crop?: CropPresentation;
  frame?: FrameKind;
  cursor?: CursorPresentation;
  hotspot?: Hotspot;
  masks?: Mask[];
  annotations?: Annotation[];
  durationMs?: number;
  autoAdvance?: boolean;
  transition?: 'none' | 'fade' | 'slide' | 'zoom';
  practiceMode?: boolean;
  choices?: SceneChoice[];
  ctas?: SceneCta[];
}

export interface SceneTheme {
  accent?: string;
  paper?: string;
  ink?: string;
  radius?: number;
}

export interface SceneDefinition {
  version: 1;
  id: string;
  title: string;
  description?: string;
  steps: PlayerStep[];
  theme?: SceneTheme;
  verified?: {
    status: 'passed' | 'changed' | 'broken' | 'blocked';
    commit?: string;
    environment?: string;
    at?: string;
  };
}

export interface PlayerSnapshot {
  index: number;
  stepId: string | null;
  total: number;
  progress: number;
  canGoBack: boolean;
  canGoForward: boolean;
  complete: boolean;
}
