import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@scenebook/core';
import { ReviewSchema } from '@scenebook/schema';

import { EvidenceRetentionWorker } from '../src/evidence-retention.js';
import { createJsonLogger } from '../src/logger.js';
import { MetricsRegistry } from '../src/metrics.js';
import {
  FileSystemFinalObjectDeleter,
  FileSystemObjectStore,
  type FinalObjectDeleter,
} from '../src/object-store.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';

const roots: string[] = [];
const limits = {
  maxActiveUploadsPerTenant: 20,
  maxActiveUploadsGlobal: 20,
  maxActiveBytesPerTenant: 100_000,
  maxActiveBytesGlobal: 100_000,
};
let workerInstance = 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function finalizedObject(
  repository: MemoryControlPlaneRepository,
  store: FileSystemObjectStore,
  id: string,
  mediaType: string,
  content: string | Uint8Array,
) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const object = { sha256: sha256(bytes), byteLength: bytes.byteLength, mediaType };
  await repository.beginUpload({
    id,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    repository: 'acme/product',
    commit: 'a'.repeat(40),
    ref: 'refs/heads/main',
    idempotencyKey: id,
    requestHash: sha256(id),
    objects: [object],
    now: '2026-06-01T00:00:00.000Z',
    expiresAt: '2026-06-01T01:00:00.000Z',
    limits,
  });
  const staged = await store.putStaged(id, object.sha256, bytes, mediaType);
  await repository.markObjectStaged(
    id,
    object.sha256,
    mediaType,
    staged.key,
    '2026-06-01T00:01:00.000Z',
  );
  const final = await store.promote(staged, 'workspace-1');
  await repository.finalizeUpload(
    id,
    sha256(`manifest:${id}`),
    [final],
    '2026-06-01T00:02:00.000Z',
  );
  return final;
}

function worker(
  repository: MemoryControlPlaneRepository,
  finalDeleter: FinalObjectDeleter,
  now = new Date('2026-07-20T12:00:00.000Z'),
) {
  const instance = ++workerInstance;
  let event = 0;
  return new EvidenceRetentionWorker({
    repository,
    finalDeleter,
    logger: createJsonLogger('error', () => undefined),
    metrics: new MetricsRegistry(),
    intervalMs: 60_000,
    batchSize: 20,
    claimTtlSeconds: 300,
    standardGraceSeconds: 7 * 24 * 60 * 60,
    diagnosticGraceSeconds: 24 * 60 * 60,
    now: () => new Date(now),
    claimId: () => 'retention-claim-1',
    eventId: () => `retention-event-${instance}-${++event}`,
  });
}

describe('final evidence retention', () => {
  it('deletes only unreferenced expired bytes and preserves approved Baseline evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    const baselineImage = await finalizedObject(
      repository,
      store,
      'upload-baseline',
      'image/png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwO0GQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const diagnostic = await finalizedObject(
      repository,
      store,
      'upload-trace',
      'text/plain',
      'unused diagnostic evidence',
    );
    repository.verificationBaselines.set('baseline-1', {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      baseline: { states: [{ screenshot: baselineImage }] },
    } as never);

    const result = await worker(repository, new FileSystemFinalObjectDeleter(root)).runOnce(
      'workspace-1',
      false,
    );
    expect(result).toMatchObject({ eligible: 1, deleted: 1, failed: 0 });
    expect(await store.verify(baselineImage)).toBe(true);
    expect(await store.verify(diagnostic)).toBe(false);
    expect(
      await repository.getFinalizedObject(
        'workspace-1',
        'project-1',
        diagnostic.sha256,
        diagnostic.mediaType,
      ),
    ).toBeUndefined();
    expect(repository.evidenceRetentionEvents.map((event) => event.disposition)).toEqual([
      'protected',
      'eligible',
      'deleting',
      'deleted',
    ]);
    expect(repository.audits.map((event) => event.action)).toEqual([
      'evidence.retention-protected',
      'evidence.retention-eligible',
      'evidence.retention-deleting',
      'evidence.retention-deleted',
    ]);
  });

  it('protects Scene assets and State screenshots and rejects Scene references after claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-scenes-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    const sceneAsset = await finalizedObject(
      repository,
      store,
      'upload-scene-asset',
      'text/plain',
      'authored Scene asset',
    );
    const stateScreenshot = await finalizedObject(
      repository,
      store,
      'upload-state-screenshot',
      'text/plain',
      'authored State screenshot',
    );
    const unreferenced = await finalizedObject(
      repository,
      store,
      'upload-scene-race',
      'text/plain',
      'unreferenced Scene race object',
    );
    await repository.createSceneRevision({
      id: 'scene-revision-protected',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      scene: {
        id: 'scene-protected',
        assets: [sceneAsset],
        steps: [
          {
            id: 'step-protected',
            states: { before: { id: 'state-protected', screenshot: stateScreenshot } },
          },
        ],
      },
      revision: 'b'.repeat(64),
      privacy: { status: 'clear' },
      createdBy: 'owner-1',
      now: '2026-06-01T00:03:00.000Z',
    } as never);

    const batch = await repository.claimEvidenceRetentionObjects({
      workspaceId: 'workspace-1',
      now: '2026-07-20T12:00:00.000Z',
      standardCutoff: '2026-07-01T00:00:00.000Z',
      diagnosticCutoff: '2026-07-10T00:00:00.000Z',
      limit: 10,
      claimId: 'scene-race-claim',
      claimedUntil: '2026-07-20T12:05:00.000Z',
      dryRun: false,
    });
    expect(batch.claims.map((claim) => claim.sha256)).toEqual([unreferenced.sha256]);
    expect(batch.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha256: sceneAsset.sha256, disposition: 'protected' }),
        expect.objectContaining({ sha256: stateScreenshot.sha256, disposition: 'protected' }),
      ]),
    );
    await expect(
      repository.createSceneRevision({
        id: 'scene-revision-raced',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        scene: { id: 'scene-raced', assets: [unreferenced], steps: [] },
        revision: 'c'.repeat(64),
        privacy: { status: 'clear' },
        createdBy: 'owner-1',
        now: '2026-07-20T12:01:00.000Z',
      } as never),
    ).rejects.toThrow('Evidence object is not active');
    expect(
      await repository.getSceneRevision('workspace-1', 'project-1', 'scene-raced', 'c'.repeat(64)),
    ).toBeUndefined();
  });

  it('supports audited dry runs and reconciles an ambiguous delete failure after claim expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-failure-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    const object = await finalizedObject(
      repository,
      store,
      'upload-unused',
      'text/plain',
      'unused evidence',
    );
    const failing: FinalObjectDeleter = {
      health: async () => undefined,
      deleteFinal: async () => {
        throw new Error('denied');
      },
    };
    const retention = worker(repository, failing);
    expect(await retention.runOnce('workspace-1', true)).toMatchObject({
      eligible: 1,
      deleted: 0,
      failed: 0,
    });
    expect(await store.verify(object)).toBe(true);
    expect(await retention.runOnce('workspace-1', false)).toMatchObject({
      eligible: 1,
      deleted: 0,
      failed: 1,
    });
    expect(await store.verify(object)).toBe(true);
    expect(
      [...repository.evidenceObjectLifecycle.values()].find(
        (value) => value.sha256 === object.sha256,
      )?.status,
    ).toBe('deleting');
    expect(repository.evidenceRetentionEvents.at(-1)?.disposition).toBe('delete-failed');
    const reconciled = await worker(
      repository,
      new FileSystemFinalObjectDeleter(root),
      new Date('2026-07-20T12:06:00.000Z'),
    ).runOnce('workspace-1', false);
    expect(reconciled).toMatchObject({ eligible: 1, deleted: 1, failed: 0 });
    expect(await store.verify(object)).toBe(false);
    expect(
      [...repository.evidenceObjectLifecycle.values()].find(
        (value) => value.sha256 === object.sha256,
      )?.status,
    ).toBe('deleted');
  });

  it('never commits a deleted tombstone without its required event and audit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-atomic-completion-'));
    roots.push(root);
    class FailingCompletionRepository extends MemoryControlPlaneRepository {
      failed = false;

      override async completeFinalEvidenceDeletion(
        input: Parameters<MemoryControlPlaneRepository['completeFinalEvidenceDeletion']>[0],
      ): Promise<boolean> {
        if (!this.failed) {
          this.failed = true;
          throw new Error('atomic audit transaction unavailable');
        }
        return super.completeFinalEvidenceDeletion(input);
      }
    }
    const repository = new FailingCompletionRepository();
    const store = new FileSystemObjectStore(root);
    const object = await finalizedObject(
      repository,
      store,
      'upload-atomic-completion',
      'text/plain',
      'atomic completion evidence',
    );
    const first = await worker(repository, new FileSystemFinalObjectDeleter(root)).runOnce(
      'workspace-1',
      false,
    );
    expect(first).toMatchObject({ deleted: 0, failed: 1 });
    expect(await store.verify(object)).toBe(false);
    expect(
      [...repository.evidenceObjectLifecycle.values()].find(
        (value) => value.sha256 === object.sha256,
      )?.status,
    ).toBe('deleting');
    expect(
      repository.evidenceRetentionEvents.filter((event) => event.disposition === 'deleted'),
    ).toHaveLength(0);
    expect(
      repository.audits.filter((audit) => audit.action === 'evidence.retention-deleted'),
    ).toHaveLength(0);

    const reconciled = await worker(
      repository,
      new FileSystemFinalObjectDeleter(root),
      new Date('2026-07-20T12:06:00.000Z'),
    ).runOnce('workspace-1', false);
    expect(reconciled).toMatchObject({ deleted: 1, failed: 0 });
    expect(
      [...repository.evidenceObjectLifecycle.values()].find(
        (value) => value.sha256 === object.sha256,
      )?.status,
    ).toBe('deleted');
    expect(
      repository.evidenceRetentionEvents.filter((event) => event.disposition === 'deleted'),
    ).toHaveLength(1);
    expect(
      repository.audits.filter((audit) => audit.action === 'evidence.retention-deleted'),
    ).toHaveLength(1);
  });

  it('releases the lifecycle without erasing bytes when the deleting audit cannot be recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-audit-failure-'));
    roots.push(root);
    class FailingAuditRepository extends MemoryControlPlaneRepository {
      failed = false;

      override async appendEvidenceRetentionEventAndAudit(
        event: Parameters<MemoryControlPlaneRepository['appendEvidenceRetentionEventAndAudit']>[0],
        audit: Parameters<MemoryControlPlaneRepository['appendEvidenceRetentionEventAndAudit']>[1],
      ): Promise<void> {
        if (event.disposition === 'deleting' && !this.failed) {
          this.failed = true;
          throw new Error('audit unavailable');
        }
        await super.appendEvidenceRetentionEventAndAudit(event, audit);
      }
    }
    const repository = new FailingAuditRepository();
    const store = new FileSystemObjectStore(root);
    const object = await finalizedObject(
      repository,
      store,
      'upload-audit-failure',
      'text/plain',
      'do not erase without audit',
    );
    let deleteCalls = 0;
    const retention = worker(repository, {
      health: async () => undefined,
      deleteFinal: async () => {
        deleteCalls += 1;
      },
    });
    expect(await retention.runOnce('workspace-1', false)).toMatchObject({
      eligible: 1,
      deleted: 0,
      failed: 1,
    });
    expect(deleteCalls).toBe(0);
    expect(await store.verify(object)).toBe(true);
    expect(
      [...repository.evidenceObjectLifecycle.values()].find(
        (value) => value.sha256 === object.sha256,
      )?.status,
    ).toBe('active');
  });

  it('never returns or mutates another workspace during an owner-scoped pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-tenant-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    const own = await finalizedObject(repository, store, 'upload-own', 'text/plain', 'own object');
    const otherHash = sha256('other tenant object');
    repository.evidenceObjectLifecycle.set(`workspace-2\0${otherHash}\0text/plain`, {
      workspaceId: 'workspace-2',
      sha256: otherHash,
      byteLength: 19,
      mediaType: 'text/plain',
      retentionClass: 'standard',
      status: 'active',
      firstFinalizedAt: '2026-06-01T00:00:00.000Z',
      lastFinalizedAt: '2026-06-01T00:00:00.000Z',
    });

    const result = await worker(repository, new FileSystemFinalObjectDeleter(root)).runOnce(
      'workspace-1',
      true,
    );
    expect(result.workspaceId).toBe('workspace-1');
    expect(result.claims.map((claim) => claim.workspaceId)).toEqual(['workspace-1']);
    expect(result.claims.map((claim) => claim.sha256)).toEqual([own.sha256]);
    expect(
      repository.evidenceRetentionEvents.every((event) => event.workspaceId === 'workspace-1'),
    ).toBe(true);
    expect(
      repository.evidenceObjectLifecycle.get(`workspace-2\0${otherHash}\0text/plain`)?.status,
    ).toBe('active');
  });

  it('rejects new evidence and upload bindings while an object is claimed for deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-race-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    const object = await finalizedObject(
      repository,
      store,
      'upload-race',
      'text/plain',
      'claim race evidence',
    );
    const batch = await repository.claimEvidenceRetentionObjects({
      workspaceId: 'workspace-1',
      now: '2026-07-20T12:00:00.000Z',
      standardCutoff: '2026-07-01T00:00:00.000Z',
      diagnosticCutoff: '2026-07-10T00:00:00.000Z',
      limit: 10,
      claimId: 'retention-race-claim',
      claimedUntil: '2026-07-20T12:05:00.000Z',
      dryRun: false,
    });
    expect(batch.claims).toHaveLength(1);

    await expect(
      repository.recordVerificationRun({
        id: 'run-race',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        run: { attempts: [{ attachments: [{ ...object, role: 'trace' }] }] },
      } as never),
    ).rejects.toThrow('Evidence object is not active');
    await expect(
      repository.beginUpload({
        id: 'upload-race-retry',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: 'acme/product',
        commit: 'b'.repeat(40),
        ref: 'refs/heads/main',
        idempotencyKey: 'upload-race-retry',
        requestHash: sha256('upload-race-retry'),
        objects: [
          {
            sha256: object.sha256,
            byteLength: object.byteLength,
            mediaType: object.mediaType,
          },
        ],
        now: '2026-07-20T12:00:00.000Z',
        expiresAt: '2026-07-20T13:00:00.000Z',
        limits,
      }),
    ).rejects.toThrow('Object is being retained or deleted');
  });

  it('cannot approve a Run review after its referenced bytes enter deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-approval-race-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    const object = await finalizedObject(
      repository,
      store,
      'upload-review-run',
      'text/plain',
      'reviewed Run bytes',
    );
    repository.verificationRuns.set('run-review-race', {
      id: 'run-review-race',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      run: { attempts: [{ states: [{ screenshot: object }] }] },
    } as never);
    const review = ReviewSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'review-retention-race',
      kind: 'review',
      projectId: 'project-1',
      createdAt: '2026-07-20T12:00:00.000Z',
      producer: { name: 'scenebook', version: '0.1.0' },
      subject: { kind: 'run', id: 'run-review-race', revision: 'a'.repeat(64) },
      status: 'open',
      changeState: 'changed',
      openedAt: '2026-07-20T12:00:00.000Z',
    });
    repository.reviews.set(review.id, {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      review,
    });
    const batch = await repository.claimEvidenceRetentionObjects({
      workspaceId: 'workspace-1',
      now: '2026-07-20T12:00:00.000Z',
      standardCutoff: '2026-07-01T00:00:00.000Z',
      diagnosticCutoff: '2026-07-10T00:00:00.000Z',
      limit: 10,
      claimId: 'approval-race-claim',
      claimedUntil: '2026-07-20T12:05:00.000Z',
      dryRun: false,
    });
    expect(batch.claims).toHaveLength(1);

    await expect(
      repository.addReviewDecision('workspace-1', 'project-1', review.id, {
        id: 'decision-retention-race',
        actorId: 'reviewer-1',
        decision: 'approve',
        createdAt: '2026-07-20T12:01:00.000Z',
      }),
    ).rejects.toThrow('Evidence object is not active');
    expect((await repository.getReview('workspace-1', 'project-1', review.id))?.review.status).toBe(
      'open',
    );
  });

  it('aborts and awaits an active delete pass during shutdown without an unhandled rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-retention-stop-'));
    roots.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    await finalizedObject(repository, store, 'upload-stop', 'text/plain', 'shutdown object');
    let started!: () => void;
    const deleting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const retention = worker(repository, {
      health: async () => undefined,
      deleteFinal: async (_object, signal) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    const pass = retention.runOnce('workspace-1', false);
    await deleting;
    await retention.stop();
    expect(await pass).toMatchObject({ workspaceId: 'workspace-1', deleted: 0, failed: 1 });
    expect(
      [...repository.evidenceObjectLifecycle.values()].find(
        (value) => value.workspaceId === 'workspace-1',
      )?.status,
    ).toBe('deleting');
  });

  it('contains scheduled repository rejections and keeps shutdown awaitable', async () => {
    class FailingScheduleRepository extends MemoryControlPlaneRepository {
      override async listEvidenceRetentionWorkspaceIds(): Promise<readonly string[]> {
        throw new Error('database unavailable');
      }
    }
    const messages: string[] = [];
    const retention = new EvidenceRetentionWorker({
      repository: new FailingScheduleRepository(),
      finalDeleter: { health: async () => undefined, deleteFinal: async () => undefined },
      logger: createJsonLogger('error', (message) => messages.push(message)),
      metrics: new MetricsRegistry(),
      intervalMs: 5,
      batchSize: 1,
      claimTtlSeconds: 300,
      standardGraceSeconds: 60,
      diagnosticGraceSeconds: 30,
    });
    retention.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await retention.stop();
    expect(
      messages.some((message) => message.includes('Scheduled evidence retention pass failed')),
    ).toBe(true);
  });
});
