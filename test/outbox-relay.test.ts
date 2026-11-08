import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infra/orm.config';
import { MikroOrmUnitOfWork } from '../src/infra/persistence/repositories';
import { SystemClock, UuidV7Generator } from '../src/infra/system';
import { OutboxRelay, type RelayRunResult } from '../src/application/outbox-relay';
import { CreateWalletUseCase } from '../src/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../src/application/process-wager-transaction.use-case';
import type { Clock, EventPublisher, Repositories, UnitOfWork } from '../src/application/ports';
import { OutboxMessage } from '../src/domain/outbox-message';
import { Money } from '../src/domain/money';
import { WagerTransactionKind as K } from '../src/domain/wager-transaction';
import { assertBalanceMatchesLedger, db } from './support/db';

/**
 * Relay do outbox contra Postgres REAL.
 * NÃO rode junto com outras suítes nem com a API no ar: cada teste começa drenando TODOS os pendentes.
 */
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let createWallet: CreateWalletUseCase;
let processTx: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  uow = new MikroOrmUnitOfWork(orm);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  createWallet = new CreateWalletUseCase(uow, clock, ids);
  processTx = new ProcessWagerTransactionUseCase(uow, clock, ids);
});
afterAll(async () => { await orm.close(); }); // NÃO feche `db`

const T0 = new Date('2030-01-01T00:00:00.000Z');

class FakeClock implements Clock {
  constructor(private t: Date) {}
  now(): Date { return new Date(this.t.getTime()); }
  advance(ms: number): void { this.t = new Date(this.t.getTime() + ms); }
}

class RecordingPublisher implements EventPublisher {
  readonly published: OutboxMessage[] = [];
  constructor(
    private readonly hooks: {
      beforePublish?: (m: OutboxMessage) => Promise<void>;
      failFor?: (m: OutboxMessage) => boolean;
    } = {},
  ) {}
  async publish(m: OutboxMessage): Promise<void> {
    await this.hooks.beforePublish?.(m);
    if (this.hooks.failFor?.(m)) throw new Error(`publish failed for ${m.id}`);
    this.published.push(m);
  }
}

/** Roda o trabalho de verdade e então "cai" antes do commit. */
class CrashBeforeCommit implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {}
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run(async (repos) => {
      await work(repos);
      throw new Error('crash before commit');
    });
  }
}

/** Falha por timeout em vez de travar o teste (usado para detectar um relay bloqueado). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const drain = () => db`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;

async function seed(n: number, at: Date): Promise<string[]> {
  const ids: string[] = [];
  await uow.run(async (repos) => {
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      ids.push(id);
      await repos.outbox.add(
        OutboxMessage.rehydrate({
          id, aggregateId: randomUUID(), eventType: 'TestEvent',
          payload: { eventId: id, eventType: 'TestEvent', version: 1, data: {} },
          occurredAt: at, attempts: 0, nextAttemptAt: at,
        }),
      );
    }
  });
  return ids;
}

/** Datas lidas como epoch-ms em texto: não dependem de como o driver devolve timestamptz. */
async function stateOf(id: string) {
  const [r] = await db`
    SELECT attempts, (published_at IS NOT NULL) AS published,
           floor(extract(epoch FROM next_attempt_at) * 1000)::text AS next_ms,
           floor(extract(epoch FROM published_at) * 1000)::text AS published_ms
    FROM outbox_messages WHERE id = ${id}`;
  return {
    attempts: r.attempts as number,
    published: r.published as boolean,
    nextMs: Number(r.next_ms),
    publishedMs: r.published_ms === null ? null : Number(r.published_ms),
  };
}

test('publica os pendentes e marca como publicados; o 2º ciclo não acha nada', async () => {
  await drain();
  const ids = await seed(5, T0);
  const publisher = new RecordingPublisher();
  const relay = new OutboxRelay(uow, publisher, new FakeClock(T0));

  expect(await relay.runOnce()).toEqual({ claimed: 5, published: 5, failed: 0 });
  expect(publisher.published.map((m) => m.id).sort()).toEqual([...ids].sort());
  for (const id of ids) {
    const s = await stateOf(id);
    expect(s.published).toBe(true);
    expect(s.publishedMs).toBe(T0.getTime());
    expect(s.attempts).toBe(0);
  }
  expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
});

test('dois relays concorrentes: sem duplicar e sem esperar um pelo outro (SKIP LOCKED)', async () => {
  await drain();
  const ids = await seed(6, new Date(Date.now() - 1000));

  let aEntered!: () => void;
  const aInside = new Promise<void>((resolve) => { aEntered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const pubA = new RecordingPublisher({ beforePublish: async () => { aEntered(); await gate; } });
  const pubB = new RecordingPublisher();
  const clock = new SystemClock();
  const relayA = new OutboxRelay(uow, pubA, clock, { batchSize: 3 });
  const relayB = new OutboxRelay(uow, pubB, clock, { batchSize: 3 });

  const runA = relayA.runOnce();
  // B só começa quando A já travou as suas 3 linhas e está parado dentro do publish
  const runB = (async () => { await aInside; return relayB.runOnce(); })();

  let resultB: RelayRunResult | undefined;
  try {
    await within(aInside, 5000, 'relay A never reached publish');
    resultB = await within(
      runB, 3000, "relay B blocked on A's locked rows (FOR UPDATE sem SKIP LOCKED?)",
    );
  } finally {
    release();
    await Promise.allSettled([runA, runB]); // nunca deixa transação pendurada para o próximo teste
  }

  expect(resultB).toEqual({ claimed: 3, published: 3, failed: 0 });
  expect(await runA).toEqual({ claimed: 3, published: 3, failed: 0 });

  const a = pubA.published.map((m) => m.id);
  const b = pubB.published.map((m) => m.id);
  expect(a.filter((id) => b.includes(id))).toEqual([]);          // nenhuma linha nos dois
  expect([...a, ...b].sort()).toEqual([...ids].sort());           // e nenhuma ficou de fora
  for (const id of ids) expect((await stateOf(id)).published).toBe(true);
});

test('falha de publish: retry com backoff 1s, 2s (Clock falso) e publica quando o broker volta', async () => {
  await drain();
  const [id] = await seed(1, T0);
  const clock = new FakeClock(T0);
  let failing = true;
  const errors: Array<string | undefined> = [];
  const publisher = new RecordingPublisher({ failFor: () => failing });
  const relay = new OutboxRelay(uow, publisher, clock, { onError: (_e, m) => errors.push(m?.id) });

  expect(await relay.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
  let s = await stateOf(id!);
  expect(s).toMatchObject({ attempts: 1, published: false, nextMs: T0.getTime() + 1000 });

  expect((await relay.runOnce()).claimed).toBe(0);   // mesmo instante: ainda não venceu
  clock.advance(999);
  expect((await relay.runOnce()).claimed).toBe(0);   // 1 ms antes do vencimento
  clock.advance(1);                                  // t0 + 1000
  expect(await relay.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
  s = await stateOf(id!);
  expect(s).toMatchObject({ attempts: 2, published: false, nextMs: T0.getTime() + 1000 + 2000 });

  failing = false;                                   // o broker voltou
  clock.advance(1999);
  expect((await relay.runOnce()).claimed).toBe(0);
  clock.advance(1);                                  // t0 + 3000
  expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
  s = await stateOf(id!);
  expect(s).toMatchObject({ attempts: 2, published: true, publishedMs: T0.getTime() + 3000 });

  expect(errors).toEqual([id, id]);                  // a falha nunca é engolida em silêncio
});

test('falha isolada: uma mensagem ruim não impede as outras do mesmo lote', async () => {
  await drain();
  const ids = await seed(3, T0);
  const bad = ids[1]!;
  const relay = new OutboxRelay(uow, new RecordingPublisher({ failFor: (m) => m.id === bad }), new FakeClock(T0));

  expect(await relay.runOnce()).toEqual({ claimed: 3, published: 2, failed: 1 });
  for (const id of ids) {
    const s = await stateOf(id);
    expect(s.published).toBe(id !== bad);
    expect(s.attempts).toBe(id === bad ? 1 : 0);
  }
});

test('crash entre publicar e commitar: a linha volta pendente e é republicada com o MESMO eventId', async () => {
  await drain();
  const [id] = await seed(1, T0);
  const clock = new FakeClock(T0);

  const pub1 = new RecordingPublisher();
  const crashing = new OutboxRelay(new CrashBeforeCommit(uow), pub1, clock);
  await expect(crashing.runOnce()).rejects.toThrow('crash before commit');
  expect(pub1.published.map((m) => m.id)).toEqual([id!]);                   // o broker JÁ recebeu
  expect(await stateOf(id!)).toMatchObject({ published: false, attempts: 0 }); // mas o banco não sabe

  const pub2 = new RecordingPublisher();
  expect(await new OutboxRelay(uow, pub2, clock).runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
  expect(pub2.published.map((m) => m.id)).toEqual([id!]);                   // at-least-once: mesma identidade
  expect((await stateOf(id!)).published).toBe(true);
});

test('contrato: o publisher recebe o envelope completo; jsonb chega como objeto e dinheiro como string', async () => {
  await drain();
  const w = await createWallet.execute({
    playerId: `player-${randomUUID()}`, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  const externalId = `ext-${randomUUID()}`;
  const result = await processTx.execute({
    providerId: 'prov-relay', externalTransactionId: externalId, idempotencyKey: `prov-relay:${externalId}`,
    playerId: w.playerId, walletId: w.id, roundId: 'r-1', gameId: 'g-1', kind: K.Bet,
    money: Money.from({ amount: '30.00', currency: 'BRL' }),
  });

  const publisher = new RecordingPublisher();
  expect(await new OutboxRelay(uow, publisher, new SystemClock()).runOnce())
    .toEqual({ claimed: 3, published: 3, failed: 0 }); // OPENING + Processed + BalanceChanged

  const messages = publisher.published;
  expect(new Set(messages.map((m) => m.id)).size).toBe(3);
  for (const m of messages) {
    expect(typeof m.payload).toBe('object');                  // não é string dupla-codificada
    expect(m.payload.eventId).toBe(m.id);
    expect(m.payload.eventType).toBe(m.eventType);
    expect(m.payload.aggregateId).toBe(w.id);
    expect(typeof m.payload.occurredAt).toBe('string');
    expect(JSON.parse(JSON.stringify(m.payload))).toEqual(m.payload);
  }
  const processed = messages.find((m) => m.eventType === 'WagerTransactionProcessed')!;
  const data = processed.payload.data as any;
  expect(data.money).toEqual({ amount: '30.00', currency: 'BRL' });
  expect(data.balance).toEqual({ amount: '70.00', currency: 'BRL' });
  expect(typeof data.money.amount).toBe('string');
  expect(processed.payload.causationId).toBe(result.transactionId);
  await assertBalanceMatchesLedger(w.id);
});

test('stop() espera o ciclo em andamento concluir (commit incluso)', async () => {
  await drain();
  const [id] = await seed(1, new Date(Date.now() - 1000));

  let entered!: () => void;
  const enteredSignal = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const publisher = new RecordingPublisher({ beforePublish: async () => { entered(); await gate; } });
  const relay = new OutboxRelay(uow, publisher, new SystemClock(), { batchSize: 10, pollIntervalMs: 10 });

  try {
    relay.start();
    await within(enteredSignal, 5000, 'relay never reached publish');

    let stopped = false;
    const stopping = relay.stop().then(() => { stopped = true; });
    await Bun.sleep(100); // só pode FALHAR por um stop() que abandona o ciclo; o caminho certo nunca é flaky
    expect(stopped).toBe(false);
    expect((await stateOf(id!)).published).toBe(false); // ainda não commitou

    release();
    await within(stopping, 5000, 'stop() never resolved');
    expect((await stateOf(id!)).published).toBe(true);  // o ciclo em andamento terminou e commitou
  } finally {
    release();
    await relay.stop();
  }
});