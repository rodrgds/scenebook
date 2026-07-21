import { randomUUID } from 'node:crypto';

import type { Logger } from './logger.js';
import type { MetricsRegistry } from './metrics.js';
import { immutableObjectKey, type FinalObjectDeleter } from './object-store.js';
import type { ControlPlaneRepository } from './repository.js';
import type {
  AuditEventRecord,
  EvidenceRetentionClaimRecord,
  EvidenceRetentionEvaluationRecord,
  EvidenceRetentionEventRecord,
} from './domain.js';

export interface EvidenceRetentionWorkerOptions {
  readonly repository: ControlPlaneRepository;
  readonly finalDeleter: FinalObjectDeleter;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly claimTtlSeconds: number;
  readonly standardGraceSeconds: number;
  readonly diagnosticGraceSeconds: number;
  readonly now?: () => Date;
  readonly claimId?: () => string;
  readonly eventId?: () => string;
}

export interface EvidenceRetentionRunResult {
  readonly workspaceId: string;
  readonly dryRun: boolean;
  readonly eligible: number;
  readonly deleted: number;
  readonly failed: number;
  readonly claims: readonly EvidenceRetentionClaimRecord[];
}

export class EvidenceRetentionBusyError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Evidence retention is already running for workspace ${workspaceId}`);
    this.name = 'EvidenceRetentionBusyError';
  }
}

export class EvidenceRetentionWorker {
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private scheduledCursor?: string;
  private active?: {
    readonly workspaceId: string;
    readonly dryRun: boolean;
    readonly controller: AbortController;
    readonly promise: Promise<EvidenceRetentionRunResult>;
  };
  private readonly now: () => Date;
  private readonly claimId: () => string;
  private readonly eventId: () => string;

  constructor(private readonly options: EvidenceRetentionWorkerOptions) {
    this.now = options.now ?? (() => new Date());
    this.claimId = options.claimId ?? (() => `retention-${randomUUID()}`);
    this.eventId = options.eventId ?? (() => `retention-event-${randomUUID()}`);
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const trigger = (): void => {
      void this.runScheduledPass().catch((error) => {
        this.options.logger.error('Scheduled evidence retention pass failed', { error });
        this.options.metrics.increment(
          'scenebook_evidence_retention_scheduled_failures_total',
          'Scheduled evidence-retention passes that rejected',
        );
      });
    };
    this.timer = setInterval(trigger, this.options.intervalMs);
    this.timer.unref();
    trigger();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopping = true;
    const active = this.active;
    if (!active) return;
    active.controller.abort(new Error('Evidence retention worker is stopping'));
    await active.promise.catch((error) => {
      this.options.logger.warn('Active evidence retention pass stopped with an error', {
        workspaceId: active.workspaceId,
        error,
      });
    });
  }

  private async runScheduledPass(): Promise<void> {
    if (this.stopping || this.active) return;
    let workspaceIds = await this.options.repository.listEvidenceRetentionWorkspaceIds({
      ...(this.scheduledCursor ? { afterWorkspaceId: this.scheduledCursor } : {}),
      limit: 1,
    });
    if (workspaceIds.length === 0 && this.scheduledCursor) {
      this.scheduledCursor = undefined;
      workspaceIds = await this.options.repository.listEvidenceRetentionWorkspaceIds({ limit: 1 });
    }
    const workspaceId = workspaceIds[0];
    if (!workspaceId || this.stopping || this.active) return;
    this.scheduledCursor = workspaceId;
    await this.runOnce(workspaceId, false);
  }

  private eventRecords(
    claim: EvidenceRetentionClaimRecord | EvidenceRetentionEvaluationRecord,
    disposition: EvidenceRetentionEventRecord['disposition'],
    reason: string,
    metadata: Readonly<Record<string, unknown>> = {},
    createdAt = this.now().toISOString(),
  ): { readonly event: EvidenceRetentionEventRecord; readonly audit: AuditEventRecord } {
    const event: EvidenceRetentionEventRecord = {
      id: this.eventId(),
      workspaceId: claim.workspaceId,
      sha256: claim.sha256,
      mediaType: claim.mediaType,
      ...('claimId' in claim && claim.claimId ? { claimId: claim.claimId } : {}),
      disposition,
      reason,
      metadata: {
        byteLength: claim.byteLength,
        retentionClass: claim.retentionClass,
        lastFinalizedAt: claim.lastFinalizedAt,
        projectIds: claim.projectIds,
        ...metadata,
      },
      createdAt,
    };
    return {
      event,
      audit: {
        id: `audit-${event.id}`,
        workspaceId: claim.workspaceId,
        actorId: 'system:evidence-retention',
        action: `evidence.retention-${disposition}`,
        targetType: 'evidence-object',
        targetId: `${claim.sha256}:${claim.mediaType}`,
        requestId: 'claimId' in claim && claim.claimId ? claim.claimId : `evaluation:${event.id}`,
        metadata: event.metadata,
        createdAt,
      },
    };
  }

  private async event(
    claim: EvidenceRetentionClaimRecord | EvidenceRetentionEvaluationRecord,
    disposition: EvidenceRetentionEventRecord['disposition'],
    reason: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const records = this.eventRecords(claim, disposition, reason, metadata);
    await this.options.repository.appendEvidenceRetentionEventAndAudit(
      records.event,
      records.audit,
    );
  }

  private async bestEffortEvent(
    claim: EvidenceRetentionClaimRecord | EvidenceRetentionEvaluationRecord,
    disposition: EvidenceRetentionEventRecord['disposition'],
    reason: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.event(claim, disposition, reason, metadata).catch((error) => {
      this.options.logger.warn('Evidence retention audit recording failed', {
        workspaceId: claim.workspaceId,
        sha256: claim.sha256,
        mediaType: claim.mediaType,
        disposition,
        error,
      });
    });
  }

  async runOnce(workspaceId: string, dryRun = false): Promise<EvidenceRetentionRunResult> {
    if (!workspaceId) throw new TypeError('Evidence retention requires a workspace ID');
    if (this.stopping) throw new Error('Evidence retention worker is stopping');
    const running = this.active;
    if (running) {
      if (running.workspaceId === workspaceId && running.dryRun === dryRun) return running.promise;
      throw new EvidenceRetentionBusyError(running.workspaceId);
    }
    const controller = new AbortController();
    const promise = this.execute(workspaceId, dryRun, controller.signal);
    const active = { workspaceId, dryRun, controller, promise };
    this.active = active;
    try {
      return await promise;
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private async execute(
    workspaceId: string,
    dryRun: boolean,
    signal: AbortSignal,
  ): Promise<EvidenceRetentionRunResult> {
    const started = this.now();
    const claimId = this.claimId();
    let deleted = 0;
    let failed = 0;
    try {
      signal.throwIfAborted();
      const batch = await this.options.repository.claimEvidenceRetentionObjects({
        workspaceId,
        now: started.toISOString(),
        standardCutoff: new Date(
          started.getTime() - this.options.standardGraceSeconds * 1_000,
        ).toISOString(),
        diagnosticCutoff: new Date(
          started.getTime() - this.options.diagnosticGraceSeconds * 1_000,
        ).toISOString(),
        limit: this.options.batchSize,
        claimId,
        claimedUntil: new Date(
          started.getTime() + this.options.claimTtlSeconds * 1_000,
        ).toISOString(),
        dryRun,
      });
      for (const evaluation of batch.evaluations) {
        signal.throwIfAborted();
        await this.event(
          evaluation,
          evaluation.disposition === 'eligible' && dryRun
            ? 'dry-run-eligible'
            : evaluation.disposition,
          evaluation.disposition === 'eligible' && dryRun
            ? 'eligible after reference and grace checks; no state changed'
            : evaluation.reason,
          { dryRun },
        );
      }
      if (!dryRun) {
        for (const claim of batch.claims) {
          signal.throwIfAborted();
          const deleting = await this.options.repository.beginFinalEvidenceDeletion({
            workspaceId: claim.workspaceId,
            sha256: claim.sha256,
            mediaType: claim.mediaType,
            claimId: claim.claimId,
            now: this.now().toISOString(),
          });
          if (!deleting) {
            failed += 1;
            await this.event(
              claim,
              'claim-lost',
              'reference, upload, expiry, or concurrent lifecycle state changed before deletion',
            );
            continue;
          }
          try {
            await this.event(
              deleting,
              'deleting',
              'final-delete claim revalidated immediately before erasure',
            );
          } catch (error) {
            failed += 1;
            const released = await this.options.repository
              .releaseFinalEvidenceDeletion({
                workspaceId: deleting.workspaceId,
                sha256: deleting.sha256,
                mediaType: deleting.mediaType,
                claimId: deleting.claimId,
              })
              .catch(() => false);
            await this.bestEffortEvent(
              deleting,
              'delete-failed',
              'deleting transition audit failed before physical erasure',
              {
                errorClass: error instanceof Error ? error.name : 'unknown',
                physicalDeleteAttempted: false,
                lifecycle: released
                  ? 'restored active before erasure'
                  : 'left deleting for bounded expired-claim reconciliation',
              },
            );
            this.options.logger.warn('Evidence retention pre-delete audit failed', {
              workspaceId: deleting.workspaceId,
              sha256: deleting.sha256,
              mediaType: deleting.mediaType,
              released,
              error,
            });
            continue;
          }
          const object = {
            key: immutableObjectKey(deleting.workspaceId, deleting.sha256, deleting.mediaType),
            sha256: deleting.sha256,
            byteLength: deleting.byteLength,
            mediaType: deleting.mediaType,
          };
          let physicalDeleteAttempted = false;
          let physicalDeleteSucceeded = false;
          let lifecycleCompleted = false;
          try {
            signal.throwIfAborted();
            physicalDeleteAttempted = true;
            await this.options.finalDeleter.deleteFinal(object, signal);
            physicalDeleteSucceeded = true;
            const completedAt = this.now().toISOString();
            const completion = this.eventRecords(
              deleting,
              'deleted',
              'physical final object deleted and lifecycle tombstoned',
              {},
              completedAt,
            );
            if (
              !(await this.options.repository.completeFinalEvidenceDeletion({
                workspaceId: deleting.workspaceId,
                sha256: deleting.sha256,
                mediaType: deleting.mediaType,
                claimId: deleting.claimId,
                now: completedAt,
                event: completion.event,
                audit: completion.audit,
              }))
            ) {
              throw new Error('Final-delete lifecycle completion lost its exact claim');
            }
            lifecycleCompleted = true;
            deleted += 1;
          } catch (error) {
            failed += 1;
            if (!physicalDeleteAttempted) {
              await this.options.repository
                .releaseFinalEvidenceDeletion({
                  workspaceId: deleting.workspaceId,
                  sha256: deleting.sha256,
                  mediaType: deleting.mediaType,
                  claimId: deleting.claimId,
                })
                .catch(() => false);
            }
            await this.bestEffortEvent(
              deleting,
              'delete-failed',
              'final-delete operation did not complete safely',
              {
                errorClass: error instanceof Error ? error.name : 'unknown',
                physicalDeleteAttempted,
                physicalDeleteSucceeded,
                lifecycleCompleted,
                lifecycle: physicalDeleteAttempted
                  ? 'left deleting for bounded expired-claim reconciliation'
                  : 'restored active before erasure',
              },
            );
            this.options.logger.warn('Evidence retention deletion failed', {
              workspaceId: deleting.workspaceId,
              sha256: deleting.sha256,
              mediaType: deleting.mediaType,
              error,
            });
          }
          if (signal.aborted) break;
        }
      }
      this.options.metrics.increment(
        'scenebook_evidence_retention_eligible_total',
        'Final evidence objects that passed retention checks',
        { dryRun: String(dryRun) },
        batch.claims.length,
      );
      this.options.metrics.increment(
        'scenebook_evidence_retention_deleted_total',
        'Final evidence objects physically deleted',
        {},
        deleted,
      );
      if (failed > 0) {
        this.options.metrics.increment(
          'scenebook_evidence_retention_failures_total',
          'Evidence retention claim or deletion failures',
          {},
          failed,
        );
      }
      return {
        workspaceId,
        dryRun,
        eligible: batch.claims.length,
        deleted,
        failed,
        claims: batch.claims,
      };
    } finally {
      this.options.metrics.gauge(
        'scenebook_evidence_retention_last_duration_ms',
        'Duration of the last evidence-retention pass',
        Math.max(0, this.now().getTime() - started.getTime()),
      );
    }
  }
}
