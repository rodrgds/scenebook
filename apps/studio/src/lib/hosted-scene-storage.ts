import { ProjectSchema, type Project } from '@scenebook/schema';

import {
  HostedApiError,
  hostedApi,
  hostedAsset,
  readHostedWorkspace,
  type HostedWorkspaceBinding,
} from './hosted-workspace';
import {
  SceneRevisionConflictError,
  SceneStorageError,
  compactStoredSceneRecord,
  hydrateStoredSceneRecord,
  summarizeStoredSceneRecord,
  summarizeStoredSceneVersion,
  type CompactedSceneRecord,
  type SceneBatchWrite,
  type ScenePage,
  type ScenePageRequest,
  type ScenePayloadRecord,
  type ScenePayloadReference,
  type SceneStorageBackend,
  type SceneSummary,
  type SceneVersionSummary,
  type StoredProjectRecord,
  type StoredSceneRecord,
} from './scene-library';
import { cloneScene, type EditorMask, type EditorScene } from './model';

interface ProjectDocumentResponse {
  document: { project: unknown; revision: number; savedAt: number } | null;
  project: { id: string; name: string; slug: string; createdAt: string };
}

type PortableScreenshot = NonNullable<
  NonNullable<
    NonNullable<EditorScene['portableSource']>['steps'][number]['states']['before']
  >['screenshot']
>;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}

async function blobSha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas did not produce a PNG.'))),
      'image/png',
    );
  });
}

async function privacyFlattenedImage(
  source: string,
  masks: readonly EditorMask[],
  stepId: string,
): Promise<{ blob: Blob; digest: string }> {
  if (typeof createImageBitmap !== 'function') {
    throw new SceneStorageError(
      'This browser cannot irreversibly apply privacy masks before hosted storage.',
      'write',
    );
  }
  let response: Response;
  try {
    response = await fetch(
      source,
      /^https?:/iu.test(source)
        ? { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' }
        : { credentials: 'same-origin' },
    );
  } catch (error) {
    throw new SceneStorageError(
      `Step ${stepId} could not be read for irreversible privacy masking.`,
      'write',
      error,
    );
  }
  if (!response.ok) {
    throw new SceneStorageError(
      `Step ${stepId} could not be read for irreversible privacy masking.`,
      'write',
    );
  }
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new SceneStorageError(
      'This browser cannot create the privacy-safe hosted screenshot.',
      'write',
    );
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  context.fillStyle = '#111111';
  for (const mask of masks) {
    context.fillRect(
      Math.floor(mask.x * canvas.width),
      Math.floor(mask.y * canvas.height),
      Math.ceil(mask.width * canvas.width),
      Math.ceil(mask.height * canvas.height),
    );
  }
  const blob = await canvasPng(canvas);
  return { blob, digest: await blobSha256(blob) };
}

function assertHostedEvidencePrivacy(scene: EditorScene): void {
  for (const evidence of scene.runEvidence ?? []) {
    const summaries = [
      evidence.run.privacy,
      ...evidence.run.attempts.flatMap((attempt) => [
        attempt.privacy,
        ...attempt.states.map((state) => state.privacy),
      ]),
      ...(evidence.baseline?.states.map((state) => state.privacy) ?? []),
    ];
    if (summaries.some((privacy) => privacy.status !== 'clear')) {
      throw new SceneStorageError(
        `Run evidence ${evidence.run.id} must be privacy-clear before hosted storage.`,
        'write',
      );
    }
  }
}

async function privacyFlattenedRecord(
  source: StoredSceneRecord,
): Promise<{ record: StoredSceneRecord; urls: string[] }> {
  const scene: EditorScene = cloneScene(source.scene);
  assertHostedEvidencePrivacy(scene);
  const urls: string[] = [];
  try {
    const replacedScreenshotPaths = new Set<string>();
    const replacedScreenshotSources = new Set<string>();
    for (const step of scene.steps) {
      const masks = step.masks.filter((mask) => mask.mode === 'opaque');
      if (masks.length === 0) continue;
      const portableStep = scene.portableSource?.steps.find(
        (candidate) => candidate.id === step.id,
      );
      const portableScreenshots = portableStep
        ? [portableStep.states.before?.screenshot, portableStep.states.after?.screenshot].filter(
            Boolean,
          )
        : [];
      if (!step.image && portableScreenshots.length === 0) continue;
      const selectedPhase = portableStep?.presentation.state === 'after' ? 'after' : 'before';
      let selectedImageFlattened = false;
      const flattenedSources = new Map<string, { url: string; asset: PortableScreenshot }>();
      if (portableStep) {
        for (const phase of ['before', 'after'] as const) {
          const state = portableStep.states[phase];
          if (!state?.screenshot) continue;
          const oldPath = state.screenshot.path;
          const imageSource =
            scene.portableAssets?.[oldPath] ?? (phase === selectedPhase ? step.image : undefined);
          if (!imageSource) {
            throw new SceneStorageError(
              `Step ${step.id} is missing the screenshot required for irreversible privacy masking.`,
              'write',
            );
          }
          let flattened = flattenedSources.get(imageSource);
          if (!flattened) {
            const { blob, digest } = await privacyFlattenedImage(imageSource, masks, step.id);
            const path = `assets/${digest}.png`;
            const url = URL.createObjectURL(blob);
            urls.push(url);
            flattened = {
              url,
              asset: {
                sha256: digest,
                path,
                mediaType: 'image/png',
                byteLength: blob.size,
                role: 'screenshot',
              },
            };
            flattenedSources.set(imageSource, flattened);
            scene.portableAssets = { ...(scene.portableAssets ?? {}), [path]: url };
          }
          if (
            oldPath !== flattened.asset.path ||
            state.screenshot.sha256 !== flattened.asset.sha256
          ) {
            replacedScreenshotPaths.add(oldPath);
            replacedScreenshotSources.add(imageSource);
          }
          state.screenshot = flattened.asset;
          if (phase === selectedPhase) {
            step.image = flattened.url;
            selectedImageFlattened = true;
          }
        }
      }
      if (!selectedImageFlattened && step.image) {
        const imageSource = step.image;
        const { blob } = await privacyFlattenedImage(imageSource, masks, step.id);
        replacedScreenshotSources.add(imageSource);
        const url = URL.createObjectURL(blob);
        urls.push(url);
        step.image = url;
      }
    }
    if (
      scene.portableSource &&
      (replacedScreenshotPaths.size > 0 || replacedScreenshotSources.size > 0)
    ) {
      const screenshots = scene.portableSource.steps.flatMap((step) =>
        [step.states.before?.screenshot, step.states.after?.screenshot].filter(
          (asset): asset is NonNullable<typeof asset> => Boolean(asset),
        ),
      );
      const referencedPaths = new Set(screenshots.map((asset) => asset.path));
      const unsafeSharedPath = [...replacedScreenshotPaths].find((path) =>
        referencedPaths.has(path),
      );
      if (unsafeSharedPath) {
        throw new SceneStorageError(
          `Screenshot ${unsafeSharedPath} is shared with an unmasked state and cannot be hosted safely.`,
          'write',
        );
      }
      const uniqueScreenshots = new Map(screenshots.map((asset) => [asset.path, asset]));
      scene.portableSource.assets = [
        ...scene.portableSource.assets.filter((asset) => asset.role !== 'screenshot'),
        ...uniqueScreenshots.values(),
      ];
      if (scene.portableAssets) {
        for (const [path, value] of Object.entries(scene.portableAssets)) {
          if (replacedScreenshotPaths.has(path) || replacedScreenshotSources.has(value)) {
            if (referencedPaths.has(path)) {
              throw new SceneStorageError(
                `Screenshot ${path} still references unmasked bytes and cannot be hosted safely.`,
                'write',
              );
            }
            delete scene.portableAssets[path];
          }
        }
      }
    }
    return { record: { ...source, scene }, urls };
  } catch (error) {
    for (const url of urls) URL.revokeObjectURL(url);
    throw error;
  }
}

export class HostedSceneStorage implements SceneStorageBackend {
  readonly binding: HostedWorkspaceBinding;
  #projectRevision: number | undefined;
  #sceneRevisions = new Map<string, number>();

  constructor(binding: HostedWorkspaceBinding | null = readHostedWorkspace()) {
    if (!binding) {
      throw new SceneStorageError('Hosted workspace configuration is unavailable.', 'open');
    }
    this.binding = binding;
  }

  #base(): string {
    return `/v1/admin/workspaces/${encoded(this.binding.workspaceId)}/projects/${encoded(this.binding.projectId)}/studio`;
  }

  #scenes(): string {
    return `${this.#base()}/scenes`;
  }

  async #payload(reference: ScenePayloadReference): Promise<ScenePayloadRecord> {
    const response = await hostedAsset(
      `${this.#base()}/assets/${reference.sha256}?mediaType=${encoded(reference.mediaType)}`,
    );
    const bytes = await response.arrayBuffer();
    return {
      sha256: reference.sha256,
      mediaType: reference.mediaType,
      byteLength: bytes.byteLength,
      bytes,
    };
  }

  async #upload(payload: ScenePayloadRecord): Promise<void> {
    const mediaKey = payload.mediaType.replaceAll(/[^A-Za-z0-9._:-]+/gu, '-').slice(0, 80);
    await hostedAsset(`${this.#base()}/assets/${payload.sha256}?byteLength=${payload.byteLength}`, {
      method: 'PUT',
      headers: {
        'content-type': payload.mediaType,
        'idempotency-key': `studio-${payload.sha256}-${mediaKey}`,
      },
      body: new Uint8Array(payload.bytes),
    });
  }

  async get(id: string): Promise<StoredSceneRecord | null> {
    try {
      const value = await hostedApi<{ record: unknown }>(`${this.#scenes()}/${encoded(id)}`);
      const record = await hydrateStoredSceneRecord(value.record, (reference) =>
        this.#payload(reference),
      );
      this.#sceneRevisions.set(id, record.revision);
      return record;
    } catch (error) {
      if (error instanceof HostedApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listSummaryPage(request: ScenePageRequest = {}): Promise<ScenePage<SceneSummary>> {
    const parameters = new URLSearchParams({ limit: String(request.limit ?? 24) });
    if (request.cursor) parameters.set('cursor', request.cursor);
    const value = await hostedApi<{ records: unknown[]; nextCursor: string | null }>(
      `${this.#scenes()}?${parameters}`,
    );
    const items = await Promise.all(
      value.records.map(async (record) => {
        const summary = await summarizeStoredSceneRecord(
          record,
          request.includePreviews ?? false,
          (reference) => this.#payload(reference),
        );
        this.#sceneRevisions.set(summary.id, summary.revision);
        return summary;
      }),
    );
    return { items, nextCursor: value.nextCursor };
  }

  async put(record: StoredSceneRecord, expectedRevision: number): Promise<void> {
    await this.putBatch([{ record, expectedRevision }]);
  }

  async #compact(writes: readonly SceneBatchWrite[]): Promise<CompactedSceneRecord[]> {
    const flattened = await Promise.all(writes.map(({ record }) => privacyFlattenedRecord(record)));
    let compacted: CompactedSceneRecord[];
    try {
      compacted = await Promise.all(
        flattened.map(({ record }) => compactStoredSceneRecord(record)),
      );
    } finally {
      for (const { urls } of flattened) {
        for (const url of urls) URL.revokeObjectURL(url);
      }
    }
    const payloads = new Map<string, ScenePayloadRecord>();
    for (const value of compacted) {
      for (const payload of value.payloads) {
        const identity = `${payload.sha256}\0${payload.mediaType}`;
        const existing = payloads.get(identity);
        if (
          existing &&
          (existing.byteLength !== payload.byteLength || !bytesEqual(existing.bytes, payload.bytes))
        ) {
          throw new SceneStorageError(
            'Hosted Studio found conflicting bytes for one content-addressed payload.',
            'write',
          );
        }
        payloads.set(identity, payload);
      }
    }
    await Promise.all([...payloads.values()].map((payload) => this.#upload(payload)));
    return compacted;
  }

  async #expectedProjectRevision(): Promise<number> {
    if (this.#projectRevision !== undefined) return this.#projectRevision;
    await this.getProject(this.binding.projectId);
    return this.#projectRevision ?? 0;
  }

  async putBatch(writes: readonly SceneBatchWrite[], project?: StoredProjectRecord): Promise<void> {
    const compacted = await this.#compact(writes);
    const expectedProjectRevision = project ? await this.#expectedProjectRevision() : undefined;
    try {
      const value = await hostedApi<{
        records: Array<{ id: string; revision: number }>;
        project?: { revision: number };
      }>(this.#scenes(), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          writes: compacted.map((value, index) => ({
            expectedRevision: writes[index]!.expectedRevision,
            record: value.record,
          })),
          ...(project
            ? {
                project: {
                  expectedRevision: expectedProjectRevision,
                  document: { project: project.project, savedAt: project.savedAt },
                },
              }
            : {}),
        }),
      });
      for (const record of value.records) this.#sceneRevisions.set(record.id, record.revision);
      if (value.project) this.#projectRevision = value.project.revision;
    } catch (error) {
      if (error instanceof HostedApiError && error.status === 409 && writes[0]) {
        const current = await this.get(writes[0].record.id).catch(() => null);
        throw new SceneRevisionConflictError(
          writes[0].record.id,
          writes[0].expectedRevision,
          current?.revision ?? 0,
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const expectedRevision = this.#sceneRevisions.get(id) ?? (await this.get(id))?.revision;
    if (!expectedRevision) return;
    try {
      await hostedApi<void>(
        `${this.#scenes()}/${encoded(id)}?expectedRevision=${expectedRevision}`,
        { method: 'DELETE' },
      );
      this.#sceneRevisions.delete(id);
    } catch (error) {
      if (error instanceof HostedApiError && error.status === 409) {
        const current = await this.get(id).catch(() => null);
        throw new SceneRevisionConflictError(id, expectedRevision, current?.revision ?? 0);
      }
      throw error;
    }
  }

  async listVersionSummaries(
    id: string,
    request: ScenePageRequest = {},
  ): Promise<ScenePage<SceneVersionSummary>> {
    const parameters = new URLSearchParams({ limit: String(request.limit ?? 24) });
    if (request.cursor) parameters.set('beforeRevision', request.cursor);
    const value = await hostedApi<{ records: unknown[]; nextRevision: number | null }>(
      `${this.#scenes()}/${encoded(id)}/versions?${parameters}`,
    );
    return {
      items: value.records.map(summarizeStoredSceneVersion),
      nextCursor: value.nextRevision === null ? null : String(value.nextRevision),
    };
  }

  async getVersion(id: string, revision: number): Promise<StoredSceneRecord | null> {
    try {
      const value = await hostedApi<{ record: unknown }>(
        `${this.#scenes()}/${encoded(id)}/versions/${revision}`,
      );
      return await hydrateStoredSceneRecord(value.record, (reference) => this.#payload(reference));
    } catch (error) {
      if (error instanceof HostedApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getProject(id: string): Promise<StoredProjectRecord | null> {
    if (id !== this.binding.projectId) return null;
    const value = await hostedApi<ProjectDocumentResponse>(`${this.#base()}/project`);
    if (value.document) {
      const project = ProjectSchema.parse(value.document.project);
      this.#projectRevision = value.document.revision;
      return { id: project.id, project, savedAt: value.document.savedAt };
    }
    const project: Project = ProjectSchema.parse({
      schemaVersion: 1,
      id: value.project.id,
      name: value.project.name,
      slug: value.project.slug,
      description: 'A self-hosted Scenebook workspace.',
      defaultLocale: 'en',
      locales: ['en'],
      repositories: [],
      environments: [],
      productVariants: [],
      captureProfiles: [],
      runTargets: [],
      collections: [],
      channels: [],
      public: { seo: { index: false, follow: false }, attribution: true, remix: true },
      metadata: { source: 'scenebook-hosted-studio' },
    });
    this.#projectRevision = 0;
    return {
      id: project.id,
      project,
      savedAt: new Date(value.project.createdAt).getTime(),
    };
  }

  async putProject(record: StoredProjectRecord): Promise<void> {
    const expectedRevision = await this.#expectedProjectRevision();
    const value = await hostedApi<{ document: { revision: number } }>(`${this.#base()}/project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision,
        document: { project: record.project, savedAt: record.savedAt },
      }),
    });
    this.#projectRevision = value.document.revision;
  }
}
