import { sha256 } from '@scenebook/core';

import type { Logger } from './logger.js';
import type { MetricsRegistry } from './metrics.js';
import type { ControlPlaneRepository } from './repository.js';

export interface VerificationScheduleWorkerOptions {
  readonly repository: ControlPlaneRepository;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly now?: () => Date;
}

export class VerificationScheduleWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly now: () => Date;

  constructor(private readonly options: VerificationScheduleWorkerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<{ readonly enqueued: number; readonly recovered: number }> {
    if (this.running) return { enqueued: 0, recovered: 0 };
    this.running = true;
    const started = this.now();
    try {
      const now = started.toISOString();
      const recovered = await this.options.repository.requeueExpiredVerificationJobs(
        now,
        this.options.batchSize,
      );
      const enqueued = await this.options.repository.materializeDueVerificationJobs(
        now,
        this.options.batchSize,
      );
      for (const job of recovered) {
        await this.options.repository.appendAudit({
          id: `audit-${sha256(`scheduler-recovery\0${job.id}\0${job.attempts}\0${job.state}`).slice(0, 48)}`,
          workspaceId: job.workspaceId,
          actorId: 'scheduler',
          action:
            job.state === 'failed'
              ? 'verification.job-lease-exhausted'
              : 'verification.job-requeued',
          targetType: 'verification-job',
          targetId: job.id,
          requestId: `scheduler-${job.id}`,
          metadata: { scheduleId: job.scheduleId, attempts: job.attempts, state: job.state },
          createdAt: now,
        });
      }
      for (const job of enqueued) {
        await this.options.repository.appendAudit({
          id: `audit-${sha256(`scheduler-enqueue\0${job.id}`).slice(0, 48)}`,
          workspaceId: job.workspaceId,
          actorId: 'scheduler',
          action: 'verification.job-enqueued',
          targetType: 'verification-job',
          targetId: job.id,
          requestId: `scheduler-${job.id}`,
          metadata: {
            scheduleId: job.scheduleId,
            reason: job.reason,
            dueAt: job.dueAt,
            expectedBuildId: job.execution.expectedBuildId,
          },
          createdAt: now,
        });
      }
      this.options.metrics.increment(
        'scenebook_verification_jobs_enqueued_total',
        'Scheduled verification jobs durably enqueued',
        {},
        enqueued.length,
      );
      this.options.metrics.increment(
        'scenebook_verification_job_leases_recovered_total',
        'Expired external-runner leases recovered',
        {},
        recovered.length,
      );
      return { enqueued: enqueued.length, recovered: recovered.length };
    } finally {
      this.options.metrics.gauge(
        'scenebook_verification_scheduler_last_duration_ms',
        'Duration of the latest verification scheduling pass',
        Math.max(0, this.now().getTime() - started.getTime()),
      );
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.options.logger.error('Verification scheduler iteration failed', { error });
      });
    }, this.options.intervalMs);
    this.timer.unref();
    void this.runOnce().catch((error: unknown) => {
      this.options.logger.error('Verification scheduler startup iteration failed', { error });
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
