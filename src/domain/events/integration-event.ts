export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Contexto que o use case entrega à fábrica de cada evento (o domínio não gera ids nem lê o relógio). */
export interface EventContext {
  eventId: string;
  /** liga todos os efeitos de uma mesma requisição (aqui: a Idempotency-Key) */
  correlationId: string;
  /** o que causou este evento (aqui: o id da transação) */
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Envelope de um evento de integração. `eventType` e `version` ficam NO TIPO (uma subclasse por evento).
 * `data` carrega só tipos serializáveis (MoneyProps como string decimal, datas em ISO): o payload
 * precisa ser JSON estável e versionável, nunca instâncias de classes de domínio.
 *
 * `aggregateId` é SEMPRE o id da wallet: ela é a fronteira de consistência, e é por ela que um consumidor
 * (ou um grupo FIFO do SQS) agrupa os eventos.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}