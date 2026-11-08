import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infra/orm.config';
import { MikroOrmUnitOfWork } from '../src/infra/persistence/repositories';
import { SystemClock, UuidV7Generator } from '../src/infra/system';
import { CreateWalletUseCase, type WalletView } from '../src/application/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../src/application/process-wager-transaction.use-case';
import type { SubmitTransactionCommand } from '../src/application/commands';
import type { Repositories, UnitOfWork } from '../src/application/ports';
import { OutboxMessage } from '../src/domain/outbox-message';
import { Money } from '../src/domain/money';
import { FailureCode } from '../src/domain/failure-code';
import {
  WagerTransactionKind as K, WagerTransactionStatus as S, type SubmittableKind,
} from '../src/domain/wager-transaction';
import { assertBalanceMatchesLedger, countTransactions, db, ledgerOf } from './support/db';

/** Outbox transacional contra Postgres REAL. Pré-requisito: `docker compose up -d` e `bun run db:up`. */
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let createWallet: CreateWalletUseCase;
let processTx: ProcessWagerTransactionUseCase;
const touched: string[] = [];

beforeAll(async () => {
  orm = await MikroORM.init(config);
  uow = new MikroOrmUnitOfWork(orm);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  createWallet = new CreateWalletUseCase(uow, clock, ids);
  processTx = new ProcessWagerTransactionUseCase(uow, clock, ids);
});
afterAll(async () => { await orm.close(); }); // NÃO feche `db`

afterEach(async () => {
  for (const id of touched.splice(0)) await assertBalanceMatchesLedger(id);
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const money = (amount: string) => ({ amount, currency: 'BRL' });

async function newWallet(initial = '100.00'): Promise<WalletView> {
  const wallet = await createWallet.execute({ playerId: `player-${randomUUID()}`, initialBalance: brl(initial) });
  touched.push(wallet.id);
  return wallet;
}

function cmd(w: WalletView, o: { amount?: string; kind?: SubmittableKind } = {}): SubmitTransactionCommand {
  const externalId = `ext-${randomUUID()}`;
  return {
    providerId: 'prov-oe', externalTransactionId: externalId, idempotencyKey: `prov-oe:${externalId}`,
    playerId: w.playerId, walletId: w.id, roundId: 'r-1', gameId: 'g-1', kind: o.kind ?? K.Bet,
    money: brl(o.amount ?? '10.00'),
  };
}

interface OutboxRow {
  id: string; aggregate_id: string; event_type: string; payload: any; attempts: number; published: boolean;
}

/** Lê direto do banco (payload via ::text: independe de como o ORM mapeia jsonb). */
async function outboxOf(aggregateId: string): Promise<OutboxRow[]> {
  const rows = await db`
    SELECT id, aggregate_id, event_type, payload::text AS payload, attempts,
           (published_at IS NOT NULL) AS published
    FROM outbox_messages WHERE aggregate_id = ${aggregateId}
    ORDER BY occurred_at, id`;
  return rows.map((r: any) => ({ ...r, payload: JSON.parse(r.payload) }));
}

/** Eventos de UMA requisição, pelo correlationId (= Idempotency-Key). Não depende da ordem das linhas. */
async function eventsOf(walletId: string, correlationId: string): Promise<OutboxRow[]> {
  return (await outboxOf(walletId)).filter((e) => e.payload.correlationId === correlationId);
}

function one(events: OutboxRow[], type: string): OutboxRow {
  const found = events.filter((e) => e.event_type === type);
  if (found.length !== 1) throw new Error(`expected exactly 1 ${type}, got ${found.length}`);
  return found[0]!;
}

const types = (events: OutboxRow[]) => events.map((e) => e.event_type).sort();

/** Roda o trabalho de verdade e então FALHA: a transação inteira tem de ser desfeita. */
class RollbackAfterFirstRun implements UnitOfWork {
  private first = true;
  /** quantos eventos foram escritos antes do rollback (prova que o teste não é vácuo) */
  outboxWrites = 0;
  constructor(private readonly inner: UnitOfWork) {}

  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const fail = this.first; // a 1ª chamada é a transação externa do use case
    this.first = false;
    return this.inner.run(async (repos) => {
      const add = repos.outbox.add.bind(repos.outbox);
      repos.outbox.add = async (message) => { this.outboxWrites += 1; await add(message); };
      const result = await work(repos);
      if (fail) throw new Error('forced rollback');
      return result;
    });
  }
}

describe('eventos por caminho do use case', () => {
  const movements = [
    { kind: K.Bet, amount: '30.00', direction: 'DEBIT', balance: '70.00' },
    { kind: K.Win, amount: '25.50', direction: 'CREDIT', balance: '125.50' },
  ] as const;

  for (const m of movements) {
    test(`${m.kind}: Processed + BalanceChanged, com envelope e dinheiro em string`, async () => {
      const w = await newWallet('100.00');
      const c = cmd(w, { kind: m.kind, amount: m.amount });
      const result = await processTx.execute(c);
      expect(result.status).toBe(S.Processed);

      const events = await eventsOf(w.id, c.idempotencyKey);
      expect(types(events)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      for (const e of events) {
        expect(e.payload.eventId).toBe(e.id);
        expect(e.payload.aggregateId).toBe(w.id);
        expect(e.payload.causationId).toBe(result.transactionId);
        expect(e.attempts).toBe(0);
        expect(e.published).toBe(false);
      }
      const processed = one(events, 'WagerTransactionProcessed').payload.data;
      expect(processed.money).toEqual(money(m.amount));
      expect(processed.balance).toEqual(money(m.balance));

      const changed = one(events, 'WalletBalanceChanged').payload.data;
      expect(changed.direction).toBe(m.direction);
      expect(changed.balanceBefore).toEqual(money('100.00'));
      expect(changed.balanceAfter).toEqual(money(m.balance));
      expect(changed.walletVersion).toBe(2);
    });
  }

  test('LOSS: só Processed (saldo não muda, então não há BalanceChanged)', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { kind: K.Loss, amount: '40.00' });
    const result = await processTx.execute(c);
    expect(result.status).toBe(S.Processed);

    const events = await eventsOf(w.id, c.idempotencyKey);
    expect(types(events)).toEqual(['WagerTransactionProcessed']);
    const data = one(events, 'WagerTransactionProcessed').payload.data;
    expect(data.kind).toBe(K.Loss);
    expect(data.balance).toEqual(money('100.00'));
  });

  test('rejeição de negócio: só Rejected, com failureCode e saldo observado', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { amount: '500.00' });
    const result = await processTx.execute(c);
    expect(result.status).toBe(S.Rejected);

    const events = await eventsOf(w.id, c.idempotencyKey);
    expect(types(events)).toEqual(['WagerTransactionRejected']);
    const data = one(events, 'WagerTransactionRejected').payload.data;
    expect(data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(data.balance).toEqual(money('100.00'));
  });

  test('replay idempotente não cria eventos novos', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w);
    const first = await processTx.execute(c);
    const total = (await outboxOf(w.id)).length;
    expect(total).toBe(3); // OPENING (BalanceChanged) + Processed + BalanceChanged

    const second = await processTx.execute(c);
    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect((await outboxOf(w.id)).length).toBe(total);
  });

  test('mesma Idempotency-Key em paralelo (8x): um único par de eventos e um único débito', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { amount: '10.00' });
    const results = await Promise.all(Array.from({ length: 8 }, () => processTx.execute(c)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(types(await eventsOf(w.id, c.idempotencyKey))).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect((await ledgerOf(w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  });
});

describe('CreateWallet', () => {
  test('com saldo: BalanceChanged do OPENING, ligado à transação OPENING', async () => {
    const w = await newWallet('100.00');
    const events = await outboxOf(w.id);
    expect(types(events)).toEqual(['WalletBalanceChanged']);

    const rows = await db`SELECT id FROM wager_transactions WHERE wallet_id = ${w.id} AND kind = 'OPENING'`;
    const e = events[0]!;
    expect(e.payload.causationId).toBe(rows[0].id);
    expect(e.payload.data.direction).toBe('CREDIT');
    expect(e.payload.data.balanceBefore).toEqual(money('0.00'));
    expect(e.payload.data.balanceAfter).toEqual(money('100.00'));
    expect(e.payload.data.walletVersion).toBe(1);
  });

  test('com saldo zero: nenhum evento (limite a documentar)', async () => {
    const w = await newWallet('0.00');
    expect(await outboxOf(w.id)).toHaveLength(0);
  });
});

describe('atomicidade e visibilidade', () => {
  test('rollback da transação não deixa evento órfão', async () => {
    const w = await newWallet('100.00');
    const eventsBefore = (await outboxOf(w.id)).length;
    const ledgerBefore = (await ledgerOf(w.id)).length;

    const failing = new RollbackAfterFirstRun(uow);
    const useCase = new ProcessWagerTransactionUseCase(failing, new SystemClock(), new UuidV7Generator());
    const c = cmd(w, { amount: '30.00' });

    await expect(useCase.execute(c)).rejects.toThrow('forced rollback');

    expect(failing.outboxWrites).toBe(2); // os eventos FORAM escritos dentro da transação...
    expect((await outboxOf(w.id)).length).toBe(eventsBefore); // ...e sumiram com o rollback
    expect((await ledgerOf(w.id)).length).toBe(ledgerBefore);
    expect(await countTransactions(w.id, { kind: 'BET' })).toBe(0);

    // a mesma requisição, agora com UoW normal, processa e emite normalmente
    const ok = await processTx.execute(c);
    expect(ok.idempotentReplay).toBe(false);
    expect(types(await eventsOf(w.id, c.idempotencyKey))).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('evento é invisível para outras conexões até o commit', async () => {
    const msg = OutboxMessage.rehydrate({
      id: randomUUID(), aggregateId: randomUUID(), eventType: 'TestEvent', payload: { hello: 'world' },
      occurredAt: new Date(), attempts: 0, nextAttemptAt: new Date(),
    });
    const visible = async () =>
      (await db`SELECT count(*)::int AS n FROM outbox_messages WHERE id = ${msg.id}`)[0].n as number;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => { inserted = resolve; });

    const tx = uow.run(async (repos) => {
      await repos.outbox.add(msg);
      inserted();
      await gate;
    });
    // se a transação terminar (ou falhar) antes do sinal, o teste falha em vez de travar
    await Promise.race([insertedSignal, tx.then(() => { throw new Error('tx ended before the insert signal'); })]);

    expect(await visible()).toBe(0); // inserido, mas não commitado
    release();
    await tx;
    expect(await visible()).toBe(1);
  });
});