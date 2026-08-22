import { describe, expect, it } from 'vitest';
import { ReleaseSchema } from '@scenebook/schema';

import { SecretBox } from '../src/crypto.js';
import { createJsonLogger } from '../src/logger.js';
import { MemoryControlPlaneRepository } from '../src/testing.js';
import type { WebhookDispatcher } from '../src/webhook.js';
import { WebhookWorker } from '../src/webhook-worker.js';

const NOW = '2026-07-20T12:00:00.000Z';
const box = new SecretBox(Buffer.alloc(32, 4).toString('base64url'));
const uploadLimits = {
  maxActiveUploadsPerTenant: 10,
  maxActiveUploadsGlobal: 100,
  maxActiveBytesPerTenant: 10_000,
  maxActiveBytesGlobal: 100_000,
};

describe('repository and webhook worker semantics', () => {
  it('rejects idempotency-key reuse with a different upload request', async () => {
    const repository = new MemoryControlPlaneRepository();
    await repository.beginUpload({
      id: 'upload-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      repository: 'acme/product',
      commit: 'a'.repeat(40),
      ref: 'refs/heads/main',
      idempotencyKey: 'same-key',
      requestHash: 'a'.repeat(64),
      objects: [{ sha256: 'b'.repeat(64), byteLength: 10, mediaType: 'text/plain' }],
      now: NOW,
      expiresAt: '2026-07-20T12:05:00.000Z',
      limits: uploadLimits,
    });
    await expect(
      repository.beginUpload({
        id: 'upload-2',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        repository: 'acme/product',
        commit: 'a'.repeat(40),
        ref: 'refs/heads/main',
        idempotencyKey: 'same-key',
        requestHash: 'c'.repeat(64),
        objects: [{ sha256: 'b'.repeat(64), byteLength: 10, mediaType: 'text/plain' }],
        now: NOW,
        expiresAt: '2026-07-20T12:05:00.000Z',
        limits: uploadLimits,
      }),
    ).rejects.toThrow('idempotency conflict');
  });

  it('delivers encrypted CTA payloads and records successful completion', async () => {
    const repository = new MemoryControlPlaneRepository();
    repository.submissions.set('cta-1', {
      id: 'cta-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      releaseId: 'release-1',
      sceneId: 'scene-1',
      ctaId: 'request-access',
      webhookId: 'crm',
      payloadHash: 'a'.repeat(64),
      encryptedPayload: box.encrypt({ fields: { email: 'person@example.com' } }),
      createdAt: NOW,
    });
    repository.deliveries.set('delivery-1', {
      id: 'delivery-1',
      submissionId: 'cta-1',
      webhookId: 'crm',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
    });
    const delivered: unknown[] = [];
    // SAFETY: this fixture already satisfies the asserted record shape.
    const dispatcher = {
      deliver: async (_id: string, payload: unknown) => {
        delivered.push(payload);
        return { status: 204, body: '' };
      },
    } as unknown as WebhookDispatcher;
    const worker = new WebhookWorker({
      repository,
      dispatcher,
      secretBox: box,
      logger: createJsonLogger('error', () => undefined),
      now: () => new Date(NOW),
    });
    expect(await worker.runOnce()).toBe(1);
    expect(delivered).toEqual([{ fields: { email: 'person@example.com' } }]);
    expect(repository.deliveries.get('delivery-1')).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      lastStatus: 204,
    });
  });

  it('moves repeatedly failing webhooks to an exhausted terminal state', async () => {
    const repository = new MemoryControlPlaneRepository();
    repository.submissions.set('cta-1', {
      id: 'cta-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      releaseId: 'release-1',
      sceneId: 'scene-1',
      ctaId: 'request-access',
      webhookId: 'crm',
      payloadHash: 'a'.repeat(64),
      encryptedPayload: box.encrypt({ ok: true }),
      createdAt: NOW,
    });
    repository.deliveries.set('delivery-1', {
      id: 'delivery-1',
      submissionId: 'cta-1',
      webhookId: 'crm',
      status: 'pending',
      attempts: 7,
      nextAttemptAt: NOW,
    });
    // SAFETY: this fixture already satisfies the asserted record shape.
    const dispatcher = {
      deliver: async () => {
        throw new Error('upstream unavailable');
      },
    } as unknown as WebhookDispatcher;
    const worker = new WebhookWorker({
      repository,
      dispatcher,
      secretBox: box,
      logger: createJsonLogger('error', () => undefined),
      now: () => new Date(NOW),
      maxAttempts: 8,
    });
    await worker.runOnce();
    expect(repository.deliveries.get('delivery-1')).toMatchObject({
      status: 'exhausted',
      attempts: 8,
    });
  });

  it('promotes and rolls back Releases atomically with retry-safe idempotency', async () => {
    const repository = new MemoryControlPlaneRepository();
    await repository.createWorkspace({
      id: 'workspace-1',
      slug: 'workspace',
      name: 'Workspace',
      now: NOW,
    });
    await repository.createProject({
      id: 'project-1',
      workspaceId: 'workspace-1',
      slug: 'project',
      name: 'Project',
      now: NOW,
    });
    await repository.createChannel({
      id: 'channel-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      slug: 'public',
      name: 'Public',
      kind: 'public-catalog',
      policy: {
        requireCriticalPassing: true,
        requireVisualApproval: true,
        requireEditorialApproval: true,
        requireCompleteLocalization: false,
        publication: 'manual',
        nonCriticalFailure: 'block',
      },
      webhookIds: [],
      analyticsTokenHash: 'a'.repeat(64),
      now: NOW,
    });
    const release = (id: string) =>
      ReleaseSchema.parse({
        schemaVersion: 1,
        artifactVersion: 1,
        id,
        kind: 'release',
        projectId: 'project-1',
        createdAt: NOW,
        producer: { name: 'scenebook', version: '0.1.0' },
        channelId: 'channel-1',
        sequence: 1,
        status: 'published',
        publishedAt: NOW,
        scenes: [
          {
            sceneId: 'scene-1',
            baselineId: 'baseline-1',
            sourceRevision: 'b'.repeat(64),
            outputs: [
              {
                format: 'catalog',
                asset: {
                  sha256: 'c'.repeat(64),
                  path: `assets/${'c'.repeat(64)}.html`,
                  mediaType: 'text/html',
                  byteLength: 10,
                  role: 'document',
                },
              },
            ],
          },
        ],
        approvals: [
          {
            id: 'approval-1',
            kind: 'release',
            decision: 'approved',
            actorId: 'reviewer-1',
            createdAt: NOW,
            revision: 'b'.repeat(64),
          },
        ],
        manifestHash: 'd'.repeat(64),
      });
    await repository.promoteRelease({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      release: release('release-1'),
      idempotencyKey: 'promote-1',
      requestHash: 'e'.repeat(64),
      now: NOW,
    });
    await repository.promoteRelease({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      release: release('release-2'),
      expectedCurrentReleaseId: 'release-1',
      idempotencyKey: 'promote-2',
      requestHash: 'f'.repeat(64),
      now: NOW,
    });
    expect(
      (await repository.getRelease('workspace-1', 'project-1', 'release-1'))?.release.status,
    ).toBe('superseded');
    const rolledBack = await repository.rollbackRelease({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      targetReleaseId: 'release-1',
      expectedCurrentReleaseId: 'release-2',
      newReleaseId: 'release-3',
      idempotencyKey: 'rollback-1',
      requestHash: '1'.repeat(64),
      now: NOW,
    });
    const retried = await repository.rollbackRelease({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      targetReleaseId: 'release-1',
      expectedCurrentReleaseId: 'release-2',
      newReleaseId: 'release-4',
      idempotencyKey: 'rollback-1',
      requestHash: '1'.repeat(64),
      now: NOW,
    });
    expect(retried.release.id).toBe(rolledBack.release.id);
    expect(
      (await repository.getRelease('workspace-1', 'project-1', 'release-2'))?.release.status,
    ).toBe('rolled-back');
    expect(
      (await repository.getChannel('workspace-1', 'project-1', 'channel-1'))?.currentReleaseId,
    ).toBe('release-3');
  });
});
