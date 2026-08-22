import { cloneEditorWorkingScene, cloneScene, defaultStep } from './model';
import type { EditorScene, RunStatus } from './model';
import { createLocalMediaUrl, getLocalMediaBlob, revokeLocalMediaUrl } from './local-media';
import { readHostedWorkspace } from './hosted-workspace';
import type { Project, ReviewChange } from '@scenebook/schema';
import { attachEvidenceToScene, runEvidenceStatus, type EvidenceImportCandidate } from './evidence';

const DATABASE_NAME = 'scenebook-studio';
// v5 healed a partially-created v4 payload store without rewriting records. v6 introduced the
// compound catalog pagination index. v7 re-runs the idempotent index repair for browsers that
// opened a pre-release v6 database before that index existed; record and payload formats remain
// unchanged, so v3 inline and v4+ compact records use the same bounded lazy migration path.
export const STUDIO_DATABASE_VERSION = 7;
const STORE_NAME = 'scenes';
const PROJECT_STORE_NAME = 'projects';
const VERSION_STORE_NAME = 'scene-versions';
const PAYLOAD_STORE_NAME = 'scene-payloads';
const MAX_LOCAL_VERSIONS = 100;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 50;
const LEGACY_MIGRATION_BATCH_SIZE = 4;
const RECOVERY_PREFIX = 'scenebook:recovery:';
const MAX_RECOVERY_BYTES = 1024 * 1024;
const LEGACY_PREFIX = 'scenebook:scene:';
const ACTIVE_PROJECT_KEY = 'scenebook:active-project';
export const STUDIO_PROJECT_CHANGED_EVENT = 'scenebook:project-changed';

function notifyProjectChanged(project: Project): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<Project>(STUDIO_PROJECT_CHANGED_EVENT, {
      detail: structuredClone(project),
    }),
  );
}

export interface StoredSceneRecord {
  id: string;
  scene: EditorScene;
  savedAt: number;
  revision: number;
}

export type ScenePayloadSlot =
  'step-image' | 'portable-asset' | 'portable-sidecar' | 'run-evidence-asset';

export interface ScenePayloadReference {
  slot: ScenePayloadSlot;
  key: string;
  sha256: string;
  mediaType: string;
  byteLength: number;
  /** Plain UTF-8 values round-trip exactly; binary/data values hydrate to byte-exact data URIs. */
  representation: 'utf8' | 'binary-data-uri';
}

export interface ScenePayloadRecord {
  sha256: string;
  mediaType: string;
  byteLength: number;
  bytes: ArrayBuffer;
}

export interface CompactStoredSceneRecord {
  id: string;
  scene: EditorScene;
  savedAt: number;
  revision: number;
  storageVersion: 4;
  payloadRefs: ScenePayloadReference[];
}

export interface CompactedSceneRecord {
  record: CompactStoredSceneRecord;
  payloads: ScenePayloadRecord[];
}

export type BlobPayloadResolver = (
  url: string,
) => Promise<{ bytes: Uint8Array; mediaType: string }>;

export interface RecoveryRecord {
  id: string;
  scene: EditorScene;
  updatedAt: number;
  token: number;
  /** Large embedded media intentionally omitted from the synchronous crash journal. */
  omittedMedia?: {
    imageStepIds: string[];
    portablePayload: boolean;
    evidencePayload?: boolean;
  };
}

export interface StoredProjectRecord {
  id: string;
  project: Project;
  savedAt: number;
}

export interface SceneSummary {
  id: string;
  title: string;
  description: string;
  stepCount: number;
  savedAt: number;
  revision: number;
  firstImage?: string;
  finalImage?: string;
  tags: string[];
  /** Canonical authored publication state; never inferred from local verification. */
  publicationStatus: 'draft' | 'published' | 'archived';
  /** Canonical audience/persona IDs retained for catalog search and grouping. */
  audiences: string[];
  capability: 'captured' | 'monitored' | 'verified';
  runStatus: RunStatus;
  verification?: NonNullable<EditorScene['verified']>;
  /** Newest-first immutable Run summaries; Review changes are exact imported artifacts. */
  evidenceRuns: RunEvidenceSummary[];
  automationLevel: 'none' | 'monitored' | 'verified';
  checkCount: number;
  translationCount: number;
  screenStepCount: number;
  screenAssetCount: number;
  opaqueMaskCount: number;
  hiddenStepCount: number;
  sample: boolean;
}

export interface RunEvidenceSummary {
  runId: string;
  runRevision: string;
  runTargetId: string;
  status: 'passed' | 'failed' | 'blocked' | 'cancelled' | 'skipped';
  changeState: Exclude<RunStatus, 'stale'>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  repository: string;
  commit: string;
  dirty: boolean;
  privacyStatus: 'clear' | 'warning' | 'unknown' | 'blocked' | 'quarantined';
  attemptCount: number;
  actionCount: number;
  checkCount: number;
  failedCheckCount: number;
  stateCount: number;
  errorCount: number;
  verifiedAssetCount: number;
  missingAssetCount: number;
  producer: string;
  review?: {
    id: string;
    status: 'open' | 'approved' | 'changes-requested' | 'rejected' | 'closed';
    changes: ReviewChange[];
  };
}

export interface ScenePage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ScenePageRequest {
  cursor?: string | null;
  limit?: number;
  /** Catalog cards request one bounded preview. Metadata-only callers leave this false. */
  includePreviews?: boolean;
}

export interface SceneVersionSummary {
  id: string;
  revision: number;
  savedAt: number;
  title: string;
  stepCount: number;
  translationCount: number;
  hasPortableSource: boolean;
  verification: RunStatus | null;
  runRevisions: string[];
  theme: EditorScene['theme'];
  steps: Array<{ id: string; title: string; type: EditorScene['steps'][number]['type'] }>;
}

export interface SceneBatchWrite {
  record: StoredSceneRecord;
  expectedRevision: number;
}

export interface LoadedScene {
  scene: EditorScene | null;
  saved: StoredSceneRecord | null;
  recovery: RecoveryRecord | null;
  migratedLegacy: boolean;
}

export type ImportConflictStrategy = 'rename' | 'replace' | 'skip';

export interface ImportScenesResult {
  imported: EditorScene[];
  skipped: string[];
  renamed: Array<{ from: string; to: string }>;
  project?: Project;
}

export interface ImportRunEvidenceResult {
  scenes: Array<{
    id: string;
    runCount: number;
    replacedCount: number;
    latestStatus: Exclude<RunStatus, 'stale'>;
  }>;
  runCount: number;
}

export interface SceneStorageBackend {
  get(id: string): Promise<StoredSceneRecord | null>;
  listSummaryPage(request?: ScenePageRequest): Promise<ScenePage<SceneSummary>>;
  put(record: StoredSceneRecord, expectedRevision: number): Promise<void>;
  putBatch(writes: readonly SceneBatchWrite[], project?: StoredProjectRecord): Promise<void>;
  delete(id: string): Promise<void>;
  listVersionSummaries(
    id: string,
    request?: ScenePageRequest,
  ): Promise<ScenePage<SceneVersionSummary>>;
  getVersion(id: string, revision: number): Promise<StoredSceneRecord | null>;
  getProject(id: string): Promise<StoredProjectRecord | null>;
  putProject(record: StoredProjectRecord): Promise<void>;
}

export interface RecoveryJournal {
  read(id: string): RecoveryRecord | null;
  write(scene: EditorScene): RecoveryRecord;
  clear(id: string, token?: number): void;
}

export class SceneStorageError extends Error {
  readonly operation: 'open' | 'read' | 'write' | 'delete';
  readonly cause?: unknown;

  constructor(message: string, operation: SceneStorageError['operation'], cause?: unknown) {
    super(message);
    this.name = 'SceneStorageError';
    this.operation = operation;
    this.cause = cause;
  }
}

export class SceneRevisionConflictError extends SceneStorageError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(id: string, expectedRevision: number, actualRevision: number) {
    super(
      `“${id}” changed in another Studio tab. Your edit remains in crash recovery; reload before saving again.`,
      'write',
    );
    this.name = 'SceneRevisionConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class ScenePayloadIntegrityError extends SceneStorageError {
  constructor(
    message: string,
    operation: SceneStorageError['operation'] = 'read',
    cause?: unknown,
  ) {
    super(message, operation, cause);
    this.name = 'ScenePayloadIntegrityError';
  }
}

/** A caller reaches this helper only after its durable transaction has committed. */
export async function settlePostCommitMaintenance(
  tasks: readonly Promise<unknown>[],
): Promise<void> {
  await Promise.allSettled(tasks);
}

export function coalesceMaintenanceSceneIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function requestResult<T>(request: IDBRequest<T>, operation: SceneStorageError['operation']) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new SceneStorageError(
          'The local workspace database could not be read.',
          operation,
          request.error,
        ),
      );
  });
}

function transactionComplete(
  transaction: IDBTransaction,
  operation: SceneStorageError['operation'],
) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        new SceneStorageError(
          operation === 'write'
            ? 'Studio could not save this Scene locally.'
            : 'Studio could not update the local workspace.',
          operation,
          transaction.error,
        ),
      );
    transaction.onabort = transaction.onerror;
  });
}

function isEditorScene(value: unknown): value is EditorScene {
  if (!value || typeof value !== 'object') return false;
  const scene = value as Partial<EditorScene>;
  return (
    scene.version === 1 &&
    typeof scene.id === 'string' &&
    /^[a-z0-9][a-z0-9._:-]*$/u.test(scene.id) &&
    typeof scene.title === 'string' &&
    Array.isArray(scene.steps) &&
    scene.steps.length > 0 &&
    scene.steps.every(
      (step) =>
        step &&
        typeof step === 'object' &&
        typeof step.id === 'string' &&
        typeof step.title === 'string' &&
        Array.isArray(step.masks),
    )
  );
}

function normalizeLegacyMaskMetadata(scene: EditorScene): EditorScene {
  const normalized = cloneScene(scene);
  for (const step of normalized.steps) {
    for (const mask of step.masks) {
      const legacyMask = mask as typeof mask & {
        mode?: typeof mask.mode;
        source?: typeof mask.source;
        scope?: typeof mask.scope;
        classification?: typeof mask.classification;
      };
      legacyMask.mode ??= 'opaque';
      legacyMask.source ??= 'manual';
      legacyMask.scope ??= 'both';
      legacyMask.classification ??= 'custom';
    }
  }
  return normalized;
}

function readLegacyStoredRecord(value: unknown): StoredSceneRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<StoredSceneRecord> & { storageVersion?: unknown };
  if (
    record.storageVersion !== undefined ||
    typeof record.id !== 'string' ||
    !isEditorScene(record.scene) ||
    record.scene.id !== record.id ||
    !Number.isFinite(record.savedAt) ||
    !Number.isInteger(record.revision) ||
    (record.revision ?? 0) < 1
  ) {
    return null;
  }
  return record as StoredSceneRecord;
}

function isPayloadReference(value: unknown): value is ScenePayloadReference {
  if (!value || typeof value !== 'object') return false;
  const reference = value as Partial<ScenePayloadReference>;
  return (
    (reference.slot === 'step-image' ||
      reference.slot === 'portable-asset' ||
      reference.slot === 'portable-sidecar' ||
      reference.slot === 'run-evidence-asset') &&
    typeof reference.key === 'string' &&
    reference.key.length > 0 &&
    typeof reference.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(reference.sha256) &&
    typeof reference.mediaType === 'string' &&
    reference.mediaType.length > 0 &&
    reference.mediaType.length <= 255 &&
    reference.mediaType === reference.mediaType.trim().toLowerCase() &&
    !/[\u0000-\u001f\u007f]/u.test(reference.mediaType) &&
    Number.isSafeInteger(reference.byteLength) &&
    (reference.byteLength ?? -1) >= 0 &&
    (reference.representation === 'utf8' || reference.representation === 'binary-data-uri')
  );
}

function readCompactStoredRecord(value: unknown): CompactStoredSceneRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CompactStoredSceneRecord>;
  if (
    record.storageVersion !== 4 ||
    typeof record.id !== 'string' ||
    !isEditorScene(record.scene) ||
    record.scene.id !== record.id ||
    !Number.isFinite(record.savedAt) ||
    !Number.isInteger(record.revision) ||
    (record.revision ?? 0) < 1 ||
    !Array.isArray(record.payloadRefs) ||
    !record.payloadRefs.every(isPayloadReference)
  ) {
    return null;
  }
  const slots = new Set<string>();
  const stepIds = new Set<string>();
  for (const step of record.scene.steps) {
    if (stepIds.has(step.id)) return null;
    stepIds.add(step.id);
    const inlineImage = step.image?.toLowerCase();
    if (inlineImage?.startsWith('data:') || inlineImage?.startsWith('blob:')) {
      return null;
    }
  }
  for (const value of Object.values(record.scene.portableAssets ?? {})) {
    if (!isRemoteUrl(value)) return null;
  }
  for (const value of Object.values(record.scene.portableSidecars ?? {})) {
    if (!isRemoteUrl(value)) return null;
  }
  if (Object.keys(record.scene.runEvidenceAssets ?? {}).length > 0) return null;
  for (const reference of record.payloadRefs) {
    const slot = `${reference.slot}\u0000${reference.key}`;
    if (slots.has(slot)) return null;
    slots.add(slot);
    if (reference.slot === 'step-image') {
      const step = record.scene.steps.find((candidate) => candidate.id === reference.key);
      if (!step || step.image !== undefined) return null;
    } else if (reference.slot === 'portable-asset') {
      if (
        record.scene.portableAssets === undefined ||
        Object.hasOwn(record.scene.portableAssets, reference.key)
      ) {
        return null;
      }
    } else if (reference.slot === 'portable-sidecar') {
      if (
        record.scene.portableSidecars === undefined ||
        Object.hasOwn(record.scene.portableSidecars, reference.key)
      ) {
        return null;
      }
    } else if (
      record.scene.runEvidenceAssets === undefined ||
      Object.hasOwn(record.scene.runEvidenceAssets, reference.key) ||
      !/^[a-f0-9]{64}$/u.test(reference.key) ||
      reference.key !== reference.sha256
    ) {
      return null;
    }
  }
  return record as CompactStoredSceneRecord;
}

type StoredSceneEnvelope =
  | { kind: 'legacy'; record: StoredSceneRecord }
  | { kind: 'compact'; record: CompactStoredSceneRecord };

function readStoredEnvelope(value: unknown): StoredSceneEnvelope | null {
  const compact = readCompactStoredRecord(value);
  if (compact) return { kind: 'compact', record: compact };
  const legacy = readLegacyStoredRecord(value);
  return legacy ? { kind: 'legacy', record: legacy } : null;
}

function pageSize(value: number | undefined): number {
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(value ?? DEFAULT_PAGE_SIZE)));
}

function encodeSceneCursor(savedAt: number, id: string): string {
  return encodeURIComponent(JSON.stringify([savedAt, id]));
}

function decodeSceneCursor(value: string | null | undefined): [number, string] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isFinite(parsed[0]) &&
      typeof parsed[1] === 'string'
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

function decodeVersionCursor(value: string | null | undefined): number | null {
  if (!value) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function summarizeRunEvidence(scene: EditorScene): RunEvidenceSummary[] {
  return (scene.runEvidence ?? []).map((evidence) => {
    const attempts = evidence.run.attempts;
    return {
      runId: evidence.run.id,
      runRevision: evidence.runRevision,
      runTargetId: evidence.run.runTargetId,
      status: evidence.run.status,
      changeState: runEvidenceStatus(evidence.run),
      startedAt: evidence.run.startedAt,
      endedAt: evidence.run.endedAt,
      durationMs: evidence.run.durationMs,
      repository: evidence.run.repository.repository,
      commit: evidence.run.repository.commit,
      dirty: evidence.run.repository.dirty,
      privacyStatus: evidence.run.privacy.status,
      attemptCount: attempts.length,
      actionCount: attempts.reduce((count, attempt) => count + attempt.actions.length, 0),
      checkCount: attempts.reduce((count, attempt) => count + attempt.checks.length, 0),
      failedCheckCount: attempts.reduce(
        (count, attempt) =>
          count + attempt.checks.filter((check) => check.status === 'failed').length,
        0,
      ),
      stateCount: attempts.reduce((count, attempt) => count + attempt.states.length, 0),
      errorCount: attempts.reduce((count, attempt) => count + attempt.errors.length, 0),
      verifiedAssetCount: evidence.verifiedAssetHashes.length,
      missingAssetCount: evidence.missingAssetHashes.length,
      producer: `${evidence.run.producer.name}@${evidence.run.producer.version}`,
      ...(evidence.review
        ? {
            review: {
              id: evidence.review.id,
              status: evidence.review.status,
              changes: structuredClone(evidence.review.changes),
            },
          }
        : {}),
    };
  });
}

function versionSummary(envelope: StoredSceneEnvelope): SceneVersionSummary {
  const { record } = envelope;
  return {
    id: record.id,
    revision: record.revision,
    savedAt: record.savedAt,
    title: record.scene.title,
    stepCount: record.scene.steps.length,
    translationCount: Object.keys(record.scene.translations ?? {}).length,
    hasPortableSource: Boolean(record.scene.portableSource),
    verification: record.scene.verified?.status ?? null,
    runRevisions: (record.scene.runEvidence ?? []).map((evidence) => evidence.runRevision),
    theme: { ...record.scene.theme },
    steps: record.scene.steps.map((step) => ({ id: step.id, title: step.title, type: step.type })),
  };
}

export function summarizeStoredSceneVersion(value: unknown): SceneVersionSummary {
  const envelope = readStoredEnvelope(value);
  if (!envelope) {
    throw new SceneStorageError(
      'Saved revision data is invalid. Studio left it untouched for recovery.',
      'read',
    );
  }
  return versionSummary(envelope);
}

function createPayloadObjectUrl(payload: ScenePayloadRecord): string {
  if (typeof URL?.createObjectURL !== 'function') {
    throw new SceneStorageError(
      'This browser cannot create a safe local media URL for saved Scene assets.',
      'read',
    );
  }
  return createLocalMediaUrl(payload.bytes, payload.mediaType);
}

function collectBlobUrls(value: unknown, urls: Set<string>, seen: Set<object>): void {
  if (typeof value === 'string') {
    if (value.startsWith('blob:')) urls.add(value);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) collectBlobUrls(item, urls, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectBlobUrls(item, urls, seen);
  }
}

/** Release media URLs created by a load/list call once the owning view is destroyed or replaced. */
export function releaseLocalMediaUrls(...values: unknown[]): void {
  if (typeof URL?.revokeObjectURL !== 'function') return;
  const urls = new Set<string>();
  const seen = new Set<object>();
  for (const value of values) collectBlobUrls(value, urls, seen);
  for (const url of urls) revokeLocalMediaUrl(url);
}

export function releaseLocalMediaUrlsExcept(value: unknown, retained: unknown): void {
  const released = new Set<string>();
  const retainedUrls = new Set<string>();
  collectBlobUrls(value, released, new Set<object>());
  collectBlobUrls(retained, retainedUrls, new Set<object>());
  for (const url of released) {
    if (!retainedUrls.has(url)) revokeLocalMediaUrl(url);
  }
}

function normalizeMediaType(
  value: string | undefined,
  operation: 'read' | 'write' = 'write',
): string {
  const mediaType = (value?.trim() || 'application/octet-stream').toLowerCase();
  if (
    mediaType.length > 255 ||
    !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+(?:\s*;[^\u0000-\u001f\u007f,]+)*$/u.test(
      mediaType,
    )
  ) {
    throw new ScenePayloadIntegrityError(
      `Invalid embedded media type “${value ?? ''}”.`,
      operation,
    );
  }
  return mediaType;
}

interface DataUriDescriptor {
  mediaType: string;
  payload: string;
  base64: boolean;
}

function describeDataUri(
  value: string,
  operation: 'read' | 'write' = 'write',
): DataUriDescriptor | null {
  if (!value.toLowerCase().startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 5) {
    throw new ScenePayloadIntegrityError('An embedded data URI is malformed.', operation);
  }
  const components = value
    .slice(5, comma)
    .split(';')
    .map((component) => component.trim());
  const declared = components.shift() || 'text/plain';
  const base64 = components.some((component) => component.toLowerCase() === 'base64');
  const parameters = components.filter(
    (component) => component.length > 0 && component.toLowerCase() !== 'base64',
  );
  if (declared === 'text/plain' && !parameters.some((parameter) => /^charset=/iu.test(parameter))) {
    parameters.push('charset=us-ascii');
  }
  return {
    mediaType: normalizeMediaType([declared, ...parameters].join(';'), operation),
    payload: value.slice(comma + 1),
    base64,
  };
}

function dataUriMediaType(value: string, operation: 'read' | 'write' = 'write'): string | null {
  return describeDataUri(value, operation)?.mediaType ?? null;
}

function decodeDataUri(value: string): { bytes: ArrayBuffer; mediaType: string } | null {
  const descriptor = describeDataUri(value, 'write');
  if (!descriptor) return null;
  if (descriptor.base64) {
    try {
      const binary = atob(descriptor.payload.replaceAll(/\s+/gu, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return { bytes: bytes.buffer, mediaType: descriptor.mediaType };
    } catch (error) {
      throw new ScenePayloadIntegrityError(
        'An embedded data URI contains invalid base64 bytes.',
        'write',
        error,
      );
    }
  }

  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let byteLength = 0;
  let literalStart = 0;
  const append = (bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return;
    chunks.push(bytes);
    byteLength += bytes.byteLength;
  };
  for (let index = 0; index < descriptor.payload.length; index += 1) {
    if (descriptor.payload[index] !== '%') continue;
    append(encoder.encode(descriptor.payload.slice(literalStart, index)));
    const encodedByte = descriptor.payload.slice(index + 1, index + 3);
    if (!/^[a-f0-9]{2}$/iu.test(encodedByte)) {
      throw new ScenePayloadIntegrityError(
        'An embedded data URI contains an invalid percent-encoded byte.',
        'write',
      );
    }
    append(Uint8Array.of(Number.parseInt(encodedByte, 16)));
    index += 2;
    literalStart = index + 1;
  }
  append(encoder.encode(descriptor.payload.slice(literalStart)));
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: bytes.buffer, mediaType: descriptor.mediaType };
}

function isRemoteUrl(value: string): boolean {
  return /^(?:https?:)?\/\//iu.test(value);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

async function sha256(bytes: ArrayBuffer, operation: 'read' | 'write'): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new SceneStorageError(
      'This browser cannot verify local media integrity because Web Crypto is unavailable.',
      operation,
    );
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function payloadIdentity(payload: Pick<ScenePayloadRecord, 'sha256' | 'mediaType'>): string {
  return `${payload.sha256}\u0000${payload.mediaType}`;
}

async function defaultBlobPayloadResolver(
  url: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  try {
    const local = getLocalMediaBlob(url);
    if (local) {
      return {
        bytes: new Uint8Array(await local.arrayBuffer()),
        mediaType: normalizeMediaType(local.type || undefined),
      };
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mediaType: normalizeMediaType(blob.type || response.headers.get('content-type') || undefined),
    };
  } catch (error) {
    throw new SceneStorageError(
      'Studio could not make an embedded blob durable. Keep the source tab open and retry.',
      'write',
      error,
    );
  }
}

interface ExtractedPayload {
  bytes: ArrayBuffer;
  mediaType: string;
  representation: ScenePayloadReference['representation'];
}

async function extractPayload(
  value: string,
  allowPlainText: boolean,
  resolveBlob: BlobPayloadResolver,
): Promise<ExtractedPayload | null> {
  const dataPayload = decodeDataUri(value);
  if (dataPayload) {
    return {
      bytes: dataPayload.bytes,
      mediaType: dataPayload.mediaType,
      representation: 'binary-data-uri',
    };
  }
  if (value.toLowerCase().startsWith('blob:')) {
    const blob = await resolveBlob(value);
    return {
      bytes: exactArrayBuffer(blob.bytes),
      mediaType: normalizeMediaType(blob.mediaType),
      representation: 'binary-data-uri',
    };
  }
  if (isRemoteUrl(value) || !allowPlainText || value.length === 0) return null;
  return {
    bytes: exactArrayBuffer(new TextEncoder().encode(value)),
    mediaType: 'text/plain',
    representation: 'utf8',
  };
}

/**
 * Move large embedded values out of a Scene record without changing the public EditorScene model.
 * The returned payload list contains one immutable entry per (SHA-256, media type) identity.
 */
export async function compactStoredSceneRecord(
  source: StoredSceneRecord,
  resolveBlob: BlobPayloadResolver = defaultBlobPayloadResolver,
): Promise<CompactedSceneRecord> {
  if (!readLegacyStoredRecord(source)) {
    throw new SceneStorageError('Studio refused to compact an invalid Scene record.', 'write');
  }
  const scene = normalizeLegacyMaskMetadata(source.scene);
  const payloadRefs: ScenePayloadReference[] = [];
  const payloads = new Map<string, ScenePayloadRecord>();

  const retain = async (
    slot: ScenePayloadSlot,
    key: string,
    value: string,
    allowPlainText: boolean,
  ): Promise<boolean> => {
    const extracted = await extractPayload(value, allowPlainText, resolveBlob);
    if (!extracted) return false;
    const digest = await sha256(extracted.bytes, 'write');
    const payload: ScenePayloadRecord = {
      sha256: digest,
      mediaType: extracted.mediaType,
      byteLength: extracted.bytes.byteLength,
      bytes: extracted.bytes,
    };
    const identity = payloadIdentity(payload);
    const existing = payloads.get(identity);
    if (
      existing &&
      (existing.byteLength !== payload.byteLength || !bytesEqual(existing.bytes, payload.bytes))
    ) {
      throw new ScenePayloadIntegrityError(
        'Two embedded values produced the same content identity with different bytes.',
        'write',
      );
    }
    if (!existing) payloads.set(identity, payload);
    payloadRefs.push({
      slot,
      key,
      sha256: digest,
      mediaType: extracted.mediaType,
      byteLength: extracted.bytes.byteLength,
      representation: extracted.representation,
    });
    return true;
  };

  for (const step of scene.steps) {
    if (step.image && (await retain('step-image', step.id, step.image, false))) {
      step.image = undefined;
    }
  }

  const compactPortableMap = async (
    slot: 'portable-asset' | 'portable-sidecar' | 'run-evidence-asset',
    values: Record<string, string> | undefined,
    requireEmbedded = false,
  ): Promise<Record<string, string> | undefined> => {
    if (!values) return undefined;
    const inline: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(values)) {
      if (!(await retain(slot, key, value, true))) {
        if (requireEmbedded) {
          throw new ScenePayloadIntegrityError(
            `Run evidence asset “${key}” must be an integrity-checked local payload.`,
            'write',
          );
        }
        inline.push([key, value]);
      }
    }
    return Object.fromEntries(inline);
  };

  scene.portableAssets = await compactPortableMap('portable-asset', scene.portableAssets);
  scene.portableSidecars = await compactPortableMap('portable-sidecar', scene.portableSidecars);
  scene.runEvidenceAssets = await compactPortableMap(
    'run-evidence-asset',
    scene.runEvidenceAssets,
    true,
  );
  payloadRefs.sort((left, right) =>
    `${left.slot}\u0000${left.key}`.localeCompare(`${right.slot}\u0000${right.key}`),
  );

  return {
    record: {
      id: source.id,
      scene,
      savedAt: source.savedAt,
      revision: source.revision,
      storageVersion: 4,
      payloadRefs,
    },
    payloads: [...payloads.values()],
  };
}

function readPayloadRecord(value: unknown): ScenePayloadRecord | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<ScenePayloadRecord>;
  if (
    typeof payload.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(payload.sha256) ||
    typeof payload.mediaType !== 'string' ||
    payload.mediaType !== payload.mediaType.trim().toLowerCase() ||
    !Number.isSafeInteger(payload.byteLength) ||
    (payload.byteLength ?? -1) < 0 ||
    !(payload.bytes instanceof ArrayBuffer) ||
    payload.bytes.byteLength !== payload.byteLength
  ) {
    return null;
  }
  return payload as ScenePayloadRecord;
}

async function verifyPayload(
  reference: ScenePayloadReference,
  value: unknown,
): Promise<ScenePayloadRecord> {
  const payload = readPayloadRecord(value);
  if (
    !payload ||
    payload.sha256 !== reference.sha256 ||
    payload.mediaType !== reference.mediaType ||
    payload.byteLength !== reference.byteLength
  ) {
    throw new ScenePayloadIntegrityError(
      `Embedded payload ${reference.sha256} (${reference.mediaType}) is missing or has invalid metadata.`,
    );
  }
  if ((await sha256(payload.bytes, 'read')) !== payload.sha256) {
    throw new ScenePayloadIntegrityError(
      `Embedded payload ${reference.sha256} (${reference.mediaType}) failed its integrity check.`,
    );
  }
  return payload;
}

export async function summarizeStoredSceneRecord(
  value: unknown,
  includePreview: boolean,
  resolvePayload: (reference: ScenePayloadReference) => Promise<unknown>,
): Promise<SceneSummary> {
  const envelope = readStoredEnvelope(value);
  if (!envelope) {
    throw new SceneStorageError(
      'Saved Scene data is invalid. Studio left it untouched for recovery.',
      'read',
    );
  }
  const { record } = envelope;
  const referencedImageStepIds = new Set(
    envelope.kind === 'compact'
      ? envelope.record.payloadRefs
          .filter((reference) => reference.slot === 'step-image')
          .map((reference) => reference.key)
      : [],
  );
  let firstImage: string | undefined;
  let finalImage: string | undefined;
  if (includePreview) {
    const createdUrls = new Set<string>();
    const references =
      envelope.kind === 'compact'
        ? new Map(
            envelope.record.payloadRefs
              .filter((reference) => reference.slot === 'step-image')
              .map((reference) => [reference.key, reference]),
          )
        : new Map<string, ScenePayloadReference>();
    const previewSteps = record.scene.steps.filter(
      (step) => Boolean(step.image) || references.has(step.id),
    );
    const selectedSteps = [previewSteps[0], previewSteps.at(-1)].filter(
      (step): step is EditorScene['steps'][number] => Boolean(step),
    );
    const urls = new Map<string, Promise<string>>();
    const previewFor = async (step: EditorScene['steps'][number]): Promise<string | undefined> => {
      if (step.image) return step.image;
      const reference = references.get(step.id);
      if (!reference) return undefined;
      const identity = payloadIdentity(reference);
      let pending = urls.get(identity);
      if (!pending) {
        pending = (async () => {
          const url = createPayloadObjectUrl(
            await verifyPayload(reference, await resolvePayload(reference)),
          );
          createdUrls.add(url);
          return url;
        })();
        urls.set(identity, pending);
      }
      return pending;
    };
    try {
      [firstImage, finalImage] = await Promise.all(selectedSteps.map(previewFor));
    } catch (error) {
      releaseLocalMediaUrls([...createdUrls]);
      throw error;
    }
    finalImage ??= firstImage;
  }
  return {
    id: record.scene.id,
    title: record.scene.title,
    description: record.scene.description,
    stepCount: record.scene.steps.length,
    savedAt: record.savedAt,
    revision: record.revision,
    firstImage,
    finalImage,
    tags: [...record.scene.tags],
    publicationStatus: record.scene.portableSource?.status ?? 'draft',
    audiences: record.scene.portableSource?.audience?.length
      ? [...record.scene.portableSource.audience]
      : record.scene.audience
          .split(',')
          .map((audience) => audience.trim())
          .filter(Boolean),
    capability: record.scene.portableSource?.capability ?? 'captured',
    runStatus: record.scene.verified?.status ?? 'stale',
    verification: record.scene.verified ? { ...record.scene.verified } : undefined,
    evidenceRuns: summarizeRunEvidence(record.scene),
    automationLevel: record.scene.portableSource?.automation?.level ?? 'none',
    checkCount:
      record.scene.portableSource?.steps?.reduce((count, step) => count + step.checks.length, 0) ??
      0,
    translationCount: Object.keys(record.scene.translations ?? {}).length,
    screenStepCount: record.scene.steps.filter((step) => step.type === 'screen').length,
    screenAssetCount: record.scene.steps.filter(
      (step) =>
        step.type === 'screen' && (Boolean(step.image) || referencedImageStepIds.has(step.id)),
    ).length,
    opaqueMaskCount: record.scene.steps.reduce(
      (count, step) => count + step.masks.filter((mask) => mask.mode === 'opaque').length,
      0,
    ),
    hiddenStepCount: record.scene.steps.filter(
      (step) => !Object.values(step.outputVisibility).some(Boolean),
    ).length,
    sample: record.scene.sample ?? false,
  };
}

function hydrateCompactRecord(
  compact: CompactStoredSceneRecord,
  payloads: ReadonlyMap<string, ScenePayloadRecord>,
  objectUrls: Map<string, string>,
): StoredSceneRecord {
  const scene = normalizeLegacyMaskMetadata(compact.scene);
  const stepIds = new Set<string>();
  for (const step of scene.steps) {
    if (stepIds.has(step.id)) {
      throw new ScenePayloadIntegrityError(`Scene “${scene.id}” has duplicate step IDs.`);
    }
    stepIds.add(step.id);
  }
  const assetEntries = Object.entries(scene.portableAssets ?? {});
  const sidecarEntries = Object.entries(scene.portableSidecars ?? {});
  const evidenceAssetEntries = Object.entries(scene.runEvidenceAssets ?? {});
  const assetKeys = new Set(assetEntries.map(([key]) => key));
  const sidecarKeys = new Set(sidecarEntries.map(([key]) => key));
  const evidenceAssetKeys = new Set(evidenceAssetEntries.map(([key]) => key));
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for (const reference of compact.payloadRefs) {
    const payload = payloads.get(payloadIdentity(reference));
    if (!payload) {
      throw new ScenePayloadIntegrityError(
        `Embedded payload ${reference.sha256} (${reference.mediaType}) is missing.`,
      );
    }
    let value: string;
    if (reference.representation === 'utf8') {
      try {
        value = decoder.decode(payload.bytes);
      } catch (error) {
        throw new ScenePayloadIntegrityError(
          `Embedded payload ${reference.sha256} is not valid UTF-8.`,
          'read',
          error,
        );
      }
      const embeddedMediaType = dataUriMediaType(value, 'read');
      if (embeddedMediaType && embeddedMediaType !== reference.mediaType) {
        throw new ScenePayloadIntegrityError(
          `Embedded payload ${reference.sha256} has conflicting media metadata.`,
        );
      }
    } else {
      const identity = payloadIdentity(reference);
      value = objectUrls.get(identity) ?? createPayloadObjectUrl(payload);
      objectUrls.set(identity, value);
    }

    if (reference.slot === 'step-image') {
      const step = scene.steps.find((candidate) => candidate.id === reference.key);
      if (!step || step.image !== undefined) {
        throw new ScenePayloadIntegrityError(
          `Embedded image reference targets an invalid step “${reference.key}”.`,
        );
      }
      step.image = value;
    } else if (reference.slot === 'portable-asset') {
      if (scene.portableAssets === undefined) {
        throw new ScenePayloadIntegrityError(
          `Portable asset “${reference.key}” has no compact asset container.`,
        );
      }
      if (assetKeys.has(reference.key)) {
        throw new ScenePayloadIntegrityError(
          `Portable asset “${reference.key}” is stored both inline and by reference.`,
        );
      }
      assetKeys.add(reference.key);
      assetEntries.push([reference.key, value]);
    } else if (reference.slot === 'portable-sidecar') {
      if (scene.portableSidecars === undefined) {
        throw new ScenePayloadIntegrityError(
          `Portable sidecar “${reference.key}” has no compact sidecar container.`,
        );
      }
      if (sidecarKeys.has(reference.key)) {
        throw new ScenePayloadIntegrityError(
          `Portable sidecar “${reference.key}” is stored both inline and by reference.`,
        );
      }
      sidecarKeys.add(reference.key);
      sidecarEntries.push([reference.key, value]);
    } else {
      if (scene.runEvidenceAssets === undefined) {
        throw new ScenePayloadIntegrityError(
          `Run evidence asset “${reference.key}” has no compact asset container.`,
        );
      }
      if (evidenceAssetKeys.has(reference.key)) {
        throw new ScenePayloadIntegrityError(
          `Run evidence asset “${reference.key}” is stored both inline and by reference.`,
        );
      }
      if (reference.key !== reference.sha256) {
        throw new ScenePayloadIntegrityError(
          `Run evidence asset “${reference.key}” does not match its content identity.`,
        );
      }
      evidenceAssetKeys.add(reference.key);
      evidenceAssetEntries.push([reference.key, value]);
    }
  }
  if (scene.portableAssets !== undefined) scene.portableAssets = Object.fromEntries(assetEntries);
  if (scene.portableSidecars !== undefined) {
    scene.portableSidecars = Object.fromEntries(sidecarEntries);
  }
  if (scene.runEvidenceAssets !== undefined) {
    scene.runEvidenceAssets = Object.fromEntries(evidenceAssetEntries);
  }
  return {
    id: compact.id,
    scene,
    savedAt: compact.savedAt,
    revision: compact.revision,
  };
}

export async function hydrateStoredSceneRecords(
  values: readonly unknown[],
  resolvePayload: (reference: ScenePayloadReference) => Promise<unknown>,
): Promise<StoredSceneRecord[]> {
  const envelopes = values.map((value) => {
    const envelope = readStoredEnvelope(value);
    if (!envelope) {
      throw new SceneStorageError(
        'Saved Scene data is invalid. Studio left it untouched for recovery.',
        'read',
      );
    }
    return envelope;
  });
  const references = new Map<string, ScenePayloadReference>();
  for (const envelope of envelopes) {
    if (envelope.kind !== 'compact') continue;
    for (const reference of envelope.record.payloadRefs) {
      const identity = payloadIdentity(reference);
      const existing = references.get(identity);
      if (existing && existing.byteLength !== reference.byteLength) {
        throw new ScenePayloadIntegrityError(
          `Embedded payload ${reference.sha256} has conflicting lengths.`,
        );
      }
      references.set(identity, reference);
    }
  }
  const payloads = new Map<string, ScenePayloadRecord>();
  await Promise.all(
    [...references.entries()].map(async ([identity, reference]) => {
      const payload = await verifyPayload(reference, await resolvePayload(reference));
      payloads.set(identity, payload);
    }),
  );
  const objectUrls = new Map<string, string>();
  try {
    return envelopes.map((envelope) =>
      envelope.kind === 'legacy'
        ? {
            ...structuredClone(envelope.record),
            scene: normalizeLegacyMaskMetadata(envelope.record.scene),
          }
        : hydrateCompactRecord(envelope.record, payloads, objectUrls),
    );
  } catch (error) {
    releaseLocalMediaUrls([...objectUrls.values()]);
    throw error;
  }
}

export async function hydrateStoredSceneRecord(
  value: unknown,
  resolvePayload: (reference: ScenePayloadReference) => Promise<unknown>,
): Promise<StoredSceneRecord> {
  return (await hydrateStoredSceneRecords([value], resolvePayload))[0]!;
}

function stagePayloads(
  transaction: IDBTransaction,
  payloads: readonly ScenePayloadRecord[],
  complete: () => void,
  fail: (error: SceneStorageError) => void,
): void {
  if (payloads.length === 0) {
    complete();
    return;
  }
  const store = transaction.objectStore(PAYLOAD_STORE_NAME);
  let remaining = payloads.length;
  const done = () => {
    remaining -= 1;
    if (remaining === 0) complete();
  };
  for (const payload of payloads) {
    const request = store.get([payload.sha256, payload.mediaType]);
    request.onsuccess = () => {
      if (request.result === undefined) {
        const add = store.add(payload);
        add.onsuccess = done;
        return;
      }
      const existing = readPayloadRecord(request.result);
      if (
        !existing ||
        existing.sha256 !== payload.sha256 ||
        existing.mediaType !== payload.mediaType ||
        existing.byteLength !== payload.byteLength ||
        !bytesEqual(existing.bytes, payload.bytes)
      ) {
        fail(
          new ScenePayloadIntegrityError(
            `Stored payload ${payload.sha256} (${payload.mediaType}) conflicts with new bytes.`,
            'write',
          ),
        );
        return;
      }
      done();
    };
  }
}

function referencedPayloads(values: readonly unknown[]): Set<string> {
  const references = new Set<string>();
  for (const value of values) {
    const envelope = readStoredEnvelope(value);
    if (!envelope) {
      throw new ScenePayloadIntegrityError(
        'Studio stopped local media cleanup because a saved Scene record is invalid.',
        'delete',
      );
    }
    if (envelope.kind === 'compact') {
      for (const reference of envelope.record.payloadRefs) {
        references.add(payloadIdentity(reference));
      }
    }
  }
  return references;
}

function beginPayloadGarbageCollection(
  transaction: IDBTransaction,
  fail: (error: SceneStorageError) => void,
): void {
  const sceneRequest = transaction.objectStore(STORE_NAME).getAll();
  const versionRequest = transaction.objectStore(VERSION_STORE_NAME).getAll();
  let scenes: unknown[] | undefined;
  let versions: unknown[] | undefined;
  const scan = () => {
    if (!scenes || !versions) return;
    // Synchronous crash journals never own media bytes: omitted media is hydrated from the
    // current durable Scene. Retaining every current Scene reference therefore also retains every
    // payload reachable by a compact recovery record.
    let references: Set<string>;
    try {
      references = referencedPayloads([...scenes, ...versions]);
    } catch (error) {
      fail(
        error instanceof SceneStorageError
          ? error
          : new ScenePayloadIntegrityError('Studio stopped unsafe local media cleanup.', 'delete'),
      );
      return;
    }
    const cursorRequest = transaction.objectStore(PAYLOAD_STORE_NAME).openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const payload = readPayloadRecord(cursor.value);
      if (!payload || payloadIdentity(payload) !== payloadIdentityFromKey(cursor.primaryKey)) {
        fail(
          new ScenePayloadIntegrityError(
            'Studio stopped local media cleanup because a payload record is invalid.',
            'delete',
          ),
        );
        return;
      }
      if (!references.has(payloadIdentity(payload))) cursor.delete();
      cursor.continue();
    };
  };
  sceneRequest.onsuccess = () => {
    scenes = sceneRequest.result as unknown[];
    scan();
  };
  versionRequest.onsuccess = () => {
    versions = versionRequest.result as unknown[];
    scan();
  };
}

function payloadIdentityFromKey(key: IDBValidKey): string {
  if (
    !Array.isArray(key) ||
    key.length !== 2 ||
    typeof key[0] !== 'string' ||
    typeof key[1] !== 'string'
  ) {
    return '';
  }
  return `${key[0]}\u0000${key[1]}`;
}

/**
 * Applies only additive, idempotent IndexedDB schema changes. Keeping this separate from the open
 * request makes the repair contract testable without replacing a user's real browser database.
 */
export function upgradeStudioDatabaseSchema(
  database: IDBDatabase,
  transaction: IDBTransaction,
): void {
  if (!database.objectStoreNames.contains(STORE_NAME)) {
    const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
    store.createIndex('savedAt', 'savedAt');
    store.createIndex('savedAtId', ['savedAt', 'id']);
  } else {
    const store = transaction.objectStore(STORE_NAME);
    if (!store.indexNames.contains('savedAt')) store.createIndex('savedAt', 'savedAt');
    if (!store.indexNames.contains('savedAtId')) {
      store.createIndex('savedAtId', ['savedAt', 'id']);
    }
  }
  if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) {
    database.createObjectStore(PROJECT_STORE_NAME, { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains(VERSION_STORE_NAME)) {
    const versions = database.createObjectStore(VERSION_STORE_NAME, {
      keyPath: ['id', 'revision'],
    });
    versions.createIndex('sceneId', 'id');
  } else {
    const versions = transaction.objectStore(VERSION_STORE_NAME);
    if (!versions.indexNames.contains('sceneId')) versions.createIndex('sceneId', 'id');
  }
  if (!database.objectStoreNames.contains(PAYLOAD_STORE_NAME)) {
    database.createObjectStore(PAYLOAD_STORE_NAME, {
      keyPath: ['sha256', 'mediaType'],
    });
  }
}

export class IndexedDbSceneStorage implements SceneStorageBackend {
  #database: Promise<IDBDatabase> | null = null;

  #open(): Promise<IDBDatabase> {
    if (this.#database) return this.#database;
    if (typeof indexedDB === 'undefined') {
      throw new SceneStorageError('IndexedDB is unavailable in this browser.', 'open');
    }
    this.#database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, STUDIO_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        upgradeStudioDatabaseSchema(request.result, request.transaction!);
      };
      request.onsuccess = () => {
        const database = request.result;
        const requiredStores = [
          STORE_NAME,
          PROJECT_STORE_NAME,
          VERSION_STORE_NAME,
          PAYLOAD_STORE_NAME,
        ];
        const missingStores = requiredStores.filter(
          (storeName) => !database.objectStoreNames.contains(storeName),
        );
        if (missingStores.length > 0) {
          database.close();
          this.#database = null;
          reject(
            new SceneStorageError(
              `Studio's local database is missing required storage (${missingStores.join(', ')}). No data was changed.`,
              'open',
            ),
          );
          return;
        }
        database.onversionchange = () => {
          database.close();
          this.#database = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        this.#database = null;
        reject(
          new SceneStorageError(
            'Studio could not open its local workspace database.',
            'open',
            request.error,
          ),
        );
      };
      request.onblocked = () => {
        this.#database = null;
        reject(
          new SceneStorageError(
            'Another Studio tab is blocking a local database upgrade. Close older tabs and retry.',
            'open',
          ),
        );
      };
    });
    return this.#database;
  }

  async #hydrate(values: readonly unknown[]): Promise<StoredSceneRecord[]> {
    const database = await this.#open();
    const transaction = database.transaction(PAYLOAD_STORE_NAME, 'readonly');
    const store = transaction.objectStore(PAYLOAD_STORE_NAME);
    return hydrateStoredSceneRecords(values, (reference) =>
      requestResult(store.get([reference.sha256, reference.mediaType]), 'read'),
    );
  }

  async #migrateLegacyRecord(
    legacy: StoredSceneRecord,
    destination: typeof STORE_NAME | typeof VERSION_STORE_NAME,
  ): Promise<void> {
    let compacted: CompactedSceneRecord;
    try {
      compacted = await compactStoredSceneRecord(legacy);
    } catch {
      // A legacy inline record remains the lossless source of truth if compaction cannot finish
      // (for example, an expired blob URL or storage pressure). A later read retries it.
      return;
    }
    const database = await this.#open();
    const transaction = database.transaction([destination, PAYLOAD_STORE_NAME], 'readwrite');
    const destinationStore = transaction.objectStore(destination);
    const key: IDBValidKey = destination === STORE_NAME ? legacy.id : [legacy.id, legacy.revision];
    await new Promise<void>((resolve, reject) => {
      let migrationError: SceneStorageError | undefined;
      const fail = (error: SceneStorageError) => {
        migrationError = error;
        transaction.abort();
      };
      const currentRequest = destinationStore.get(key);
      currentRequest.onsuccess = () => {
        const current = readStoredEnvelope(currentRequest.result);
        if (
          !current ||
          current.kind !== 'legacy' ||
          current.record.revision !== legacy.revision ||
          current.record.savedAt !== legacy.savedAt
        ) {
          return;
        }
        stagePayloads(
          transaction,
          compacted.payloads,
          () => destinationStore.put(compacted.record),
          fail,
        );
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          migrationError ??
            new SceneStorageError(
              'Studio could not compact a legacy local Scene record.',
              'write',
              transaction.error,
            ),
        );
      transaction.onerror = () => undefined;
    }).catch(() => {
      // Never trade readability of the intact v3 record for a failed optimization.
    });
  }

  async #migrateLegacyBatch(
    values: readonly unknown[],
    destination: typeof STORE_NAME | typeof VERSION_STORE_NAME,
  ): Promise<void> {
    const legacy = values
      .map(readStoredEnvelope)
      .filter(
        (envelope): envelope is { kind: 'legacy'; record: StoredSceneRecord } =>
          envelope?.kind === 'legacy',
      )
      .slice(0, LEGACY_MIGRATION_BATCH_SIZE);
    for (const envelope of legacy) {
      await this.#migrateLegacyRecord(envelope.record, destination);
    }
  }

  async get(id: string): Promise<StoredSceneRecord | null> {
    const database = await this.#open();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(id), 'read');
    if (value === undefined) return null;
    const records = await this.#hydrate([value]);
    await this.#migrateLegacyBatch([value], STORE_NAME);
    return records[0]!;
  }

  async listSummaryPage(request: ScenePageRequest = {}): Promise<ScenePage<SceneSummary>> {
    const limit = pageSize(request.limit);
    const cursor = decodeSceneCursor(request.cursor);
    if (request.cursor && !cursor) {
      throw new SceneStorageError('The catalog page cursor is invalid.', 'read');
    }
    const database = await this.#open();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const index = transaction.objectStore(STORE_NAME).index('savedAtId');
    const range = cursor ? IDBKeyRange.upperBound(cursor, true) : undefined;
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const page: unknown[] = [];
      const cursorRequest = index.openCursor(range, 'prev');
      cursorRequest.onsuccess = () => {
        const item = cursorRequest.result;
        if (!item || page.length >= limit + 1) {
          resolve(page);
          return;
        }
        page.push(item.value);
        item.continue();
      };
      cursorRequest.onerror = () =>
        reject(
          new SceneStorageError(
            'The local Scene catalog could not be read.',
            'read',
            cursorRequest.error,
          ),
        );
    });
    const hasMore = values.length > limit;
    const pageValues = values.slice(0, limit);
    const payloadTransaction = request.includePreviews
      ? database.transaction(PAYLOAD_STORE_NAME, 'readonly')
      : null;
    const payloadStore = payloadTransaction?.objectStore(PAYLOAD_STORE_NAME);
    const summaryResults = await Promise.allSettled(
      pageValues.map((value) =>
        summarizeStoredSceneRecord(value, Boolean(request.includePreviews), (reference) =>
          payloadStore
            ? requestResult(payloadStore.get([reference.sha256, reference.mediaType]), 'read')
            : Promise.resolve(undefined),
        ),
      ),
    );
    const failedSummary = summaryResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedSummary) {
      releaseLocalMediaUrls(
        summaryResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
      );
      throw failedSummary.reason;
    }
    const items = summaryResults.map(
      (result) => (result as PromiseFulfilledResult<SceneSummary>).value,
    );
    await this.#migrateLegacyBatch(pageValues, STORE_NAME);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeSceneCursor(last.savedAt, last.id) : null,
    };
  }

  async put(record: StoredSceneRecord, expectedRevision: number): Promise<void> {
    await this.putBatch([{ record, expectedRevision }]);
  }

  async putBatch(writes: readonly SceneBatchWrite[], project?: StoredProjectRecord): Promise<void> {
    const compactedWrites = await Promise.all(
      writes.map(async (write) => ({
        expectedRevision: write.expectedRevision,
        compacted: await compactStoredSceneRecord(write.record),
      })),
    );
    const identities = new Set<string>();
    for (const { compacted } of compactedWrites) {
      if (identities.has(compacted.record.id)) {
        throw new SceneStorageError('Studio refused a batch with duplicate Scene IDs.', 'write');
      }
      identities.add(compacted.record.id);
    }
    const database = await this.#open();
    const stores = [STORE_NAME, VERSION_STORE_NAME, PAYLOAD_STORE_NAME];
    if (project) stores.push(PROJECT_STORE_NAME);
    const transaction = database.transaction(stores, 'readwrite');
    const sceneStore = transaction.objectStore(STORE_NAME);
    const versionStore = transaction.objectStore(VERSION_STORE_NAME);
    await new Promise<void>((resolve, reject) => {
      let writeError: SceneStorageError | undefined;
      const fail = (error: SceneStorageError) => {
        if (writeError) return;
        writeError = error;
        transaction.abort();
      };
      let index = 0;
      const writeNext = () => {
        const write = compactedWrites[index];
        if (!write) {
          if (project) transaction.objectStore(PROJECT_STORE_NAME).put(project);
          return;
        }
        const { compacted, expectedRevision } = write;
        const currentRequest = sceneStore.get(compacted.record.id);
        currentRequest.onsuccess = () => {
          const current =
            currentRequest.result === undefined ? null : readStoredEnvelope(currentRequest.result);
          if (currentRequest.result !== undefined && !current) {
            fail(
              new SceneStorageError(
                `The saved data for “${compacted.record.id}” is invalid. Studio left it untouched for recovery.`,
                'write',
              ),
            );
            return;
          }
          const actualRevision = current?.record.revision ?? 0;
          if (
            actualRevision !== expectedRevision ||
            compacted.record.revision !== expectedRevision + 1
          ) {
            fail(
              new SceneRevisionConflictError(compacted.record.id, expectedRevision, actualRevision),
            );
            return;
          }
          stagePayloads(
            transaction,
            compacted.payloads,
            () => {
              sceneStore.put(compacted.record);
              // History remains append-only. add() aborts instead of replacing a revision.
              versionStore.add(compacted.record);
              index += 1;
              writeNext();
            },
            fail,
          );
        };
      };
      writeNext();
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          writeError ??
            new SceneStorageError(
              'Studio could not save this Scene locally.',
              'write',
              transaction.error,
            ),
        );
      transaction.onerror = () => undefined;
    });
    // The write above is already committed. Retention/GC is best-effort maintenance and must not
    // make a successful save look uncommitted (which would turn its retry into a false conflict).
    const maintenanceIds = coalesceMaintenanceSceneIds(
      compactedWrites.map(({ compacted }) => compacted.record.id),
    );
    void settlePostCommitMaintenance(
      maintenanceIds.length ? [this.#pruneVersionsAndGarbageCollect(maintenanceIds)] : [],
    );
  }

  async #pruneVersionsAndGarbageCollect(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const database = await this.#open();
    const transaction = database.transaction(
      [STORE_NAME, VERSION_STORE_NAME, PAYLOAD_STORE_NAME],
      'readwrite',
    );
    const versionStore = transaction.objectStore(VERSION_STORE_NAME);
    await new Promise<void>((resolve, reject) => {
      let cleanupError: SceneStorageError | undefined;
      const fail = (error: SceneStorageError) => {
        cleanupError = error;
        transaction.abort();
      };
      let remaining = ids.length;
      let removedStaleRevision = false;
      const finishPruning = () => {
        remaining -= 1;
        if (remaining === 0 && removedStaleRevision) {
          // The whole committed batch shares one global reference/payload scan.
          beginPayloadGarbageCollection(transaction, fail);
        }
      };
      for (const id of ids) {
        const keysRequest = versionStore.index('sceneId').getAllKeys(id);
        keysRequest.onsuccess = () => {
          const keys = keysRequest.result.sort((left, right) => {
            const leftRevision = Array.isArray(left) ? Number(left[1]) : 0;
            const rightRevision = Array.isArray(right) ? Number(right[1]) : 0;
            return rightRevision - leftRevision;
          });
          const stale = keys.slice(MAX_LOCAL_VERSIONS);
          if (stale.length > 0) removedStaleRevision = true;
          for (const key of stale) versionStore.delete(key);
          finishPruning();
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          cleanupError ??
            new SceneStorageError(
              'Studio could not prune old local Scene revisions.',
              'write',
              transaction.error,
            ),
        );
      transaction.onerror = () => undefined;
    });
  }

  async delete(id: string): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(
      [STORE_NAME, VERSION_STORE_NAME, PAYLOAD_STORE_NAME],
      'readwrite',
    );
    const sceneStore = transaction.objectStore(STORE_NAME);
    const versionStore = transaction.objectStore(VERSION_STORE_NAME);
    await new Promise<void>((resolve, reject) => {
      let cleanupError: SceneStorageError | undefined;
      const fail = (error: SceneStorageError) => {
        cleanupError = error;
        transaction.abort();
      };
      sceneStore.delete(id);
      const cursorRequest = versionStore.index('sceneId').openKeyCursor(IDBKeyRange.only(id));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          versionStore.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }
        beginPayloadGarbageCollection(transaction, fail);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          cleanupError ??
            new SceneStorageError(
              'Studio could not delete this Scene locally.',
              'delete',
              transaction.error,
            ),
        );
      transaction.onerror = () => undefined;
    });
  }

  async listVersionSummaries(
    id: string,
    request: ScenePageRequest = {},
  ): Promise<ScenePage<SceneVersionSummary>> {
    const limit = pageSize(request.limit);
    const cursor = decodeVersionCursor(request.cursor);
    if (request.cursor && !cursor) {
      throw new SceneStorageError('The revision page cursor is invalid.', 'read');
    }
    const database = await this.#open();
    const transaction = database.transaction(VERSION_STORE_NAME, 'readonly');
    const upperRevision = cursor ? cursor - 1 : Number.MAX_SAFE_INTEGER;
    if (upperRevision < 1) return { items: [], nextCursor: null };
    const range = IDBKeyRange.bound([id, 1], [id, upperRevision]);
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const page: unknown[] = [];
      const cursorRequest = transaction.objectStore(VERSION_STORE_NAME).openCursor(range, 'prev');
      cursorRequest.onsuccess = () => {
        const item = cursorRequest.result;
        if (!item || page.length >= limit + 1) {
          resolve(page);
          return;
        }
        page.push(item.value);
        item.continue();
      };
      cursorRequest.onerror = () =>
        reject(
          new SceneStorageError(
            'Local Scene revisions could not be read.',
            'read',
            cursorRequest.error,
          ),
        );
    });
    const hasMore = values.length > limit;
    const pageValues = values.slice(0, limit);
    const items = pageValues.map((value) => {
      const envelope = readStoredEnvelope(value);
      if (!envelope) {
        throw new SceneStorageError(
          'Saved revision data is invalid. Studio left it untouched for recovery.',
          'read',
        );
      }
      return versionSummary(envelope);
    });
    await this.#migrateLegacyBatch(pageValues, VERSION_STORE_NAME);
    return {
      items,
      nextCursor: hasMore && items.length ? String(items.at(-1)!.revision) : null,
    };
  }

  async getVersion(id: string, revision: number): Promise<StoredSceneRecord | null> {
    const database = await this.#open();
    const transaction = database.transaction(VERSION_STORE_NAME, 'readonly');
    const value = await requestResult(
      transaction.objectStore(VERSION_STORE_NAME).get([id, revision]),
      'read',
    );
    if (value === undefined) return null;
    const records = await this.#hydrate([value]);
    await this.#migrateLegacyBatch([value], VERSION_STORE_NAME);
    return records[0]!;
  }

  async getProject(id: string): Promise<StoredProjectRecord | null> {
    const database = await this.#open();
    const transaction = database.transaction(PROJECT_STORE_NAME, 'readonly');
    const value = await requestResult(transaction.objectStore(PROJECT_STORE_NAME).get(id), 'read');
    if (value === undefined) return null;
    const record = value as Partial<StoredProjectRecord>;
    if (
      record.id !== id ||
      !record.project ||
      typeof record.project !== 'object' ||
      typeof record.savedAt !== 'number'
    ) {
      throw new SceneStorageError('The saved project configuration is invalid.', 'read');
    }
    return structuredClone(record as StoredProjectRecord);
  }

  async putProject(record: StoredProjectRecord): Promise<void> {
    const database = await this.#open();
    const transaction = database.transaction(PROJECT_STORE_NAME, 'readwrite');
    transaction.objectStore(PROJECT_STORE_NAME).put(record);
    await transactionComplete(transaction, 'write');
  }
}

export class MemorySceneStorage implements SceneStorageBackend {
  readonly records = new Map<string, StoredSceneRecord>();
  readonly versions = new Map<string, StoredSceneRecord[]>();
  readonly projects = new Map<string, StoredProjectRecord>();

  async get(id: string): Promise<StoredSceneRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async listSummaryPage(request: ScenePageRequest = {}): Promise<ScenePage<SceneSummary>> {
    const limit = pageSize(request.limit);
    const cursor = decodeSceneCursor(request.cursor);
    if (request.cursor && !cursor) {
      throw new SceneStorageError('The catalog page cursor is invalid.', 'read');
    }
    const sorted = [...this.records.values()].sort(
      (left, right) => right.savedAt - left.savedAt || right.id.localeCompare(left.id),
    );
    const start = cursor
      ? sorted.findIndex(
          (record) =>
            record.savedAt < cursor[0] ||
            (record.savedAt === cursor[0] && record.id.localeCompare(cursor[1]) < 0),
        )
      : 0;
    const values = start < 0 ? [] : sorted.slice(start, start + limit + 1);
    const hasMore = values.length > limit;
    const records = values.slice(0, limit);
    const items: SceneSummary[] = records.map(({ scene, savedAt, revision }) => {
      const images = request.includePreviews
        ? scene.steps.flatMap((step) => (step.image ? [step.image] : []))
        : [];
      return {
        id: scene.id,
        title: scene.title,
        description: scene.description,
        stepCount: scene.steps.length,
        savedAt,
        revision,
        firstImage: images[0],
        finalImage: images.at(-1),
        tags: [...scene.tags],
        publicationStatus: scene.portableSource?.status ?? 'draft',
        audiences: scene.portableSource?.audience?.length
          ? [...scene.portableSource.audience]
          : scene.audience
              .split(',')
              .map((audience) => audience.trim())
              .filter(Boolean),
        capability: scene.portableSource?.capability ?? 'captured',
        runStatus: scene.verified?.status ?? 'stale',
        verification: scene.verified ? { ...scene.verified } : undefined,
        evidenceRuns: summarizeRunEvidence(scene),
        automationLevel: scene.portableSource?.automation?.level ?? 'none',
        checkCount:
          scene.portableSource?.steps?.reduce((count, step) => count + step.checks.length, 0) ?? 0,
        translationCount: Object.keys(scene.translations ?? {}).length,
        screenStepCount: scene.steps.filter((step) => step.type === 'screen').length,
        screenAssetCount: scene.steps.filter(
          (step) => step.type === 'screen' && Boolean(step.image),
        ).length,
        opaqueMaskCount: scene.steps.reduce(
          (count, step) => count + step.masks.filter((mask) => mask.mode === 'opaque').length,
          0,
        ),
        hiddenStepCount: scene.steps.filter(
          (step) => !Object.values(step.outputVisibility).some(Boolean),
        ).length,
        sample: scene.sample ?? false,
      };
    });
    const last = items.at(-1);
    return {
      items: structuredClone(items),
      nextCursor: hasMore && last ? encodeSceneCursor(last.savedAt, last.id) : null,
    };
  }

  async put(record: StoredSceneRecord, expectedRevision: number): Promise<void> {
    await this.putBatch([{ record, expectedRevision }]);
  }

  async putBatch(writes: readonly SceneBatchWrite[], project?: StoredProjectRecord): Promise<void> {
    const nextRecords = new Map(
      [...this.records].map(([id, record]) => [id, structuredClone(record)]),
    );
    const nextVersions = new Map(
      [...this.versions].map(([id, records]) => [id, structuredClone(records)]),
    );
    const nextProject = project ? structuredClone(project) : undefined;
    const batchIds = new Set<string>();
    for (const { record, expectedRevision } of writes) {
      if (!readLegacyStoredRecord(record) || batchIds.has(record.id)) {
        throw new SceneStorageError('Studio refused an invalid atomic Scene batch.', 'write');
      }
      batchIds.add(record.id);
      const actualRevision = nextRecords.get(record.id)?.revision ?? 0;
      if (actualRevision !== expectedRevision || record.revision !== expectedRevision + 1) {
        throw new SceneRevisionConflictError(record.id, expectedRevision, actualRevision);
      }
      if (nextVersions.get(record.id)?.some((item) => item.revision === record.revision)) {
        throw new SceneRevisionConflictError(record.id, expectedRevision, actualRevision);
      }
      nextRecords.set(record.id, structuredClone(record));
      const previous = nextVersions.get(record.id) ?? [];
      nextVersions.set(
        record.id,
        [structuredClone(record), ...previous]
          .sort((left, right) => right.revision - left.revision)
          .slice(0, MAX_LOCAL_VERSIONS),
      );
    }
    this.records.clear();
    this.versions.clear();
    for (const [id, record] of nextRecords) this.records.set(id, record);
    for (const [id, records] of nextVersions) this.versions.set(id, records);
    if (nextProject) this.projects.set(nextProject.id, nextProject);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
    this.versions.delete(id);
  }

  async listVersionSummaries(
    id: string,
    request: ScenePageRequest = {},
  ): Promise<ScenePage<SceneVersionSummary>> {
    const limit = pageSize(request.limit);
    const cursor = decodeVersionCursor(request.cursor);
    if (request.cursor && !cursor) {
      throw new SceneStorageError('The revision page cursor is invalid.', 'read');
    }
    const versions = (this.versions.get(id) ?? []).filter(
      (record) => cursor === null || record.revision < cursor,
    );
    const hasMore = versions.length > limit;
    const items = versions
      .slice(0, limit)
      .map((record) => versionSummary({ kind: 'legacy', record }));
    return {
      items: structuredClone(items),
      nextCursor: hasMore && items.length ? String(items.at(-1)!.revision) : null,
    };
  }

  async getVersion(id: string, revision: number): Promise<StoredSceneRecord | null> {
    const record = this.versions.get(id)?.find((candidate) => candidate.revision === revision);
    return record ? structuredClone(record) : null;
  }

  async getProject(id: string): Promise<StoredProjectRecord | null> {
    const record = this.projects.get(id);
    return record ? structuredClone(record) : null;
  }

  async putProject(record: StoredProjectRecord): Promise<void> {
    this.projects.set(record.id, structuredClone(record));
  }
}

export class LocalStorageRecoveryJournal implements RecoveryJournal {
  #token = 0;

  read(id: string): RecoveryRecord | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const source = localStorage.getItem(`${RECOVERY_PREFIX}${id}`);
      if (!source) return null;
      const record = JSON.parse(source) as Partial<RecoveryRecord>;
      if (
        record.id !== id ||
        !isEditorScene(record.scene) ||
        typeof record.updatedAt !== 'number' ||
        typeof record.token !== 'number' ||
        (record.omittedMedia !== undefined &&
          (!record.omittedMedia ||
            !Array.isArray(record.omittedMedia.imageStepIds) ||
            !record.omittedMedia.imageStepIds.every((stepId) => typeof stepId === 'string') ||
            typeof record.omittedMedia.portablePayload !== 'boolean' ||
            (record.omittedMedia.evidencePayload !== undefined &&
              typeof record.omittedMedia.evidencePayload !== 'boolean')))
      ) {
        return null;
      }
      this.#token = Math.max(this.#token, record.token);
      return {
        ...(record as RecoveryRecord),
        scene: normalizeLegacyMaskMetadata(record.scene),
      };
    } catch {
      return null;
    }
  }

  write(scene: EditorScene): RecoveryRecord {
    // localStorage is synchronous. Keep its hot path bounded by retaining only editable metadata;
    // durable IndexedDB saves remain the source of truth for embedded screenshots and archives.
    const compactScene = cloneEditorWorkingScene(scene);
    const imageStepIds: string[] = [];
    for (const step of compactScene.steps) {
      if (
        step.image &&
        (step.image.startsWith('data:') ||
          step.image.startsWith('blob:') ||
          step.image.length > 16_384)
      ) {
        imageStepIds.push(step.id);
        step.image = undefined;
      }
    }
    const portablePayload = Boolean(
      compactScene.portableSource || compactScene.portableAssets || compactScene.portableSidecars,
    );
    const evidencePayload = Boolean(compactScene.runEvidence || compactScene.runEvidenceAssets);
    compactScene.portableSource = undefined;
    compactScene.portableAssets = undefined;
    compactScene.portableSidecars = undefined;
    compactScene.runEvidence = undefined;
    compactScene.runEvidenceAssets = undefined;

    const record: RecoveryRecord = {
      id: scene.id,
      scene: compactScene,
      updatedAt: Date.now(),
      token: ++this.#token,
      omittedMedia:
        imageStepIds.length > 0 || portablePayload || evidencePayload
          ? {
              imageStepIds,
              portablePayload,
              ...(evidencePayload ? { evidencePayload: true } : {}),
            }
          : undefined,
    };
    if (typeof localStorage === 'undefined') return record;
    try {
      const serialized = JSON.stringify(record);
      const byteLength = new TextEncoder().encode(serialized).byteLength;
      if (byteLength > MAX_RECOVERY_BYTES) {
        throw new SceneStorageError(
          'Crash recovery is limited to 1 MB of text and layout data. Save or split this Scene before continuing.',
          'write',
        );
      }
      localStorage.setItem(`${RECOVERY_PREFIX}${scene.id}`, serialized);
    } catch (error) {
      if (error instanceof SceneStorageError) throw error;
      throw new SceneStorageError(
        'Studio could not write the crash-recovery journal. Browser storage may be full.',
        'write',
        error,
      );
    }
    return record;
  }

  clear(id: string, token?: number): void {
    if (typeof localStorage === 'undefined') return;
    if (token !== undefined && this.read(id)?.token !== token) return;
    localStorage.removeItem(`${RECOVERY_PREFIX}${id}`);
  }
}

export class MemoryRecoveryJournal implements RecoveryJournal {
  readonly records = new Map<string, RecoveryRecord>();
  #token = 0;

  read(id: string): RecoveryRecord | null {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  write(scene: EditorScene): RecoveryRecord {
    const record = {
      id: scene.id,
      scene: cloneScene(scene),
      updatedAt: Date.now(),
      token: ++this.#token,
    };
    this.records.set(scene.id, record);
    return structuredClone(record);
  }

  clear(id: string, token?: number): void {
    if (token !== undefined && this.records.get(id)?.token !== token) return;
    this.records.delete(id);
  }
}

function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replaceAll(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 100) || 'untitled-scene'
  );
}

export function createBlankScene(id: string, title: string): EditorScene {
  return {
    version: 1,
    id,
    title: title.trim() || 'Untitled Scene',
    description: '',
    audience: '',
    tags: [],
    steps: [defaultStep('step-1')],
    theme: {
      accent: '#b83b24',
      paper: '#fbf7ef',
      ink: '#191816',
      radius: 14,
      frame: 'dark',
    },
  };
}

export class SceneLibrary {
  #saveQueues = new Map<string, Promise<StoredSceneRecord>>();
  #baseRevisions = new Map<string, number>();
  #activeProjectId = 'local-workspace';

  constructor(
    readonly storage: SceneStorageBackend,
    readonly recovery: RecoveryJournal,
  ) {}

  async #legacy(id: string): Promise<EditorScene | null> {
    if (typeof localStorage === 'undefined') return null;
    const key = `${LEGACY_PREFIX}${id}`;
    const source = localStorage.getItem(key);
    if (!source) return null;
    try {
      const scene = JSON.parse(source) as unknown;
      if (!isEditorScene(scene)) return null;
      await this.save(scene);
      localStorage.removeItem(key);
      return cloneScene(scene);
    } catch {
      return null;
    }
  }

  async load(id: string): Promise<LoadedScene> {
    let saved = await this.storage.get(id);
    let migratedLegacy = false;
    if (!saved) {
      const legacy = await this.#legacy(id);
      if (legacy) {
        saved = await this.storage.get(id);
        migratedLegacy = true;
      }
    }
    const recovery = this.recovery.read(id);
    const hydratedRecovery = recovery
      ? (() => {
          const hydratedScene = cloneEditorWorkingScene(recovery.scene);
          if (recovery.omittedMedia?.imageStepIds.length) {
            const durableImages = new Map(
              saved?.scene.steps.map((step) => [step.id, step.image] as const) ?? [],
            );
            for (const stepId of recovery.omittedMedia.imageStepIds) {
              const durableImage = durableImages.get(stepId);
              const step = hydratedScene.steps.find((candidate) => candidate.id === stepId);
              if (step && durableImage !== undefined) step.image = durableImage;
            }
          }
          if (recovery.omittedMedia?.portablePayload && saved) {
            hydratedScene.portableSource = saved.scene.portableSource;
            hydratedScene.portableAssets = saved.scene.portableAssets;
            hydratedScene.portableSidecars = saved.scene.portableSidecars;
          }
          if (recovery.omittedMedia?.evidencePayload && saved) {
            hydratedScene.runEvidence = saved.scene.runEvidence;
            hydratedScene.runEvidenceAssets = saved.scene.runEvidenceAssets;
            hydratedScene.verified = saved.scene.verified;
          }
          return {
            ...recovery,
            scene: hydratedScene,
            omittedMedia: recovery.omittedMedia
              ? {
                  imageStepIds: [...recovery.omittedMedia.imageStepIds],
                  portablePayload: recovery.omittedMedia.portablePayload,
                  evidencePayload: recovery.omittedMedia.evidencePayload,
                }
              : undefined,
          };
        })()
      : null;
    this.#baseRevisions.set(id, saved?.revision ?? 0);
    return {
      scene: saved
        ? cloneScene(saved.scene)
        : hydratedRecovery
          ? cloneEditorWorkingScene(hydratedRecovery.scene)
          : null,
      saved,
      recovery: hydratedRecovery,
      migratedLegacy,
    };
  }

  async listPage(request: ScenePageRequest = {}): Promise<ScenePage<SceneSummary>> {
    return this.storage.listSummaryPage(request);
  }

  async list(request: Omit<ScenePageRequest, 'cursor'> = {}): Promise<SceneSummary[]> {
    const summaries: SceneSummary[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.listPage({ ...request, cursor });
      summaries.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return summaries;
  }

  async listVersionSummaries(
    id: string,
    request: ScenePageRequest = {},
  ): Promise<ScenePage<SceneVersionSummary>> {
    return this.storage.listVersionSummaries(id, request);
  }

  async loadVersion(id: string, revision: number): Promise<StoredSceneRecord | null> {
    return this.storage.getVersion(id, revision);
  }

  async restoreVersion(id: string, revision: number): Promise<StoredSceneRecord> {
    const version = await this.storage.getVersion(id, revision);
    if (!version) {
      throw new SceneStorageError(`Local revision ${revision} is no longer available.`, 'read');
    }
    const current = await this.storage.listVersionSummaries(id, { limit: 1 });
    this.#baseRevisions.set(id, current.items[0]?.revision ?? 0);
    return this.save(version.scene);
  }

  writeRecovery(scene: EditorScene): RecoveryRecord {
    return this.recovery.write(scene);
  }

  async waitForPendingSaves(id: string): Promise<void> {
    const pending = this.#saveQueues.get(id);
    if (pending) await pending.then(() => undefined);
  }

  discardRecovery(id: string): void {
    this.recovery.clear(id);
  }

  async save(scene: EditorScene, recoveryToken?: number): Promise<StoredSceneRecord> {
    if (!isEditorScene(scene)) {
      throw new SceneStorageError('Studio refused to save an invalid Scene.', 'write');
    }
    const snapshot = cloneScene(scene);
    const previous = this.#saveQueues.get(scene.id) ?? Promise.resolve(null);
    const pending = previous.then(async () => {
      let expectedRevision = this.#baseRevisions.get(snapshot.id);
      if (expectedRevision === undefined) {
        const current = await this.storage.get(snapshot.id);
        if (current) {
          throw new SceneRevisionConflictError(snapshot.id, 0, current.revision);
        }
        expectedRevision = 0;
      }
      const record: StoredSceneRecord = {
        id: snapshot.id,
        scene: snapshot,
        savedAt: Date.now(),
        revision: expectedRevision + 1,
      };
      await this.storage.put(record, expectedRevision);
      this.#baseRevisions.set(snapshot.id, record.revision);
      this.recovery.clear(snapshot.id, recoveryToken);
      return record;
    });
    this.#saveQueues.set(scene.id, pending);
    try {
      return await pending;
    } finally {
      if (this.#saveQueues.get(scene.id) === pending) this.#saveQueues.delete(scene.id);
    }
  }

  async uniqueId(preferred: string): Promise<string> {
    const base = slugify(preferred);
    const existing = new Set((await this.list()).map((record) => record.id));
    if (!existing.has(base)) return base;
    let suffix = 2;
    while (existing.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  async create(title: string): Promise<EditorScene> {
    const id = await this.uniqueId(title);
    const scene = createBlankScene(id, title);
    this.#baseRevisions.set(id, 0);
    await this.save(scene);
    return scene;
  }

  async duplicate(scene: EditorScene): Promise<EditorScene> {
    const copy = cloneScene(scene);
    copy.id = await this.uniqueId(`${scene.id}-copy`);
    copy.title = `${scene.title} copy`;
    copy.portableSource = undefined;
    copy.sample = false;
    copy.verified = undefined;
    copy.runEvidence = undefined;
    copy.runEvidenceAssets = undefined;
    this.#baseRevisions.set(copy.id, 0);
    await this.save(copy);
    return copy;
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete(id);
    this.#baseRevisions.delete(id);
    this.recovery.clear(id);
  }

  /**
   * Atomically attach exact, already schema-validated Run evidence across every affected Scene.
   * A missing or stale Scene aborts the whole batch; no partial evidence import is committed.
   */
  async importRunEvidence(
    candidates: readonly EvidenceImportCandidate[],
  ): Promise<ImportRunEvidenceResult> {
    if (candidates.length === 0) {
      throw new SceneStorageError('Studio refused an empty Run evidence import.', 'write');
    }
    const byScene = new Map<string, EvidenceImportCandidate[]>();
    for (const candidate of candidates) {
      const grouped = byScene.get(candidate.sceneId) ?? [];
      grouped.push(candidate);
      byScene.set(candidate.sceneId, grouped);
    }
    await Promise.all([...byScene.keys()].map((id) => this.waitForPendingSaves(id)));

    const writes: SceneBatchWrite[] = [];
    const createdUrls: string[] = [];
    const loadedRecords: StoredSceneRecord[] = [];
    const results: ImportRunEvidenceResult['scenes'] = [];
    const savedAt = Date.now();
    try {
      let sceneOffset = 0;
      for (const [sceneId, sceneCandidates] of byScene) {
        const current = await this.storage.get(sceneId);
        if (!current) {
          throw new SceneStorageError(
            `Run evidence targets “${sceneId}”, but that canonical Scene is not in this workspace. Import its portable source first.`,
            'write',
          );
        }
        loadedRecords.push(current);
        let next = current.scene;
        let replacedCount = 0;
        for (const candidate of sceneCandidates) {
          const attached = await attachEvidenceToScene(next, candidate);
          next = attached.scene;
          createdUrls.push(...attached.createdUrls);
          if (attached.replacedRevision) replacedCount += 1;
        }
        const revision = current.revision + 1;
        writes.push({
          expectedRevision: current.revision,
          record: {
            id: sceneId,
            scene: cloneScene(next),
            savedAt: savedAt + sceneOffset,
            revision,
          },
        });
        const latest = next.runEvidence?.[0];
        if (!latest) {
          throw new SceneStorageError('Imported Run evidence disappeared before commit.', 'write');
        }
        results.push({
          id: sceneId,
          runCount: sceneCandidates.length,
          replacedCount,
          latestStatus: runEvidenceStatus(latest.run),
        });
        sceneOffset += 1;
      }
      await this.storage.putBatch(writes);
      for (const { record } of writes) {
        this.#baseRevisions.set(record.id, record.revision);
        this.recovery.clear(record.id);
      }
      return { scenes: results, runCount: candidates.length };
    } finally {
      // IndexedDB has durably copied these bytes by commit; failed transactions need cleanup too.
      // Each get() also creates private hydration URLs, so release those along with new imports.
      releaseLocalMediaUrls(loadedRecords, createdUrls);
    }
  }

  async importScenes(
    scenes: readonly EditorScene[],
    strategy: ImportConflictStrategy,
    project?: Project,
  ): Promise<ImportScenesResult> {
    if (
      !scenes.every(isEditorScene) ||
      new Set(scenes.map((scene) => scene.id)).size !== scenes.length
    ) {
      throw new SceneStorageError(
        'Studio refused an import containing invalid or duplicate Scene IDs.',
        'write',
      );
    }
    const summaries = await this.list();
    const revisions = new Map(summaries.map((record) => [record.id, record.revision]));
    const existing = new Set(revisions.keys());
    const imported: EditorScene[] = [];
    const skipped: string[] = [];
    const renamed: Array<{ from: string; to: string }> = [];
    const destinations = new Map<string, string>();

    for (const source of scenes) {
      let destination = source.id;
      if (existing.has(destination)) {
        if (strategy === 'skip') {
          skipped.push(source.id);
          continue;
        }
        if (strategy === 'rename') {
          let suffix = 2;
          while (existing.has(`${source.id}-${suffix}`)) suffix += 1;
          destination = `${source.id}-${suffix}`;
          renamed.push({ from: source.id, to: destination });
        }
      }
      destinations.set(source.id, destination);
      existing.add(destination);
    }

    const writes: SceneBatchWrite[] = [];
    const savedAt = Date.now();
    for (const [sourceIndex, source] of scenes.entries()) {
      const destination = destinations.get(source.id);
      if (!destination) continue;
      const scene = cloneScene(source);
      scene.id = destination;
      for (const step of scene.steps) {
        for (const choice of step.choices) {
          choice.sceneId = destinations.get(choice.sceneId) ?? choice.sceneId;
          if (choice.href?.startsWith('/scenes/')) {
            choice.href = `/scenes/${encodeURIComponent(choice.sceneId)}`;
          }
        }
      }
      if (scene.portableSource) {
        scene.portableSource.id = destination;
        scene.portableSource.slug = destination
          .replaceAll(/[._:]+/gu, '-')
          .replaceAll(/-+/gu, '-')
          .slice(0, 100);
        for (const step of scene.portableSource.steps) {
          for (const choice of step.choices) {
            choice.targetSceneId = destinations.get(choice.targetSceneId) ?? choice.targetSceneId;
          }
        }
      }
      const expectedRevision = revisions.get(destination) ?? 0;
      writes.push({
        expectedRevision,
        record: {
          id: destination,
          scene: cloneScene(scene),
          savedAt: savedAt + sourceIndex,
          revision: expectedRevision + 1,
        },
      });
      imported.push(scene);
    }

    let importedProject: Project | undefined;
    let projectRecord: StoredProjectRecord | undefined;
    if (project) {
      importedProject = structuredClone(project);
      const mapping = new Map(renamed.map((item) => [item.from, item.to]));
      for (const collection of importedProject.collections) {
        for (const entry of collection.entries) {
          entry.sceneId = mapping.get(entry.sceneId) ?? entry.sceneId;
        }
      }
      projectRecord = {
        id: importedProject.id,
        project: importedProject,
        savedAt: savedAt + scenes.length,
      };
    }

    await this.storage.putBatch(writes, projectRecord);
    for (const { record } of writes) {
      this.#baseRevisions.set(record.id, record.revision);
      this.recovery.clear(record.id);
    }
    if (importedProject) {
      this.#activeProjectId = importedProject.id;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(ACTIVE_PROJECT_KEY, importedProject.id);
      }
      notifyProjectChanged(importedProject);
    }
    return { imported, skipped, renamed, project: importedProject };
  }

  async loadProject(id?: string): Promise<Project | null> {
    const activeId =
      id ??
      (typeof localStorage !== 'undefined'
        ? (localStorage.getItem(ACTIVE_PROJECT_KEY) ?? this.#activeProjectId)
        : this.#activeProjectId);
    return (await this.storage.getProject(activeId))?.project ?? null;
  }

  async saveProject(project: Project): Promise<void> {
    await this.storage.putProject({
      id: project.id,
      project: structuredClone(project),
      savedAt: Date.now(),
    });
    this.#activeProjectId = project.id;
    if (typeof localStorage !== 'undefined') localStorage.setItem(ACTIVE_PROJECT_KEY, project.id);
    notifyProjectChanged(project);
  }
}

class ConfiguredSceneStorage implements SceneStorageBackend {
  #storage: Promise<SceneStorageBackend> | undefined;

  #resolve(): Promise<SceneStorageBackend> {
    if (this.#storage) return this.#storage;
    const hosted = Boolean(readHostedWorkspace());
    this.#storage = hosted
      ? import('./hosted-scene-storage').then(({ HostedSceneStorage }) => new HostedSceneStorage())
      : Promise.resolve(new IndexedDbSceneStorage());
    return this.#storage;
  }

  async get(id: string): Promise<StoredSceneRecord | null> {
    return (await this.#resolve()).get(id);
  }

  async listSummaryPage(request?: ScenePageRequest): Promise<ScenePage<SceneSummary>> {
    return (await this.#resolve()).listSummaryPage(request);
  }

  async put(record: StoredSceneRecord, expectedRevision: number): Promise<void> {
    return (await this.#resolve()).put(record, expectedRevision);
  }

  async putBatch(writes: readonly SceneBatchWrite[], project?: StoredProjectRecord): Promise<void> {
    return (await this.#resolve()).putBatch(writes, project);
  }

  async delete(id: string): Promise<void> {
    return (await this.#resolve()).delete(id);
  }

  async listVersionSummaries(
    id: string,
    request?: ScenePageRequest,
  ): Promise<ScenePage<SceneVersionSummary>> {
    return (await this.#resolve()).listVersionSummaries(id, request);
  }

  async getVersion(id: string, revision: number): Promise<StoredSceneRecord | null> {
    return (await this.#resolve()).getVersion(id, revision);
  }

  async getProject(id: string): Promise<StoredProjectRecord | null> {
    return (await this.#resolve()).getProject(id);
  }

  async putProject(record: StoredProjectRecord): Promise<void> {
    return (await this.#resolve()).putProject(record);
  }
}

export const studioSceneLibrary = new SceneLibrary(
  new ConfiguredSceneStorage(),
  new LocalStorageRecoveryJournal(),
);
