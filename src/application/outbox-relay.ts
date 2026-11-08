import type { OutboxMessage } from '../domain/outbox-message';
import type { Clock, EventPublisher, UnitOfWork } from './ports';

export interface OutboxRelayOptions {
  batchSize: number;
  pollIntervalMs: number;
  /** Observabilidade mínima até existirem logs/métricas: chamado a cada falha de publish ou de ciclo. */
  onError?: ((error: unknown, message?: OutboxMessage) => void) | undefined;
}

export interface RelayRunResult {
  claimed: number;
  published: number;
  failed: number;
}

const DEFAULTS = { batchSize: 50, pollIntervalMs: 500 };

/**
 * Cada ciclo é UMA transação: claim (SKIP LOCKED) -> publish -> markPublished/scheduleRetry -> commit.
 * Crash entre publish e commit => a linha volta a ficar pendente e é republicada (at-least-once);
 * o consumidor deduplica pelo eventId. A ordem entre relays concorrentes é best-effort.
 */
export class OutboxRelay {
  private readonly options: OutboxRelayOptions;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    options: Partial<OutboxRelayOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  runOnce(): Promise<RelayRunResult> {
    return this.uow.run(async (repos) => {
      const batch = await repos.outbox.claimDue(this.clock.now(), this.options.batchSize);
      let published = 0;
      let failed = 0;
      for (const message of batch) {
        let ok = false;
        try {
          await this.publisher.publish(message);
          ok = true;
        } catch (error) {
          this.options.onError?.(error, message);
        }
        if (ok) {
          message.markPublished(this.clock.now());
          published += 1;
        } else {
          message.scheduleRetry(this.clock.now());
          failed += 1;
        }
        repos.outbox.save(message);
      }
      return { claimed: batch.length, published, failed };
    });
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Conclui o ciclo em andamento (commit incluso) e para. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let claimed = 0;
      try {
        claimed = (await this.runOnce()).claimed;
      } catch (error) {
        this.options.onError?.(error);
      }
      // lote cheio => há mais; não dorme. Falhas saem do conjunto "vencido" (backoff), então não há laço quente.
      if (!this.stopping && claimed < this.options.batchSize) await this.sleep(this.options.pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done() { clearTimeout(timer); resolve(); }
    });
  }
}