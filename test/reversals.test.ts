import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infra/orm.config';
import { MikroOrmUnitOfWork } from '../src/infra/persistence/repositories';
import { SystemClock, UuidV7Generator } from '../src/infra/system';
import { CreateWalletUseCase, type WalletView } from '../src/application/create-wallet.use-case';
import {
  ProcessWagerTransactionUseCase, type TransactionResult,
} from '../src/application/process-wager-transaction.use-case';
import { PendingReferenceWorker } from '../src/application/pending-reference-worker';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../src/application/pending-reference-policy';
import type { SubmitTransactionCommand } from '../src/application/commands';
import type { Clock } from '../src/application/ports';
import { Money } from '../src/domain/money';
import { FailureCode as F } from '../src/domain/failure-code';
import {
  WagerTransactionKind as K, WagerTransactionStatus as S, type SubmittableKind,
} from '../src/domain/wager-transaction';
import { assertBalanceMatchesLedger, db, ledgerOf } from './support/db';

/** REFUND/ROLLBACK e PENDING_REFERENCE contra Postgres REAL. Pré-requisito: `docker compose up -d` e `bun run db:up`. */
class OffsetClock implements Clock {
  offsetMs = 0;
  now(): Date { return new Date(Date.now() + this.offsetMs); }
  advance(ms: number): void { this.offsetMs += ms; }
}

const PROVIDER = 'prov-rv';
const HOUR = 3_600_000;
const clock = new OffsetClock(); // só o worker usa: avançar o relógio dele vence os backoffs sem sleep

let orm: MikroORM;
let ids: UuidV7Generator;
let createWallet: CreateWalletUseCase;
let processTx: ProcessWagerTransactionUseCase;
let worker: PendingReferenceWorker;
const touched: string[] = [];

beforeAll(async () => {
  orm = await MikroORM.init(config);
  const uow = new MikroOrmUnitOfWork(orm);
  ids = new UuidV7Generator();
  createWallet = new CreateWalletUseCase(uow, new SystemClock(), ids);
  processTx = new ProcessWagerTransactionUseCase(uow, new SystemClock(), ids);
  worker = new PendingReferenceWorker(uow, clock, ids);
});
afterAll(async () => { await orm.close(); }); // NÃO feche `db`
beforeEach(() => { clock.offsetMs = 0; });
afterEach(async () => {
  for (const id of touched.splice(0)) await assertBalanceMatchesLedger(id);
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

async function newWallet(initial = '100.00'): Promise<WalletView> {
  const w = await createWallet.execute({ playerId: `player-${randomUUID()}`, initialBalance: brl(initial) });
  touched.push(w.id);
  return w;
}

interface Over {
  kind?: SubmittableKind; amount?: string; externalId?: string; ref?: string; roundId?: string;
}
function cmd(w: WalletView, o: Over = {}): SubmitTransactionCommand {
  const externalId = o.externalId ?? `ext-${randomUUID()}`;
  return {
    providerId: PROVIDER, externalTransactionId: externalId, idempotencyKey: `${PROVIDER}:${externalId}`,
    playerId: w.playerId, walletId: w.id, roundId: o.roundId ?? 'r-1', gameId: 'g-1', kind: o.kind ?? K.Bet,
    money: brl(o.amount ?? '10.00'),
    ...(o.ref !== undefined ? { referenceExternalTransactionId: o.ref } : {}),
  };
}

interface Submitted { c: SubmitTransactionCommand; r: TransactionResult }
async function submit(w: WalletView, o: Over = {}): Promise<Submitted> {
  const c = cmd(w, o);
  return { c, r: await processTx.execute(c) };
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = await db`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return rows[0].balance;
}

async function txRow(id: string) {
  const rows = await db`
    SELECT status, failure_code, reference_transaction_id, pending_attempts
    FROM wager_transactions WHERE id = ${id}`;
  return rows[0] as {
    status: string; failure_code: string | null; reference_transaction_id: string | null; pending_attempts: number;
  };
}

/** Os lançamentos são comparados como multiconjunto: a ordem por created_at pode empatar no mesmo ms. */
async function directions(walletId: string): Promise<string[]> {
  return (await ledgerOf(walletId)).map((e) => e.direction).sort();
}
async function ledgerFor(walletId: string, txId: string) {
  return (await ledgerOf(walletId)).filter((e) => e.transaction_id === txId);
}
async function eventTypes(walletId: string, correlationId: string): Promise<string[]> {
  const rows = await db`
    SELECT event_type FROM outbox_messages
    WHERE aggregate_id = ${walletId} AND payload->>'correlationId' = ${correlationId}`;
  return rows.map((r: { event_type: string }) => r.event_type).sort();
}

describe('reversões aplicadas', () => {
  test('REFUND de BET credita de volta, liga à BET e emite os dois eventos', async () => {
    const w = await newWallet('100.00');
    const bet = await submit(w, { amount: '30.00' });
    const refund = await submit(w, { kind: K.Refund, amount: '30.00', ref: bet.c.externalTransactionId });

    expect(refund.r).toMatchObject({
      status: S.Processed, idempotentReplay: false, balance: { amount: '100.00', currency: 'BRL' },
    });
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await directions(w.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']); // OPENING, BET, REFUND
    expect((await txRow(refund.r.transactionId)).reference_transaction_id).toBe(bet.r.transactionId);
    expect(await eventTypes(w.id, refund.c.idempotencyKey)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('ROLLBACK de BET credita (inverso do débito)', async () => {
    const w = await newWallet('100.00');
    const bet = await submit(w, { amount: '30.00' });
    const rollback = await submit(w, { kind: K.Rollback, amount: '30.00', ref: bet.c.externalTransactionId });

    expect(rollback.r).toMatchObject({ status: S.Processed, balance: { amount: '100.00' } });
    expect(await directions(w.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']);
  });

  test('ROLLBACK de WIN debita (inverso do crédito)', async () => {
    const w = await newWallet('100.00');
    const win = await submit(w, { kind: K.Win, amount: '25.50' });
    expect(await balanceOf(w.id)).toBe('125.50');
    const rollback = await submit(w, { kind: K.Rollback, amount: '25.50', ref: win.c.externalTransactionId });

    expect(rollback.r).toMatchObject({ status: S.Processed, balance: { amount: '100.00' } });
    expect(await directions(w.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']); // OPENING, WIN, ROLLBACK(débito)
  });

  test('ROLLBACK de REFUND debita; a BET continua revertida (reversão única, decisão 6)', async () => {
    const w = await newWallet('100.00');
    const bet = await submit(w, { amount: '30.00' });
    const refund = await submit(w, { kind: K.Refund, amount: '30.00', ref: bet.c.externalTransactionId });
    const rollback = await submit(w, { kind: K.Rollback, amount: '30.00', ref: refund.c.externalTransactionId });

    expect(rollback.r).toMatchObject({ status: S.Processed, balance: { amount: '70.00' } });
    expect(await directions(w.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT', 'DEBIT']);

    const again = await submit(w, { kind: K.Refund, amount: '30.00', ref: bet.c.externalTransactionId });
    expect(again.r).toMatchObject({ status: S.Rejected, failureCode: F.AlreadyReversed });
    expect(await balanceOf(w.id)).toBe('70.00');
  });
});

describe('reversão única', () => {
  test('REFUND e depois ROLLBACK da mesma BET: o segundo é rejeitado (ALREADY_REVERSED), sem lançamento', async () => {
    const w = await newWallet('100.00');
    const bet = await submit(w, { amount: '30.00' });
    await submit(w, { kind: K.Refund, amount: '30.00', ref: bet.c.externalTransactionId });
    const second = await submit(w, { kind: K.Rollback, amount: '30.00', ref: bet.c.externalTransactionId });

    expect(second.r).toMatchObject({ status: S.Rejected, failureCode: F.AlreadyReversed });
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await ledgerFor(w.id, second.r.transactionId)).toHaveLength(0);
    expect(await eventTypes(w.id, second.c.idempotencyKey)).toEqual(['WagerTransactionRejected']);
  });

  test('6 reversões em paralelo (REFUND e ROLLBACK, chaves diferentes) da mesma BET: exatamente 1 crédito', async () => {
    const w = await newWallet('100.00');
    const bet = await submit(w, { amount: '40.00' });
    const kinds = [K.Refund, K.Rollback, K.Refund, K.Rollback, K.Refund, K.Rollback] as const;
    const results = await Promise.all(
      kinds.map((kind) => submit(w, { kind, amount: '40.00', ref: bet.c.externalTransactionId })),
    );

    expect(results.filter((x) => x.r.status === S.Processed)).toHaveLength(1);
    expect(results.filter((x) => x.r.failureCode === F.AlreadyReversed)).toHaveLength(5);
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await directions(w.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']);
  });
});

describe('rejeições de reversão (REJECTED auditável: sem lançamento, com evento)', () => {
  const rejections: Array<{
    name: string; code: F; run: (w: WalletView) => Promise<Submitted>;
  }> = [
    {
      name: 'valor diferente da referência', code: F.AmountMismatch,
      run: async (w) => {
        const bet = await submit(w, { amount: '30.00' });
        return submit(w, { kind: K.Refund, amount: '20.00', ref: bet.c.externalTransactionId });
      },
    },
    {
      name: 'REFUND de WIN', code: F.InvalidReferenceKind,
      run: async (w) => {
        const win = await submit(w, { kind: K.Win, amount: '30.00' });
        return submit(w, { kind: K.Refund, amount: '30.00', ref: win.c.externalTransactionId });
      },
    },
    {
      name: 'ROLLBACK de LOSS', code: F.InvalidReferenceKind,
      run: async (w) => {
        const loss = await submit(w, { kind: K.Loss, amount: '30.00' });
        return submit(w, { kind: K.Rollback, amount: '30.00', ref: loss.c.externalTransactionId });
      },
    },
    {
      name: 'rodada diferente', code: F.ReferenceMismatch,
      run: async (w) => {
        const bet = await submit(w, { amount: '30.00', roundId: 'r-1' });
        return submit(w, { kind: K.Refund, amount: '30.00', roundId: 'r-2', ref: bet.c.externalTransactionId });
      },
    },
    {
      name: 'referência de outro jogador/wallet', code: F.ReferenceMismatch,
      run: async (w) => {
        const other = await newWallet('100.00');
        const bet = await submit(other, { amount: '10.00' });
        return submit(w, { kind: K.Refund, amount: '10.00', ref: bet.c.externalTransactionId });
      },
    },
    {
      name: 'referência REJECTED', code: F.ReferenceNotProcessed,
      run: async (w) => {
        const bet = await submit(w, { amount: '500.00' }); // saldo 100: rejeitada
        expect(bet.r.status).toBe(S.Rejected);
        return submit(w, { kind: K.Refund, amount: '500.00', ref: bet.c.externalTransactionId });
      },
    },
    {
      name: 'referência a si mesma', code: F.InvalidReferenceKind,
      run: async (w) => {
        const id = `ext-${randomUUID()}`;
        return submit(w, { kind: K.Refund, amount: '10.00', externalId: id, ref: id });
      },
    },
  ];

  for (const c of rejections) {
    test(`${c.name} -> ${c.code}`, async () => {
      const w = await newWallet('100.00');
      const { c: command, r } = await c.run(w);

      expect(r).toMatchObject({ status: S.Rejected, failureCode: c.code, idempotentReplay: false });
      expect(r.balance?.amount).toBe(await balanceOf(w.id)); // rejeição não move saldo: o observado é o atual
      expect(await ledgerFor(w.id, r.transactionId)).toHaveLength(0);
      expect((await txRow(r.transactionId)).status).toBe('REJECTED');
      expect(await eventTypes(w.id, command.idempotencyKey)).toEqual(['WagerTransactionRejected']);
    });
  }

  test('reversão que estouraria o saldo: REVERSAL_WOULD_OVERDRAW, distinto de INSUFFICIENT_FUNDS', async () => {
    const w = await newWallet('100.00');
    const win = await submit(w, { kind: K.Win, amount: '50.00' });       // 150
    await submit(w, { amount: '140.00' });                                // 10
    const rollback = await submit(w, { kind: K.Rollback, amount: '50.00', ref: win.c.externalTransactionId });

    expect(rollback.r).toMatchObject({ status: S.Rejected, failureCode: F.ReversalWouldOverdraw });
    expect(rollback.r.failureCode).not.toBe(F.InsufficientFunds);
    expect(await balanceOf(w.id)).toBe('10.00');
    expect((await txRow(rollback.r.transactionId)).failure_code).toBe('REVERSAL_WOULD_OVERDRAW'); // auditável
    expect(await ledgerFor(w.id, rollback.r.transactionId)).toHaveLength(0);

    const bet = await submit(w, { amount: '500.00' });
    expect(bet.r.failureCode).toBe(F.InsufficientFunds);
  });
});

describe('referência fora de ordem (PENDING_REFERENCE)', () => {
  test('REFUND antes da BET: pendente; a BET chega; o worker aplica; o replay devolve o resultado final', async () => {
    const w = await newWallet('100.00');
    const betId = `ext-${randomUUID()}`;
    const refund = await submit(w, { kind: K.Refund, amount: '30.00', ref: betId });

    expect(refund.r.status).toBe(S.PendingReference);
    expect(refund.r.balance).toBeUndefined();
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await eventTypes(w.id, refund.c.idempotencyKey)).toEqual(['WagerTransactionPendingReference']);

    const same = await processTx.execute(refund.c); // mesma requisição: continua pendente, replay, sem evento novo
    expect(same).toMatchObject({ status: S.PendingReference, idempotentReplay: true });
    expect(await eventTypes(w.id, refund.c.idempotencyKey)).toEqual(['WagerTransactionPendingReference']);

    clock.advance(HOUR); // a BET ainda não chegou: conta a tentativa, não gera evento
    expect(await worker.resolve(refund.r.transactionId, w.id)).toBe('stillPending');
    expect((await txRow(refund.r.transactionId)).pending_attempts).toBe(2);
    expect(await eventTypes(w.id, refund.c.idempotencyKey)).toEqual(['WagerTransactionPendingReference']);

    const bet = await submit(w, { amount: '30.00', externalId: betId });
    expect(bet.r.status).toBe(S.Processed);
    expect(await balanceOf(w.id)).toBe('70.00');

    clock.advance(HOUR);
    expect(await worker.resolve(refund.r.transactionId, w.id)).toBe('processed');
    expect(await balanceOf(w.id)).toBe('100.00');
    const row = await txRow(refund.r.transactionId);
    expect(row).toMatchObject({ status: 'PROCESSED', reference_transaction_id: bet.r.transactionId });
    expect(await eventTypes(w.id, refund.c.idempotencyKey)).toEqual(
      ['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged'],
    );

    const replay = await processTx.execute(refund.c);
    expect(replay).toMatchObject({ status: S.Processed, idempotentReplay: true, balance: { amount: '100.00' } });
  });

  test('cadeia: ROLLBACK de um REFUND que ainda espera a BET também espera, e resolve na ordem certa', async () => {
    const w = await newWallet('100.00');
    const betId = `ext-${randomUUID()}`;
    const refundId = `ext-${randomUUID()}`;
    const refund = await submit(w, { kind: K.Refund, amount: '30.00', externalId: refundId, ref: betId });
    const rollback = await submit(w, { kind: K.Rollback, amount: '30.00', ref: refundId });
    expect(refund.r.status).toBe(S.PendingReference);
    expect(rollback.r.status).toBe(S.PendingReference); // a referência existe, mas ainda está pendente

    await submit(w, { amount: '30.00', externalId: betId });
    expect(await balanceOf(w.id)).toBe('70.00');

    clock.advance(HOUR);
    expect(await worker.resolve(rollback.r.transactionId, w.id)).toBe('stillPending'); // o REFUND ainda não foi aplicado
    clock.advance(HOUR);
    expect(await worker.resolve(refund.r.transactionId, w.id)).toBe('processed');
    expect(await balanceOf(w.id)).toBe('100.00');
    clock.advance(HOUR);
    expect(await worker.resolve(rollback.r.transactionId, w.id)).toBe('processed');
    expect(await balanceOf(w.id)).toBe('70.00');
    expect(await directions(w.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT', 'DEBIT']);
  });

  test('referência que nunca chega: esgota a política e vira REJECTED com REFERENCE_NOT_FOUND + evento', async () => {
    const w = await newWallet('100.00');
    const refund = await submit(w, { kind: K.Refund, amount: '30.00', ref: `ext-${randomUUID()}` });
    expect(refund.r.status).toBe(S.PendingReference);

    const max = DEFAULT_PENDING_REFERENCE_POLICY.maxAttempts;
    for (let i = 1; i < max; i++) {
      clock.advance(HOUR);
      expect(await worker.resolve(refund.r.transactionId, w.id)).toBe('stillPending');
    }
    expect((await txRow(refund.r.transactionId)).pending_attempts).toBe(max);

    clock.advance(HOUR);
    expect(await worker.resolve(refund.r.transactionId, w.id)).toBe('rejected');
    expect(await txRow(refund.r.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await ledgerFor(w.id, refund.r.transactionId)).toHaveLength(0);
    expect(await eventTypes(w.id, refund.c.idempotencyKey)).toEqual(
      ['WagerTransactionPendingReference', 'WagerTransactionRejected'],
    );

    const replay = await processTx.execute(refund.c);
    expect(replay).toMatchObject({
      status: S.Rejected, failureCode: F.ReferenceNotFound, idempotentReplay: true, balance: { amount: '100.00' },
    });
  });

  test('antes do vencimento o worker não toca na transação', async () => {
    const w = await newWallet('100.00');
    const refund = await submit(w, { kind: K.Refund, amount: '30.00', ref: `ext-${randomUUID()}` });

    clock.advance(-HOUR); // o relógio do worker está ANTES do próximo vencimento
    expect(await worker.resolve(refund.r.transactionId, w.id)).toBe('skipped');
    expect(await txRow(refund.r.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', pending_attempts: 1 });
  });

  test('4 workers sobre o mesmo pendente: 1 aplica, 3 descartam, 1 único crédito', async () => {
    const w = await newWallet('100.00');
    const betId = `ext-${randomUUID()}`;
    const refund = await submit(w, { kind: K.Refund, amount: '30.00', ref: betId });
    await submit(w, { amount: '30.00', externalId: betId });

    clock.advance(HOUR);
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => worker.resolve(refund.r.transactionId, w.id)),
    );

    expect([...outcomes].sort()).toEqual(['processed', 'skipped', 'skipped', 'skipped']);
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await directions(w.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']);
  });

  test('runOnce varre os vencidos e aplica o nosso', async () => {
    const w = await newWallet('100.00');
    const betId = `ext-${randomUUID()}`;
    const refund = await submit(w, { kind: K.Refund, amount: '30.00', ref: betId });
    await submit(w, { amount: '30.00', externalId: betId });

    clock.advance(HOUR);
    const sweeper = new PendingReferenceWorker(new MikroOrmUnitOfWork(orm), clock, ids, { batchSize: 1000 });
    const run = await sweeper.runOnce();

    expect(run.due).toBeGreaterThanOrEqual(1); // o banco é compartilhado: afirmo só sobre o NOSSO item
    expect((await txRow(refund.r.transactionId)).status).toBe('PROCESSED');
    expect(await balanceOf(w.id)).toBe('100.00');
  });
});