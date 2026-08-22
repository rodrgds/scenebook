import { describeError, type Logger } from './logger.js';
import type { ControlPlaneRepository } from './repository.js';
import type { SecretBox } from './crypto.js';
import type { WebhookDispatcher } from './webhook.js';

export interface WebhookWorkerOptions {
  readonly repository: ControlPlaneRepository;
  readonly dispatcher: WebhookDispatcher;
  readonly secretBox: SecretBox;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
}

export class WebhookWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly intervalMs: number;

  constructor(private readonly options: WebhookWorkerOptions) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 25;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.intervalMs = options.intervalMs ?? 2_000;
  }

  async runOnce(): Promise<number> {
    const deliveries = await this.options.repository.claimWebhookDeliveries(
      this.now().toISOString(),
      this.batchSize,
    );
    await Promise.all(
      deliveries.map(async (delivery) => {
        try {
          const submission = await this.options.repository.getCtaSubmission(delivery.submissionId);
          if (!submission) throw new Error('CTA submission is missing');
          const payload = this.options.secretBox.decrypt<unknown>(submission.encryptedPayload);
          const response = await this.options.dispatcher.deliver(
            delivery.webhookId,
            payload,
            this.now(),
          );
          await this.options.repository.completeWebhookDelivery({
            id: delivery.id,
            succeeded: true,
            status: response.status,
          });
        } catch (error) {
          const terminal = delivery.attempts >= this.maxAttempts;
          const delay = Math.min(
            6 * 60 * 60 * 1_000,
            1_000 * 2 ** Math.max(0, delivery.attempts - 1),
          );
          const report: Parameters<
            ControlPlaneRepository['completeWebhookDelivery']
          >[0] = {
            id: delivery.id,
            succeeded: false,
            terminal,
            error: error instanceof Error ? error.message : 'Unknown webhook failure',
          };
          if (!terminal) {
            report.nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
          }
          await this.options.repository.completeWebhookDelivery(report);
          this.options.logger.warn('Webhook delivery failed', {
            deliveryId: delivery.id,
            webhookId: delivery.webhookId,
            attempt: delivery.attempts,
            terminal,
            error: error instanceof Error ? error.message : 'unknown',
          });
        }
      }),
    );
    return deliveries.length;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        await this.runOnce();
      } catch (error) {
        this.options.logger.error('Webhook worker iteration failed', {
          error: describeError(error),
        });
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
