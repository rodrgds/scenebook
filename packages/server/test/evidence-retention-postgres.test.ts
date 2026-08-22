import { afterAll, describe, expect, it } from 'vitest';
import { sha256 } from '@scenebook/core';
import { ReviewSchema, SceneSchema } from '@scenebook/schema';

import { PostgresControlPlaneRepository } from '../src/postgres.js';

const databaseUrl = process.env.SCENEBOOK_TEST_POSTGRES_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('PostgreSQL final evidence retention', () => {
  const repository = new PostgresControlPlaneRepository(databaseUrl!);
  const limits = {
    maxActiveUploadsPerTenant: 20,
    maxActiveUploadsGlobal: 20,
    maxActiveBytesPerTenant: 100_000,
    maxActiveBytesGlobal: 100_000,
  };

  afterAll(async () => repository.close());

  it('claims atomically, protects Release-upload bytes, tombstones exact identities, and hides them from reads', async () => {
    const now = '2026-07-20T12:00:00.000Z';
    await repository.createWorkspace({
      id: 'workspace-retention',
      slug: 'workspace-retention',
      name: 'Retention',
      now,
    });
    await repository.createProject({
      id: 'project-retention',
      workspaceId: 'workspace-retention',
      slug: 'project-retention',
      name: 'Retention',
      now,
    });
    const finalize = async (id: string, contents: string) => {
      const bytes = new TextEncoder().encode(contents);
      const hash = sha256(bytes);
      await repository.beginUpload({
        id,
        workspaceId: 'workspace-retention',
        projectId: 'project-retention',
        repository: 'acme/product',
        commit: 'a'.repeat(40),
        ref: 'refs/heads/main',
        idempotencyKey: id,
        requestHash: sha256(`request:${id}`),
        objects: [{ sha256: hash, byteLength: bytes.byteLength, mediaType: 'text/plain' }],
        now: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-06-01T01:00:00.000Z',
        limits,
      });
      await repository.markObjectStaged(
        id,
        hash,
        'text/plain',
        `staging/${id}/${hash}.dGV4dC9wbGFpbg`,
        '2026-06-01T00:01:00.000Z',
      );
      await repository.finalizeUpload(
        id,
        sha256(`manifest:${id}`),
        [
          {
            key: `workspaces/workspace-retention/objects/${hash}/dGV4dC9wbGFpbg`,
            sha256: hash,
            byteLength: bytes.byteLength,
            mediaType: 'text/plain',
          },
        ],
        '2026-06-01T00:02:00.000Z',
      );
      return { hash, byteLength: bytes.byteLength };
    };
    const unused = await finalize('upload-unused', 'unused');
    const protectedObject = await finalize('upload-protected', 'protected');
    const reviewObject = await finalize('upload-review', 'reviewed Run object');
    const sceneAsset = await finalize('upload-scene-asset', 'authored Scene asset');
    const stateScreenshot = await finalize('upload-state-screenshot', 'State screenshot');
    const sourceRevision = 'd'.repeat(64);
    // SAFETY: this fixture already satisfies the asserted record shape.
    await repository.createSceneRevision({
      id: 'scene-revision-retention',
      workspaceId: 'workspace-retention',
      projectId: 'project-retention',
      scene: SceneSchema.parse({
        schemaVersion: 1,
        id: 'scene-retention',
        title: 'Retention Scene',
        slug: 'retention-scene',
        assets: [
          {
            sha256: sceneAsset.hash,
            path: `${sceneAsset.hash}.txt`,
            mediaType: 'text/plain',
            byteLength: sceneAsset.byteLength,
            role: 'attachment',
          },
        ],
        steps: [
          {
            id: 'step-retention',
            kind: 'browser',
            title: 'Protected State',
            states: {
              before: {
                id: 'state-retention',
                route: '/',
                viewport: { width: 1280, height: 720 },
                screenshot: {
                  sha256: stateScreenshot.hash,
                  path: `${stateScreenshot.hash}.txt`,
                  mediaType: 'text/plain',
                  byteLength: stateScreenshot.byteLength,
                  role: 'screenshot',
                },
              },
            },
          },
        ],
      }),
      revision: sourceRevision,
      privacy: {
        status: 'clear',
        scannedAt: now,
        scannerVersion: '1.0.0',
        counts: { info: 0, low: 0, medium: 0, high: 0, blocking: 0 },
        findings: [],
      },
      createdBy: 'owner-retention',
      now,
    } as never);
    await repository.pool.query(
      `INSERT INTO verification_runs(
         id,workspace_id,project_id,scene_id,source_revision,artifact_hash,artifact_json,
         idempotency_key,request_hash,recorded_by,recorded_at
       ) VALUES ('run-review-retention','workspace-retention','project-retention',
         'scene-retention',$1,$2,$3::jsonb,'run-review-retention',$4,'runner-retention',$5)`,
      [
        sourceRevision,
        'e'.repeat(64),
        JSON.stringify({
          attempts: [
            {
              states: [
                {
                  screenshot: {
                    sha256: reviewObject.hash,
                    path: `${reviewObject.hash}.txt`,
                    mediaType: 'text/plain',
                    byteLength: reviewObject.byteLength,
                    role: 'screenshot',
                  },
                },
              ],
            },
          ],
        }),
        'f'.repeat(64),
        now,
      ],
    );
    const review = ReviewSchema.parse({
      schemaVersion: 1,
      artifactVersion: 1,
      id: 'review-retention',
      kind: 'review',
      projectId: 'project-retention',
      createdAt: now,
      producer: { name: 'scenebook', version: '0.1.0' },
      subject: { kind: 'run', id: 'run-review-retention', revision: 'e'.repeat(64) },
      status: 'open',
      changeState: 'changed',
      openedAt: now,
    });
    await repository.pool.query(
      `INSERT INTO reviews(
         id,workspace_id,project_id,review_json,status,change_state,opened_at
       ) VALUES ($1,'workspace-retention','project-retention',$2::jsonb,'open','changed',$3)`,
      [review.id, JSON.stringify(review), now],
    );
    await repository.pool.query(
      `INSERT INTO channels(
         id,workspace_id,project_id,slug,name,kind,policy_json,webhook_ids,
         analytics_token_hash,sequence,created_at
       ) VALUES (
         'channel-retention','workspace-retention','project-retention','retention','Retention',
         'public-catalog','{}'::jsonb,'[]'::jsonb,$1,1,$2
       )`,
      ['a'.repeat(64), now],
    );
    await repository.pool.query(
      `INSERT INTO releases(
         id,workspace_id,project_id,channel_id,sequence,status,release_json,
         manifest_hash,idempotency_key,request_hash,published_at,evidence_json
       ) VALUES (
         'release-retention','workspace-retention','project-retention','channel-retention',1,
         'published','{}'::jsonb,$1,'release-retention',$2,$3,$4::jsonb
       )`,
      [
        'b'.repeat(64),
        'c'.repeat(64),
        now,
        JSON.stringify({ artifactUploadId: 'upload-protected', scenes: [] }),
      ],
    );
    await repository.pool.query(
      `UPDATE channels SET current_release_id='release-retention' WHERE id='channel-retention'`,
    );
    await repository.createWorkspace({
      id: 'workspace-retention-other',
      slug: 'workspace-retention-other',
      name: 'Other retention tenant',
      now,
    });
    const otherHash = sha256('other tenant retained object');
    await repository.pool.query(
      `INSERT INTO evidence_object_lifecycle(
         workspace_id,sha256,byte_length,media_type,retention_class,status,
         first_finalized_at,last_finalized_at
       ) VALUES ('workspace-retention-other',$1,28,'text/plain','standard','active',$2,$2)`,
      [otherHash, '2026-06-01T00:02:00.000Z'],
    );

    const batch = await repository.claimEvidenceRetentionObjects({
      workspaceId: 'workspace-retention',
      now,
      standardCutoff: '2026-07-01T00:00:00.000Z',
      diagnosticCutoff: '2026-07-10T00:00:00.000Z',
      limit: 10,
      claimId: 'retention-claim-postgres',
      claimedUntil: '2026-07-20T12:05:00.000Z',
      dryRun: false,
    });
    expect(batch.claims.map((claim) => claim.sha256)).toEqual(
      expect.arrayContaining([unused.hash, reviewObject.hash]),
    );
    expect(batch.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha256: unused.hash, disposition: 'eligible' }),
        expect.objectContaining({ sha256: reviewObject.hash, disposition: 'eligible' }),
        expect.objectContaining({ sha256: protectedObject.hash, disposition: 'protected' }),
        expect.objectContaining({ sha256: sceneAsset.hash, disposition: 'protected' }),
        expect.objectContaining({ sha256: stateScreenshot.hash, disposition: 'protected' }),
      ]),
    );
    expect(
      batch.evaluations.every((evaluation) => evaluation.workspaceId === 'workspace-retention'),
    ).toBe(true);
    expect(
      (
        await repository.pool.query<{ status: string }>(
          `SELECT status FROM evidence_object_lifecycle
            WHERE workspace_id='workspace-retention-other' AND sha256=$1 AND media_type='text/plain'`,
          [otherHash],
        )
      ).rows[0]?.status,
    ).toBe('active');
    await expect(
      // SAFETY: this fixture already satisfies the asserted record shape.
      repository.recordVerificationRun({
        id: 'run-retention-race',
        workspaceId: 'workspace-retention',
        projectId: 'project-retention',
        run: {
          attempts: [
            {
              attachments: [
                {
                  sha256: unused.hash,
                  byteLength: unused.byteLength,
                  mediaType: 'text/plain',
                  role: 'trace',
                },
              ],
            },
          ],
        },
      } as never),
    ).rejects.toThrow('Evidence object is not active');
    await expect(
      // SAFETY: this fixture already satisfies the asserted record shape.
      repository.createSceneRevision({
        id: 'scene-revision-retention-race',
        workspaceId: 'workspace-retention',
        projectId: 'project-retention',
        scene: {
          id: 'scene-retention-race',
          assets: [
            {
              sha256: unused.hash,
              path: `${unused.hash}.txt`,
              mediaType: 'text/plain',
              byteLength: unused.byteLength,
              role: 'attachment',
            },
          ],
          steps: [],
        },
        revision: '1'.repeat(64),
        privacy: { status: 'clear' },
        createdBy: 'owner-retention',
        now: '2026-07-20T12:01:00.000Z',
      } as never),
    ).rejects.toThrow('Evidence object is not active');
    await expect(
      repository.addReviewDecision('workspace-retention', 'project-retention', review.id, {
        id: 'decision-retention',
        actorId: 'reviewer-retention',
        decision: 'approve',
        createdAt: '2026-07-20T12:01:00.000Z',
      }),
    ).rejects.toThrow('Evidence object is not active');
    expect(
      (await repository.getReview('workspace-retention', 'project-retention', review.id))?.review
        .status,
    ).toBe('open');
    const deleting = await repository.beginFinalEvidenceDeletion({
      workspaceId: 'workspace-retention',
      sha256: unused.hash,
      mediaType: 'text/plain',
      claimId: 'retention-claim-postgres',
      now,
    });
    expect(deleting?.status).toBe('deleting');
    const completionEvent = {
      id: 'retention-event-deleted-postgres',
      workspaceId: 'workspace-retention',
      sha256: unused.hash,
      mediaType: 'text/plain',
      claimId: 'retention-claim-postgres',
      disposition: 'deleted' as const,
      reason: 'physical final object deleted and lifecycle tombstoned',
      metadata: { byteLength: unused.byteLength },
      createdAt: now,
    };
    const completionAudit = {
      id: 'audit-retention-deleted-postgres',
      workspaceId: 'workspace-retention',
      actorId: 'system:evidence-retention',
      action: 'evidence.retention-deleted',
      targetType: 'evidence-object',
      targetId: `${unused.hash}:text/plain`,
      requestId: 'retention-claim-postgres',
      metadata: completionEvent.metadata,
      createdAt: now,
    };
    await repository.appendAudit({
      ...completionAudit,
      id: 'audit-retention-completion-conflict',
      action: 'test.conflict',
    });
    await expect(
      repository.completeFinalEvidenceDeletion({
        workspaceId: 'workspace-retention',
        sha256: unused.hash,
        mediaType: 'text/plain',
        claimId: 'retention-claim-postgres',
        now,
        event: completionEvent,
        audit: { ...completionAudit, id: 'audit-retention-completion-conflict' },
      }),
    ).rejects.toThrow();
    expect(
      (
        await repository.pool.query<{ status: string }>(
          `SELECT status FROM evidence_object_lifecycle
            WHERE workspace_id='workspace-retention' AND sha256=$1 AND media_type='text/plain'`,
          [unused.hash],
        )
      ).rows[0]?.status,
    ).toBe('deleting');
    expect(
      (
        await repository.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM evidence_retention_events WHERE id=$1`,
          [completionEvent.id],
        )
      ).rows[0]?.count,
    ).toBe('0');
    expect(
      await repository.completeFinalEvidenceDeletion({
        workspaceId: 'workspace-retention',
        sha256: unused.hash,
        mediaType: 'text/plain',
        claimId: 'retention-claim-postgres',
        now,
        event: completionEvent,
        audit: completionAudit,
      }),
    ).toBe(true);
    expect(
      (
        await repository.pool.query<{ events: string; audits: string }>(
          `SELECT
             (SELECT count(*)::text FROM evidence_retention_events WHERE id=$1) AS events,
             (SELECT count(*)::text FROM audit_events WHERE id=$2) AS audits`,
          [completionEvent.id, completionAudit.id],
        )
      ).rows[0],
    ).toEqual({ events: '1', audits: '1' });
    expect(
      await repository.getFinalizedObject(
        'workspace-retention',
        'project-retention',
        unused.hash,
        'text/plain',
      ),
    ).toBeUndefined();
    expect(
      await repository.getFinalizedObject(
        'workspace-retention',
        'project-retention',
        protectedObject.hash,
        'text/plain',
      ),
    ).toMatchObject({ sha256: protectedObject.hash });
  });
});
