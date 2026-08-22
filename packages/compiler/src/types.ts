import type { Scene } from '@scenebook/schema';

const OUTPUT_FORMATS = [
  'catalog',
  'standalone-html',
  'web-component',
  'iframe',
  'markdown',
  'mdx',
  'html-guide',
  'pdf',
  'mp4',
  'webm',
  'gif',
  'readme-card',
  'og-image',
  'social-carousel',
  'remix-source',
] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface FormatPolicy {
  readonly description: string;
  readonly deterministic: true;
  /**
   * Built-in formats are reproducible from the portable source alone. Motion formats are
   * reproducible only when the exact external encoder binding recorded in the manifest matches.
   */
  readonly reproducibility: 'self-contained' | 'toolchain-bound';
  readonly networkIndependent: true;
  readonly containsExecutableCode: boolean;
  readonly mayContainSensitivePixels: boolean;
  readonly requiresFfmpeg: boolean;
}

export interface CompilerToolchain {
  readonly name: 'ffmpeg';
  readonly binding: 'binary-and-version-output-sha256';
  /** SHA-256 of the exact executable bytes. The host path is deliberately never serialized. */
  readonly binarySha256: string;
  /** SHA-256 of normalized `ffmpeg -version` output, including linked library versions. */
  readonly versionOutputSha256: string;
  /** A bounded, path-free version token extracted from the first version line. */
  readonly version: string;
}

export interface CompilerDiagnostic {
  readonly code: string;
  readonly level: 'warning' | 'error';
  readonly message: string;
  readonly path?: string;
}

export interface PrivacyAssessment {
  readonly status: 'passed' | 'blocked' | 'unknown';
  readonly scanner: string;
  readonly findings: readonly CompilerDiagnostic[];
}

export interface PublishedAssetCandidate {
  readonly hash: string;
  readonly path: string;
  readonly sourceSceneId: string;
  readonly sourceStepIds: readonly string[];
  readonly mediaType: string;
  readonly bytes: number;
  readonly requiresOcr: boolean;
}

/** Receives only post-crop, post-publication-mask assets that may be published. */
export type PrivacyGate = (
  scene: LoadedScene,
  publishedAssets: readonly PublishedAssetCandidate[],
  publication: PublicationPrivacyProjection,
) => Promise<PrivacyAssessment>;

export interface PublicationPrivacyProjection {
  readonly format: 'scenebook-publication-text';
  readonly version: 1;
  /** Resolved catalog copy and selection metadata that will enter manifest/evidence output. */
  readonly catalog: PublicationPlan;
  readonly normalized: NormalizedScene;
  readonly narrative?: string;
  readonly locales: Readonly<Record<string, unknown>>;
}

export interface ResolvedSceneAsset {
  readonly reference: string;
  readonly sourcePath: string;
  readonly hash: string;
  readonly extension: string;
  readonly mediaType: string;
  readonly bytes: number;
}

export interface LoadedScene {
  readonly scene: Scene;
  readonly directory: string;
  readonly manifestPath: string;
  readonly narrative?: string;
  readonly theme?: Readonly<Record<string, unknown>>;
  readonly locales: Readonly<Record<string, unknown>>;
  readonly assets: ReadonlyMap<string, ResolvedSceneAsset>;
  readonly diagnostics: readonly CompilerDiagnostic[];
}

export interface NormalizedTarget {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label?: string;
  readonly role?: string;
}

export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface NormalizedAnnotation {
  readonly id: string;
  readonly kind: 'hotspot' | 'spotlight' | 'callout' | 'arrow' | 'text';
  readonly rect?: NormalizedRect;
  readonly from?: NormalizedPoint;
  readonly to?: NormalizedPoint;
  readonly text?: string;
  readonly label?: string;
  readonly color?: string;
}

export interface NormalizedMask {
  readonly id: string;
  readonly mode: 'opaque' | 'blur';
  readonly rect: NormalizedRect;
  readonly reason?: string;
  readonly source: 'automatic' | 'locator' | 'attribute' | 'manual';
  readonly classification:
    | 'password'
    | 'token'
    | 'payment'
    | 'email'
    | 'phone'
    | 'personal-data'
    | 'authentication'
    | 'custom';
}

export interface NormalizedCursor {
  readonly visible: boolean;
  readonly position?: NormalizedPoint;
  readonly path: readonly { readonly atMs: number; readonly point: NormalizedPoint }[];
  readonly clickAtMs?: number;
  readonly style: 'default' | 'pointer' | 'dot';
}

export interface NormalizedChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly targetSceneId: string;
  readonly targetStepId?: string;
}

export interface NormalizedCta {
  readonly id: string;
  readonly variant: 'primary' | 'secondary';
  readonly kind:
    | 'open-product'
    | 'read-docs'
    | 'restart'
    | 'view-scene'
    | 'book-call'
    | 'external'
    | 'form';
  readonly label: string;
  readonly url?: string;
  readonly targetSceneId?: string;
  readonly webhookId?: string;
  readonly fields: readonly {
    readonly id: string;
    readonly label: string;
    readonly type: 'email' | 'text' | 'checkbox';
    readonly required: boolean;
    readonly consent: boolean;
  }[];
}

export interface NormalizedStep {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly instruction?: string;
  readonly caption?: string;
  readonly altText?: string;
  readonly imageReference?: string;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly secondaryImageReference?: string;
  readonly secondaryImageWidth?: number;
  readonly secondaryImageHeight?: number;
  readonly target?: NormalizedTarget;
  readonly durationMs: number;
  readonly crop?: {
    readonly rect: NormalizedRect;
    readonly focalPoint?: NormalizedPoint;
    readonly zoom: number;
  };
  readonly frame?: {
    readonly kind: 'none' | 'browser' | 'device';
    readonly preset?: string;
    readonly title?: string;
    readonly showAddressBar: boolean;
  };
  readonly cursor?: NormalizedCursor;
  readonly annotations: readonly NormalizedAnnotation[];
  readonly masks: readonly NormalizedMask[];
  readonly autoAdvance: boolean;
  readonly transition: 'none' | 'fade' | 'slide' | 'zoom';
  readonly practiceMode: boolean;
  readonly choices: readonly NormalizedChoice[];
  /** Canonical authored actions. */
  readonly ctas: readonly NormalizedCta[];
  /** First primary action retained for adapters that can only display one action. */
  readonly cta?: NormalizedCta;
  readonly hidden: boolean;
  readonly visibility: {
    readonly interactive: boolean;
    readonly guide: boolean;
    readonly motion: boolean;
    readonly launchMedia: boolean;
  };
}

export interface NormalizedScene {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly capability: string;
  readonly locale: string;
  readonly defaultLocale: string;
  readonly theme: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
  readonly steps: readonly NormalizedStep[];
}

export interface CompileOptions {
  /** Portable Scene directories or already-loaded scenes. */
  readonly scenes: readonly (string | LoadedScene)[];
  /** Destination is replaced atomically only after every requested adapter succeeds. */
  readonly outputDirectory: string;
  /**
   * Additional source or durable-state paths that output replacement must
   * never contain or sit inside. Scene directories are protected automatically.
   */
  readonly protectedPaths?: readonly string[];
  readonly formats?: readonly OutputFormat[];
  /**
   * Project-agnostic catalog grouping and selection. The caller owns resolving project files;
   * the compiler validates the resulting plan against the supplied portable Scenes.
   */
  readonly publicationPlan?: PublicationPlan;
  /** Legacy all-Scenes catalog title, used only when publicationPlan is omitted. */
  readonly title?: string;
  readonly sourceDateEpoch?: number;
  readonly strictAssetHashes?: boolean;
  readonly overwrite?: boolean;
  /** Defaults to the bundled Scenebook privacy scanner when available. */
  readonly privacyGate?: PrivacyGate;
  /** Local escape hatch. The override is permanently recorded in generated evidence. */
  readonly allowUnscannedPrivacy?: boolean;
  /** Requested BCP-47 locale. Falls back to its base language, then the Scene default locale. */
  readonly locale?: string;
  readonly fallbackLocale?: string;
  /**
   * Public-scoped credential injected only into generated static player pages.
   * It is deliberately separate from PublicationPlan so manifests and evidence
   * never serialize the token.
   */
  readonly publicAnalytics?: PublicAnalyticsRuntime;
  /** Public form submission runtime, kept separate so its token never enters evidence. */
  readonly publicCta?: PublicCtaRuntime;
}

export interface PublicAnalyticsRuntime {
  readonly endpoint: string;
  readonly token: string;
  readonly releaseId: string;
  readonly respectDoNotTrack: boolean;
}

export interface PublicCtaRuntime {
  readonly endpoint: string;
  readonly token: string;
  readonly releaseId: string;
}

export interface PublicationSeo {
  readonly index: boolean;
  readonly follow: boolean;
  readonly title?: string;
  readonly description?: string;
}

export interface PublicationAnalyticsMetadata {
  readonly endpoint: string;
  readonly releaseId: string;
  readonly respectDoNotTrack: boolean;
}

export interface PublicationCtaMetadata {
  readonly endpoint: string;
  readonly releaseId: string;
}

export interface PublicationDistribution {
  readonly baseUrl?: string;
  readonly customDomain?: string;
  readonly seo: PublicationSeo;
  readonly attribution: boolean;
  readonly remix: boolean;
  /** Credential-free analytics description safe for manifests and evidence. */
  readonly analytics?: PublicationAnalyticsMetadata;
  /** Credential-free public form destination safe for manifests and evidence. */
  readonly cta?: PublicationCtaMetadata;
}

export type PublicationSelectionMode =
  | 'all-scenes'
  | 'project'
  | 'channel'
  | 'collection'
  | 'channel-collection';

export interface PublicationSelection {
  readonly mode: PublicationSelectionMode;
  readonly projectId?: string;
  readonly channelId?: string;
  readonly collectionIds: readonly string[];
}

export interface PublicationChannelPolicy {
  readonly requireCriticalPassing: boolean;
  readonly requireVisualApproval: boolean;
  readonly requireEditorialApproval: boolean;
  readonly requireCompleteLocalization: boolean;
  readonly publication: 'manual' | 'approved-main';
  readonly nonCriticalFailure: 'block' | 'carry-forward' | 'exclude';
}

export interface PublicationPolicy {
  /** A referenced Scene that was not supplied to the compiler aborts publication. */
  readonly missingSceneEntry: 'error';
  /** The first entry in group and entry order owns a Scene shown more than once. */
  readonly duplicateScenePlacement: 'first-occurrence-wins';
  /** Project builds include unreferenced Scenes; narrowed selections do not. */
  readonly ungroupedScenes: 'include' | 'exclude';
  readonly channel?: PublicationChannelPolicy;
}

export interface PublicationSceneEntry {
  readonly sceneId: string;
  readonly title?: string;
  readonly description?: string;
}

export interface PublicationGroup {
  readonly id: string;
  readonly slug: string;
  readonly kind: 'collection' | 'ungrouped';
  readonly title: string;
  readonly description?: string;
  readonly entries: readonly PublicationSceneEntry[];
}

/** Typed input accepted by the compiler without coupling it to project.yaml. */
export interface PublicationPlan {
  readonly format: 'scenebook-publication-plan';
  readonly version: 1;
  readonly selection: PublicationSelection;
  readonly title: string;
  readonly description?: string;
  /** Catalog document language. Older caller-authored plans default to English. */
  readonly locale?: string;
  readonly distribution: PublicationDistribution;
  readonly groups: readonly PublicationGroup[];
  readonly policy: PublicationPolicy;
}

export interface CompiledAsset {
  readonly hash: string;
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly privacyBasis: 'ocr' | 'structured';
}

export interface CompiledSceneManifest {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly capability: string;
  readonly locale: string;
  readonly sourceHash: string;
  readonly steps: number;
  readonly assets: readonly string[];
  readonly evidence: string;
  readonly outputs: Readonly<Partial<Record<OutputFormat, readonly string[]>>>;
  readonly share: {
    readonly page?: string;
    readonly standalone?: string;
    readonly embed?: string;
    readonly webComponent?: string;
    readonly readme?: string;
    readonly ogImage?: string;
    readonly socialImages?: readonly string[];
    readonly remixSource?: string;
    readonly remixArchive?: string;
  };
}

export interface CatalogManifest {
  readonly format: 'scenebook-catalog';
  readonly version: 1;
  readonly generatedAt: string;
  readonly title: string;
  readonly publication: PublicationPlan;
  readonly privacy: {
    readonly status: 'passed' | 'overridden';
    readonly scanner: string;
  };
  /** External build inputs required to reproduce toolchain-bound formats. */
  readonly toolchains?: readonly CompilerToolchain[];
  readonly scenes: readonly CompiledSceneManifest[];
  readonly assets: readonly CompiledAsset[];
}

export interface CompileResult {
  readonly outputDirectory: string;
  readonly manifest: CatalogManifest;
  readonly files: readonly string[];
  readonly diagnostics: readonly CompilerDiagnostic[];
}

export interface SceneAdapterContext {
  readonly loaded: LoadedScene;
  readonly scene: NormalizedScene;
  readonly outputDirectory: string;
  readonly generatedAt: string;
  /** Fully resolved plan after missing-entry validation and duplicate de-duplication. */
  readonly publication: PublicationPlan;
  readonly assetOutputPaths: ReadonlyMap<string, string>;
  readonly privacy: PrivacyAssessment & { readonly overridden: boolean };
  readonly sceneSlugs: ReadonlyMap<string, string>;
  readonly formats: readonly OutputFormat[];
  readonly publicAnalytics?: PublicAnalyticsRuntime;
  readonly publicCta?: PublicCtaRuntime;
  /** Internal resolved encoder path. It is execution-only and must never be serialized. */
  readonly ffmpegExecutable?: string;
  readonly putAsset: (
    contents: Uint8Array,
    options: {
      readonly extension: string;
      readonly mediaType: string;
      readonly sourceStepId?: string;
      readonly requiresOcr?: boolean;
    },
  ) => Promise<string>;
  /** Published, sanitized derivatives attributed to this Scene. Never raw captures. */
  readonly publishedAssets: Map<string, PublishedAssetCandidate>;
}

export interface SceneOutputAdapter {
  readonly format: OutputFormat;
  render(context: SceneAdapterContext): Promise<readonly string[]>;
}
