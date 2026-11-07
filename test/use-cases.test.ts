import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infra/orm.config';
import { MikroOrmUnitOfWork } from '../src/infra/persistence/repositories';
import { SystemClock, UuidV7Generator } from '../src/infra/system';
import { CreateWalletUseCase, type WalletView } from '../src/application/create-wallet.use-case';
import { GetWalletUseCase } from '../src/application/get-wallet.use-case';
import {
  ProcessWagerTransactionUseCase, type TransactionResult,
} from '../src/application/process-wager-transaction.use-case';
import type { SubmitTransactionCommand } from '../src/application/commands';
import {
  IdempotencyConflictError, UnsupportedTransactionKindError, WalletAlreadyExistsError, WalletNotFoundError,
} from '../src/application/errors';
import { Money } from '../src/domain/money';
import { FailureCode } from '../src/domain/failure-code';
import { WagerTransactionKind as K, WagerTransactionStatus as S, type SubmittableKind } from '../src/domain/wager-transaction';
import { assertBalanceMatchesLedger, countTransactions, db, ledgerOf } from './support/db';

/**
 * Use cases contra Postgres REAL, com concorrência REAL.
 * Pré-requisito: `docker compose up -d` e `bun run db:up`.
 */
let orm: MikroORM;
let createWallet: CreateWalletUseCase;
let getWallet: GetWalletUseCase;
let processTx: ProcessWagerTransactionUseCase;
const touched: string[] = [];

beforeAll(async () => {
  orm = await MikroORM.init(config);
  const uow = new MikroOrmUnitOfWork(orm);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  createWallet = new CreateWalletUseCase(uow, clock, ids);
  getWallet = new GetWalletUseCase(uow);
  processTx = new ProcessWagerTransactionUseCase(uow, clock, ids);
});
afterAll(async () => { await orm.close(); }); // NÃO feche `db`: o pool é compartilhado entre arquivos

// rede de segurança: TODO teste termina com saldo == soma do ledger, verificado direto no banco
afterEach(async () => {
  for (const id of touched.splice(0)) await assertBalanceMatchesLedger(id);
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

async function newWallet(initial = '100.00'): Promise<WalletView> {
  const wallet = await createWallet.execute({ playerId: `player-${randomUUID()}`, initialBalance: brl(initial) });
  touched.push(wallet.id);
  return wallet;
}

interface CmdOver {
  amount?: string; currency?: string; kind?: SubmittableKind; key?: string; externalId?: string; playerId?: string;
}
function cmd(w: WalletView, o: CmdOver = {}): SubmitTransactionCommand {
  const externalId = o.externalId ?? `ext-${randomUUID()}`;
  return {
    providerId: 'prov-uc', externalTransactionId: externalId, idempotencyKey: o.key ?? `prov-uc:${externalId}`,
    playerId: o.playerId ?? w.playerId, walletId: w.id, roundId: 'r-1', gameId: 'g-1', kind: o.kind ?? K.Bet,
    money: Money.from({ amount: o.amount ?? '10.00', currency: o.currency ?? 'BRL' }),
  };
}
const balanceOf = async (w: WalletView) => (await getWallet.execute(w.id)).balance.amount;
const debits = async (w: WalletView) => (await ledgerOf(w.id)).filter((e) => e.direction === 'DEBIT');

describe('CreateWallet', () => {
  test('cria wallet, transação OPENING e o primeiro lançamento, juntos', async () => {
    const w = await newWallet('1000.00');
    expect(w.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(w.version).toBe(1);

    expect(await countTransactions(w.id, { kind: 'OPENING', status: 'PROCESSED' })).toBe(1);
    const ledger = await ledgerOf(w.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00' });
  });

  test('saldo inicial zero: sem OPENING e sem lançamento', async () => {
    const w = await newWallet('0.00');
    expect(w.balance.amount).toBe('0.00');
    expect(await countTransactions(w.id, {})).toBe(0);
    expect(await ledgerOf(w.id)).toHaveLength(0);
  });

  test('wallet duplicada (mesmo player e moeda) é WalletAlreadyExistsError e não cria nada', async () => {
    const playerId = `player-${randomUUID()}`;
    const first = await createWallet.execute({ playerId, initialBalance: brl('50.00') });
    touched.push(first.id);
    await expect(createWallet.execute({ playerId, initialBalance: brl('70.00') })).rejects.toThrow(WalletAlreadyExistsError);

    const rows = await db`SELECT count(*)::int AS n FROM wallets WHERE player_id = ${playerId}`;
    expect(rows[0].n).toBe(1);
    expect(await balanceOf(first)).toBe('50.00');
  });

  test('o mesmo jogador pode ter wallets em moedas diferentes', async () => {
    const playerId = `player-${randomUUID()}`;
    const a = await createWallet.execute({ playerId, initialBalance: brl('10.00') });
    const b = await createWallet.execute({ playerId, initialBalance: Money.from({ amount: '10.00', currency: 'USD' }) });
    touched.push(a.id, b.id);
    expect(a.id).not.toBe(b.id);
  });

  test('10 criações simultâneas do MESMO jogador: exatamente uma vence e nada fica pela metade', async () => {
    const playerId = `player-${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => createWallet.execute({ playerId, initialBalance: brl('100.00') })),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<WalletView> => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(9);
    expect(failed.every((f) => f.reason instanceof WalletAlreadyExistsError)).toBe(true);

    touched.push(ok[0]!.value.id);
    expect(await ledgerOf(ok[0]!.value.id)).toHaveLength(1);
    const wallets = await db`SELECT count(*)::int AS n FROM wallets WHERE player_id = ${playerId}`;
    expect(wallets[0].n).toBe(1);
  }, 30_000);
});

describe('GetWallet', () => {
  test('wallet inexistente é WalletNotFoundError', async () => {
    await expect(getWallet.execute(randomUUID())).rejects.toThrow(WalletNotFoundError);
  });
});

describe('ProcessWagerTransaction: regras de negócio', () => {
  test('BET debita, gera lançamento DEBIT e devolve PROCESSED com o saldo novo', async () => {
    const w = await newWallet('100.00');
    const r = await processTx.execute(cmd(w, { amount: '30.00' }));

    expect(r).toMatchObject({ status: S.Processed, balance: { amount: '70.00', currency: 'BRL' }, idempotentReplay: false });
    expect(r.failureCode).toBeUndefined();
    expect(await balanceOf(w)).toBe('70.00');
    expect((await getWallet.execute(w.id)).version).toBe(2);
    expect(await debits(w)).toHaveLength(1);
  });

  test('WIN credita e gera lançamento CREDIT', async () => {
    const w = await newWallet('100.00');
    const r = await processTx.execute(cmd(w, { kind: K.Win, amount: '25.50' }));
    expect(r.status).toBe(S.Processed);
    expect(r.balance.amount).toBe('125.50');
    expect(await ledgerOf(w.id)).toHaveLength(2);
  });

  test('LOSS só registra: saldo, version e ledger ficam como estavam', async () => {
    const w = await newWallet('100.00');
    const r = await processTx.execute(cmd(w, { kind: K.Loss, amount: '30.00' }));
    expect(r).toMatchObject({ status: S.Processed, balance: { amount: '100.00' } });
    expect(await balanceOf(w)).toBe('100.00');
    expect((await getWallet.execute(w.id)).version).toBe(1);
    expect(await ledgerOf(w.id)).toHaveLength(1); // só o OPENING
    expect(await countTransactions(w.id, { kind: 'LOSS', status: 'PROCESSED' })).toBe(1);
  });

  test('saldo insuficiente: REJECTED é COMMITADA (auditável), sem lançamento e sem tocar na wallet', async () => {
    const w = await newWallet('20.00');
    const r = await processTx.execute(cmd(w, { amount: '80.00' }));

    expect(r).toMatchObject({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds, balance: { amount: '20.00' } });
    expect(await balanceOf(w)).toBe('20.00');
    expect((await getWallet.execute(w.id)).version).toBe(1);
    expect(await debits(w)).toHaveLength(0);
    expect(await countTransactions(w.id, { kind: 'BET', status: 'REJECTED' })).toBe(1);
  });

  test('BET exatamente igual ao saldo é aceita e zera a wallet', async () => {
    const w = await newWallet('80.00');
    expect((await processTx.execute(cmd(w, { amount: '80.00' }))).balance.amount).toBe('0.00');
  });

  test('jogador diferente do dono da wallet: REJECTED com WALLET_PLAYER_MISMATCH', async () => {
    const w = await newWallet('100.00');
    const r = await processTx.execute(cmd(w, { playerId: 'outro-jogador' }));
    expect(r).toMatchObject({ status: S.Rejected, failureCode: FailureCode.WalletPlayerMismatch, balance: { amount: '100.00' } });
    expect(await balanceOf(w)).toBe('100.00');
  });

  test('moeda diferente da wallet: REJECTED com CURRENCY_MISMATCH, e o saldo observado vem na moeda da WALLET', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { currency: 'USD', amount: '10.00' });
    const r = await processTx.execute(c);
    expect(r).toMatchObject({ status: S.Rejected, failureCode: FailureCode.CurrencyMismatch, balance: { amount: '100.00', currency: 'BRL' } });

    const replay = await processTx.execute(c);
    expect(replay.balance).toEqual({ amount: '100.00', currency: 'BRL' }); // continua BRL no replay
  });

  test('wallet inexistente: WalletNotFoundError e nada é registrado', async () => {
    const ghost: WalletView = { id: randomUUID(), playerId: 'p', balance: { amount: '0.00', currency: 'BRL' }, version: 1 };
    const c = cmd(ghost);
    await expect(processTx.execute(c)).rejects.toThrow(WalletNotFoundError);
    const rows = await db`SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ${c.idempotencyKey}`;
    expect(rows[0].n).toBe(0);
  });

  test('REFUND e ROLLBACK ainda não são suportados (erro claro, nada persistido)', async () => {
    const w = await newWallet('100.00');
    for (const kind of [K.Refund, K.Rollback] as const) {
      const c = { ...cmd(w, { kind }), referenceExternalTransactionId: 'ext-qualquer' };
      await expect(processTx.execute(c)).rejects.toThrow(UnsupportedTransactionKindError);
    }
    expect(await countTransactions(w.id, { kind: 'REFUND' })).toBe(0);
  });
});

describe('ProcessWagerTransaction: idempotência', () => {
  test('o replay devolve o MESMO resultado, marcado como replay, sem debitar de novo', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { amount: '30.00' });
    const first = await processTx.execute(c);
    const again = await processTx.execute(c);

    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(await balanceOf(w)).toBe('70.00');
    expect(await debits(w)).toHaveLength(1);
  });

  test('o replay devolve o saldo DA ÉPOCA, não o saldo atual', async () => {
    const w = await newWallet('100.00');
    const first = cmd(w, { amount: '30.00' });
    expect((await processTx.execute(first)).balance.amount).toBe('70.00');
    await processTx.execute(cmd(w, { amount: '20.00' })); // saldo atual agora é 50.00
    expect(await balanceOf(w)).toBe('50.00');

    const replay = await processTx.execute(first);
    expect(replay.balance.amount).toBe('70.00'); // o da época
    expect(replay.idempotentReplay).toBe(true);
  });

  test('replay de uma REJEITADA devolve a mesma rejeição e o saldo da época', async () => {
    const w = await newWallet('20.00');
    const c = cmd(w, { amount: '80.00' });
    const first = await processTx.execute(c);
    await processTx.execute(cmd(w, { kind: K.Win, amount: '500.00' })); // agora o saldo é 520.00 e a BET passaria

    const replay = await processTx.execute(c);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay).toMatchObject({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds, balance: { amount: '20.00' } });
    expect(await debits(w)).toHaveLength(0); // não "ressuscitou" a aposta
  });

  test('replay de LOSS devolve o saldo da época', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { kind: K.Loss, amount: '10.00' });
    await processTx.execute(c);
    await processTx.execute(cmd(w, { amount: '40.00' }));
    expect((await processTx.execute(c)).balance.amount).toBe('100.00');
  });

  test('"25" e "25.00" com a mesma chave são o MESMO payload (replay, não conflito)', async () => {
    const w = await newWallet('100.00');
    const base = cmd(w, { amount: '25.00' });
    await processTx.execute(base);
    const again = await processTx.execute({ ...base, money: Money.from({ amount: '25', currency: 'BRL' }) });
    expect(again.idempotentReplay).toBe(true);
    expect(await balanceOf(w)).toBe('75.00');
  });

  test('mesma Idempotency-Key com payload diferente é CONFLITO e não mexe no dinheiro', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { amount: '25.00' });
    await processTx.execute(c);
    await expect(processTx.execute({ ...c, money: brl('30.00') })).rejects.toThrow(IdempotencyConflictError);
    expect(await balanceOf(w)).toBe('75.00');
    expect(await debits(w)).toHaveLength(1);
  });

  test('mesmo externalTransactionId com OUTRA Idempotency-Key é CONFLITO', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { amount: '25.00' });
    await processTx.execute(c);
    await expect(processTx.execute({ ...c, idempotencyKey: `outra-${randomUUID()}` })).rejects.toThrow(IdempotencyConflictError);
    expect(await balanceOf(w)).toBe('75.00');
  });

  test('a mesma chave em PROVEDORES diferentes são requisições independentes', async () => {
    const w = await newWallet('100.00');
    // valores ÚNICOS por execução: o ledger é imutável, então o banco acumula dados entre rodadas
    const c = cmd(w, { amount: '10.00', key: `chave-${randomUUID()}`, externalId: `ext-${randomUUID()}` });
    await processTx.execute(c);
    const other = await processTx.execute({ ...c, providerId: `outro-provedor-${randomUUID()}` });
    expect(other.idempotentReplay).toBe(false);
    expect(await balanceOf(w)).toBe('80.00');
  });
});

describe('ProcessWagerTransaction: concorrência', () => {
  test('saldo 100.00, duas BETs de 80.00 simultâneas: uma passa e a outra é rejeitada', async () => {
    const w = await newWallet('100.00');
    const results = await Promise.all([processTx.execute(cmd(w, { amount: '80.00' })), processTx.execute(cmd(w, { amount: '80.00' }))]);

    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === S.Rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await balanceOf(w)).toBe('20.00');
    expect(await debits(w)).toHaveLength(1);
    expect(await countTransactions(w.id, { kind: 'BET', status: 'REJECTED' })).toBe(1);
  }, 30_000);

  test('20 BETs de 10.00 distintas em paralelo: exatamente 10 passam, saldo 0.00, sem deadlock', async () => {
    const w = await newWallet('100.00');
    const results = await Promise.all(Array.from({ length: 20 }, () => processTx.execute(cmd(w, { amount: '10.00' }))));
    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(10);
    expect(results.filter((r) => r.status === S.Rejected)).toHaveLength(10);
    expect(await balanceOf(w)).toBe('0.00');
    expect(await debits(w)).toHaveLength(10);
  }, 30_000);

  test('50 requisições IDÊNTICAS em paralelo: um único débito, 49 replays, todos veem o mesmo resultado', async () => {
    const w = await newWallet('100.00');
    const c = cmd(w, { amount: '25.00' });
    const results: TransactionResult[] = await Promise.all(Array.from({ length: 50 }, () => processTx.execute(c)));

    expect(results.every((r) => r.status === S.Processed)).toBe(true);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.balance.amount))).toEqual(new Set(['75.00']));
    expect(await debits(w)).toHaveLength(1);
    expect(await countTransactions(w.id, { kind: 'BET' })).toBe(1);
  }, 30_000);

  test('mix concorrente de BET e WIN na mesma wallet mantém saldo == ledger', async () => {
    const w = await newWallet('100.00');
    const ops = Array.from({ length: 30 }, (_, i) =>
      processTx.execute(i % 3 === 0 ? cmd(w, { kind: K.Win, amount: '5.00' }) : cmd(w, { amount: '7.00' })),
    );
    await Promise.all(ops);
    // a invariante é verificada pelo afterEach direto no banco; aqui garantimos que nunca ficou negativo
    expect(Number(await balanceOf(w))).toBeGreaterThanOrEqual(0);
  }, 30_000);
});