import { InvalidTransactionStateError } from './errors';
import type { IntegrationEvent } from './events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 300_000;

/** Backoff exponencial determinístico: 1s, 2s, 4s, ... até 5 min. (O jitter, se houver, é do worker.) */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Mensagem da outbox: o evento já serializado, gravado NA MESMA transação do saldo.
 * O id da mensagem É o eventId: um consumidor deduplica entregas repetidas por ele.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** Nasce pendente e já elegível para publicação. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e com a hora da próxima tentativa já alcançada. */
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this._publishedAt = at;
  }

  /** Conta uma tentativa que falhou e agenda a próxima com backoff exponencial. */
  scheduleRetry(now: Date): void {
    this.assertPending('scheduleRetry');
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + outboxBackoffMs(this._attempts));
  }

  private assertPending(operation: string): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`cannot ${operation} outbox message ${this.id}: already published`);
    }
  }
}