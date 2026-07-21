import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@scenebook/core';

import { createJsonLogger } from '../src/logger.js';
import { MetricsRegistry } from '../src/metrics.js';
import { FileSystemObjectStore } from '../src/object-store.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import { UploadGarbageCollector } from '../src/upload-gc.js';

const directories: string[] = [];
const limits = {
  maxActiveUploadsPerTenant: 10,
  maxActiveUploadsGlobal: 10,
  maxActiveBytesPerTenant: 10_000,
  maxActiveBytesGlobal: 10_000,
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('expired artifact upload garbage collection', () => {
  it('reclaims recorded and crash-window staged objects without touching finalized uploads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scenebook-upload-gc-'));
    directories.push(root);
    const repository = new MemoryControlPlaneRepository();
    const store = new FileSystemObjectStore(root);
    const now = new Date('2026-07-20T12:00:00.000Z');
    const createUpload = async (id: string, contents: string) => {
      const bytes = new TextEncoder().encode(contents);
      const object = {
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        mediaType: 'text/plain',
      };
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
        now: '2026-07-20T11:00:00.000Z',
        expiresAt: '2026-07-20T11:05:00.000Z',
        limits,
      });
      const staged = await store.putStaged(id, object.sha256, bytes, object.mediaType);
      await repository.markObjectStaged(
        id,
        object.sha256,
        object.mediaType,
        staged.key,
        '2026-07-20T11:02:00.000Z',
      );
      return staged;
    };
    const abandoned = await createUpload('upload-abandoned', 'abandoned');
    const orphanBytes = new TextEncoder().encode('crash-window');
    const orphanSpec = {
      sha256: sha256(orphanBytes),
      byteLength: orphanBytes.byteLength,
      mediaType: 'text/plain',
    };
    await repository.beginUpload({
      id: 'upload-crash-window',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      repository: 'acme/product',
      commit: 'a'.repeat(40),
      ref: 'refs/heads/main',
      idempotencyKey: 'upload-crash-window',
      requestHash: sha256('upload-crash-window'),
      objects: [orphanSpec],
      now: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-20T11:05:00.000Z',
      limits,
    });
    const crashWindow = await store.putStaged(
      'upload-crash-window',
      orphanSpec.sha256,
      orphanBytes,
      orphanSpec.mediaType,
    );
    const finalizedStaged = await createUpload('upload-finalized', 'finalized');
    const finalized = await store.promote(finalizedStaged, 'workspace-1');
    await repository.finalizeUpload(
      'upload-finalized',
      sha256('manifest'),
      [finalized],
      '2026-07-20T11:03:00.000Z',
    );

    const metrics = new MetricsRegistry();
    const collector = new UploadGarbageCollector({
      repository,
      objectStore: store,
      metrics,
      logger: createJsonLogger('error', () => undefined),
      intervalMs: 60_000,
      batchSize: 10,
      claimTtlSeconds: 60,
      now: () => new Date(now),
      claimId: () => 'claim-one',
    });
    expect(await collector.runOnce()).toBe(2);
    expect(await store.verify(abandoned)).toBe(false);
    expect(await store.verify(crashWindow)).toBe(false);
    expect(await store.verify(finalized)).toBe(true);
    expect((await repository.getUpload('upload-abandoned'))?.status).toBe('expired');
    expect((await repository.getUpload('upload-finalized'))?.status).toBe('finalized');
    expect(await collector.runOnce()).toBe(0);
    expect(metrics.render()).toContain('scenebook_upload_gc_deleted_objects_total 2');
  });

  it('uses expiring claims so concurrent collectors cannot delete the same upload', async () => {
    const repository = new MemoryControlPlaneRepository();
    const bytes = new TextEncoder().encode('pending');
    await repository.beginUpload({
      id: 'upload-claim',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      repository: 'acme/product',
      commit: 'a'.repeat(40),
      ref: 'refs/heads/main',
      idempotencyKey: 'upload-claim',
      requestHash: sha256('upload-claim'),
      objects: [{ sha256: sha256(bytes), byteLength: bytes.byteLength, mediaType: 'text/plain' }],
      now: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-20T11:05:00.000Z',
      limits,
    });
    expect(
      await repository.claimExpiredUploads({
        now: '2026-07-20T12:00:00.000Z',
        limit: 1,
        claimId: 'claim-a',
        claimedUntil: '2026-07-20T12:01:00.000Z',
      }),
    ).toHaveLength(1);
    expect(
      await repository.claimExpiredUploads({
        now: '2026-07-20T12:00:30.000Z',
        limit: 1,
        claimId: 'claim-b',
        claimedUntil: '2026-07-20T12:01:30.000Z',
      }),
    ).toHaveLength(0);
    expect(
      await repository.claimExpiredUploads({
        now: '2026-07-20T12:01:00.000Z',
        limit: 1,
        claimId: 'claim-b',
        claimedUntil: '2026-07-20T12:02:00.000Z',
      }),
    ).toHaveLength(1);
    expect(
      await repository.completeExpiredUpload('upload-claim', 'claim-b', '2026-07-20T12:01:01.000Z'),
    ).toBe(true);
    expect(
      await repository.completeExpiredUpload('upload-claim', 'claim-b', '2026-07-20T12:01:02.000Z'),
    ).toBe(true);
  });
});
