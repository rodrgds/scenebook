import { randomUUID } from 'node:crypto';

import type { Logger } from './logger.js';
import type { MetricsRegistry } from './metrics.js';
import { stagingObjectKey, type ImmutableObjectStore } from './object-store.js';
import type { ControlPlaneRepository } from './repository.js';

export interface UploadGarbageCollectorOptions {
  readonly repository: ControlPlaneRepository;
  readonly objectStore: ImmutableObjectStore;
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly claimTtlSeconds: number;
  readonly now?: () => Date;
  readonly claimId?: () => string;
}

export class UploadGarbageCollector {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly now: () => Date;
  private readonly claimId: () => string;

  constructor(private readonly options: UploadGarbageCollectorOptions) {
    this.now = options.now ?? (() => new Date());
    this.claimId = options.claimId ?? (() => `upload-gc-${randomUUID()}`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const started = this.now();
    const claimId = this.claimId();
    try {
      const uploads = await this.options.repository.claimExpiredUploads({
        now: started.toISOString(),
        limit: this.options.batchSize,
        claimId,
        claimedUntil: new Date(
          started.getTime() + this.options.claimTtlSeconds * 1_000,
        ).toISOString(),
      });
      this.options.metrics.increment(
        'scenebook_upload_gc_claimed_total',
        'Expired artifact uploads claimed for garbage collection',
        {},
        uploads.length,
      );
      let completed = 0;
      for (const upload of uploads) {
        if (upload.status !== 'expired') continue;
        let deletedObjects = 0;
        let deletedBytes = 0;
        try {
          for (const object of upload.objects) {
            if (object.status === 'finalized' || object.finalKey) continue;
            const keys = object.stagingKey
              ? [object.stagingKey]
              : [
                  stagingObjectKey(upload.id, object.sha256, object.mediaType),
                  // Before media became part of the staged identity, crash-window
                  // objects used this path. Probe it during rolling upgrades.
                  `staging/${upload.id}/${object.sha256}`,
                ];
            let foundCrashWindowObject = false;
            for (const key of new Set(keys)) {
              const staged = {
                key,
                sha256: object.sha256,
                byteLength: object.byteLength,
                mediaType: object.mediaType,
              };
              // A process can stop after the immutable store commit but before
              // stagingKey is recorded. Probe pending records at every
              // deterministic key so those crash-window objects are reclaimed.
              foundCrashWindowObject ||= await this.options.objectStore.verify(staged);
              await this.options.objectStore.deleteStaged(staged);
            }
            const countDeletion = object.status === 'staged' || foundCrashWindowObject;
            if (!countDeletion) continue;
            deletedObjects += 1;
            deletedBytes += object.byteLength;
          }
          if (
            !(await this.options.repository.completeExpiredUpload(
              upload.id,
              claimId,
              this.now().toISOString(),
            ))
          ) {
            throw new Error('Expired upload garbage-collection claim was lost');
          }
          completed += 1;
          this.options.metrics.increment(
            'scenebook_upload_gc_deleted_objects_total',
            'Abandoned staged artifact objects deleted',
            {},
            deletedObjects,
          );
          this.options.metrics.increment(
            'scenebook_upload_gc_deleted_bytes_total',
            'Abandoned staged artifact bytes deleted',
            {},
            deletedBytes,
          );
        } catch (error) {
          this.options.metrics.increment(
            'scenebook_upload_gc_failures_total',
            'Artifact upload garbage-collection failures',
          );
          this.options.logger.warn('Artifact upload garbage collection failed', {
            uploadId: upload.id,
            error,
          });
        }
      }
      return completed;
    } finally {
      this.options.metrics.gauge(
        'scenebook_upload_gc_last_duration_ms',
        'Duration of the last artifact upload garbage-collection pass',
        Math.max(0, this.now().getTime() - started.getTime()),
      );
      this.running = false;
    }
  }
}
