import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infra/orm.config';
import { MikroOrmUnitOfWork, createRepositories } from '../src/infra/persistence/repositories';
import { WalletNotLockedError } from '../src/infra/persistence/errors';
import type { Repositories } from '../src/application/ports';
import { Wallet } from '../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind as K } from '../src/domain/wager-transaction';
import { FailureCode } from '../src/domain/failure-code';
import { InsufficientFundsError } from '../src/domain/errors';
import { assertBalanceMatchesLedger, countTransactions, db, ledgerOf } from './support/db';
import { brl } from './support/builders';

/**
 * Repositórios contra Postgres REAL, com concorrência REAL.
 * Pré-requisito: `docker compose up -d` e `bun run db:up`.
 */
let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
beforeAll(async () => {
  orm = await MikroORM.init(config);
  uow = new MikroOrmUnitOfWork(orm);
});
afterAll(async () => {
  await orm.close(); // NÃO feche `db`: o pool é compartilhado entre arquivos
});

// ------------------------------------------------------------------ helpers
const PROVIDER = 'prov-repo-test';

async function waitFor(condition: () => Promise<boolean>, what: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timeout (${timeoutMs}ms) waiting for: ${what}`);
}

/** Quantos backends estão BLOQUEADOS esperando um lock de linha, executando FOR UPDATE. */
async function blockedForUpdate(): Promise<number> {
  const rows = await db`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%for update%'`;
  return rows[0].n;
}

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

/** Cria wallet + OPENING + 1º lançamento numa transação (a mesma sequência do futuro POST /wallets). */
async function openWallet(initial: string) {
  const now = new Date();
  const wallet = Wallet.open({ id: randomUUID(), playerId: `player-${randomUUID()}`, initialBalance: brl(initial), at: now });
  await uow.run(async (r) => {
    await r.wallets.insert(wallet); // wallet ANTES do filho (FK)
    const opening = WagerTransaction.opening({ id: randomUUID(), walletId: wallet.id, playerId: wallet.playerId, money: brl(initial), createdAt: now });
    await r.transactions.insertIfAbsent(opening);
    await r.ledger.append(WalletLedgerEntry.create({
      id: randomUUID(), walletId: wallet.id, transactionId: opening.id, direction: LedgerDirection.Credit,
      money: brl(initial), balanceBefore: brl('0.00'), balanceAfter: brl(initial), createdAt: now,
    }));
  });
  return wallet;
}

function newBet(wallet: Wallet, over: { amount?: string; key?: string; externalId?: string; kind?: K.Bet | K.Refund; ref?: string } = {}) {
  const id = randomUUID();
  const kind = over.kind ?? K.Bet;
  return WagerTransaction.create({
    id, providerId: PROVIDER, externalTransactionId: over.externalId ?? `ext-${id}`,
    idempotencyKey: over.key ?? `${PROVIDER}:ext-${id}`, payloadHash: `h-${id}`,
    walletId: wallet.id, playerId: wallet.playerId, roundId: 'r-1', gameId: 'g-1', kind,
    money: brl(over.amount ?? '10.00'), referenceExternalTransactionId: over.ref, createdAt: new Date(),
  });
}

/**
 * Esqueleto do futuro use case de BET, na ORDEM CORRETA: travar a wallet ANTES de inserir a transação.
 * Rejeição de negócio é COMMIT de uma transação REJECTED (não exceção que desfaz tudo).
 */
async function placeBet(wallet: Wallet, amount: string): Promise<'PROCESSED' | 'REJECTED'> {
  return uow.run(async (r) => {
    const locked = await r.wallets.findByIdForUpdate(wallet.id);
    if (!locked) throw new Error('wallet not found');
    const tx = newBet(wallet, { amount });
    await r.transactions.insertIfAbsent(tx);
    const now = new Date();
    try {
      const entry = locked.debit({ entryId: randomUUID(), transactionId: tx.id, money: tx.money, at: now });
      tx.markProcessed(undefined, now);
      r.wallets.save(locked);
      await r.transactions.save(tx);
      await r.ledger.append(entry);
      return 'PROCESSED' as const;
    } catch (e) {
      if (!(e instanceof InsufficientFundsError)) throw e;
      tx.reject(FailureCode.InsufficientFunds);
      await r.transactions.save(tx);
      return 'REJECTED' as const;
    }
  });
}

// -------------------------------------------------------------------- testes
describe('lock pessimista (FOR UPDATE)', () => {
  test('a segunda transação realmente ESPERA a primeira e, ao obter o lock, enxerga o que ela gravou', async () => {
    const wallet = await openWallet('100.00');
    const events: string[] = [];
    const aHoldsLock = latch();
    const releaseA = latch();

    // A trava, DEBITA 10.00 (ainda sem commit) e segura a transação aberta
    const a = uow.run(async (r) => {
      const locked = (await r.wallets.findByIdForUpdate(wallet.id))!;
      locked.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('10.00'), at: new Date() });
      r.wallets.save(locked);
      events.push('A: travou e alterou o saldo');
      aHoldsLock.release();
      await releaseA.promise;
      events.push('A: vai dar commit');
    });

    await aHoldsLock.promise;
    const before = await blockedForUpdate();

    let seenByB: string | undefined;
    const b = uow.run(async (r) => {
      const locked = (await r.wallets.findByIdForUpdate(wallet.id))!;
      seenByB = locked.balance.toJSON().amount;
      events.push('B: travou');
    });

    // prova objetiva: o Postgres reporta um backend bloqueado esperando lock
    await waitFor(async () => (await blockedForUpdate()) > before, 'B bloqueado no FOR UPDATE');
    expect(events).toEqual(['A: travou e alterou o saldo']); // B ainda não passou
    expect(seenByB).toBeUndefined();

    releaseA.release();
    await Promise.all([a, b]);

    // B só pode ter travado DEPOIS de A decidir dar commit. (A ordem entre "A confirmou o commit"
    // e "B travou" NÃO é asserida: são dois sockets, e a chegada das respostas ao JS é uma corrida.)
    expect(events.indexOf('A: vai dar commit')).toBeLessThan(events.indexOf('B: travou'));
    // a garantia que importa: B viu o saldo JÁ DEBITADO por A (sem o lock leria 100.00)
    expect(seenByB).toBe('90.00');
  }, 15_000);

  test('DOCUMENTA O RISCO: inserir a transação (filho) já bloqueia o FOR UPDATE de outra transação', async () => {
    const wallet = await openWallet('100.00');
    const aInserted = latch();
    const releaseA = latch();

    // A só INSERE o filho (FK => FOR KEY SHARE na wallet) e segura a transação aberta
    const a = uow.run(async (r) => {
      await r.transactions.insertIfAbsent(newBet(wallet));
      aInserted.release();
      await releaseA.promise;
    });
    await aInserted.promise;

    let bDone = false;
    const before = await blockedForUpdate();
    const b = uow.run((r) => r.wallets.findByIdForUpdate(wallet.id)).then(() => (bDone = true));

    await waitFor(async () => (await blockedForUpdate()) > before, 'FOR UPDATE bloqueado por um INSERT filho');
    expect(bDone).toBe(false); // é por isso que a ordem é: travar PRIMEIRO, inserir depois

    releaseA.release();
    await Promise.all([a, b]);
    expect(bDone).toBe(true);
  }, 15_000);

  test('findByIdForUpdate fora de transação é recusado', async () => {
    const wallet = await openWallet('100.00');
    const outside = createRepositories(orm.em.fork()); // EntityManager SEM transação
    await expect(outside.wallets.findByIdForUpdate(wallet.id)).rejects.toThrow(/transaction/i);
  });

  test('save() exige que a wallet tenha sido travada nesta transação', async () => {
    const wallet = await openWallet('100.00');
    await uow.run(async (r) => {
      expect(() => r.wallets.save(wallet)).toThrow(WalletNotLockedError);
    });
  });
});

describe('débitos concorrentes na MESMA wallet', () => {
  test('saldo 100.00 e 20 apostas de 10.00 em paralelo: exatamente 10 passam, saldo 0.00, sem deadlock', async () => {
    const wallet = await openWallet('100.00');
    const results = await Promise.all(Array.from({ length: 20 }, () => placeBet(wallet, '10.00')));

    expect(results.filter((s) => s === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((s) => s === 'REJECTED')).toHaveLength(10);

    const after = await db`SELECT balance::text AS balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(after[0].balance).toBe('0.00');
    expect(after[0].version).toBe(11); // 1 inicial + 10 débitos
    expect((await ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(10);
    expect(await countTransactions(wallet.id, { kind: 'BET', status: 'REJECTED' })).toBe(10);
    await assertBalanceMatchesLedger(wallet.id);
  }, 30_000);

  test('a cadeia balanceBefore/balanceAfter do ledger é contínua (cada débito viu o saldo do anterior)', async () => {
    const wallet = await openWallet('100.00');
    await Promise.all(Array.from({ length: 10 }, () => placeBet(wallet, '10.00')));
    const debits = (await ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT');
    const befores = debits.map((e) => e.balance_before).sort();
    const afters = debits.map((e) => e.balance_after).sort();
    // se dois débitos tivessem lido o mesmo saldo, haveria balance_before repetido
    expect(new Set(befores).size).toBe(10);
    expect(new Set(afters).size).toBe(10);
  }, 30_000);
});

describe('insertIfAbsent (idempotência no banco)', () => {
  test('50 transações com a MESMA idempotency key: exatamente uma insere e todas enxergam o mesmo registro', async () => {
    const wallet = await openWallet('100.00');
    const key = `${PROVIDER}:${randomUUID()}`;
    const externalId = `ext-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        uow.run(async (r) => {
          const candidate = newBet(wallet, { key, externalId }); // id novo a cada tentativa
          const inserted = await r.transactions.insertIfAbsent(candidate);
          const found = await r.transactions.findByIdempotencyKey(PROVIDER, key);
          return { inserted, foundId: found?.id, candidateId: candidate.id };
        }),
      ),
    );

    const winners = results.filter((r) => r.inserted);
    expect(winners).toHaveLength(1);
    expect(new Set(results.map((r) => r.foundId)).size).toBe(1);
    expect(results[0]!.foundId).toBe(winners[0]!.candidateId);
    expect(await countTransactions(wallet.id, { kind: 'BET' })).toBe(1);
  }, 30_000);

  test('mesmo external id com OUTRA idempotency key: não insere, e dá para distinguir o caso', async () => {
    const wallet = await openWallet('100.00');
    const externalId = `ext-${randomUUID()}`;
    const first = newBet(wallet, { key: `${PROVIDER}:k1-${randomUUID()}`, externalId });
    const otherKey = `${PROVIDER}:k2-${randomUUID()}`;

    await uow.run(async (r) => {
      expect(await r.transactions.insertIfAbsent(first)).toBe(true);
    });
    await uow.run(async (r) => {
      const second = newBet(wallet, { key: otherKey, externalId });
      expect(await r.transactions.insertIfAbsent(second)).toBe(false);
      expect(await r.transactions.findByIdempotencyKey(PROVIDER, otherKey)).toBeNull(); // a chave é nova...
      expect((await r.transactions.findByExternalId(PROVIDER, externalId))?.id).toBe(first.id); // ...mas o id já existe
    });
  });
});

describe('atomicidade: tudo ou nada', () => {
  test('se algo falha depois de débito + ledger + transação, NADA fica persistido', async () => {
    const wallet = await openWallet('100.00');
    const tx = newBet(wallet, { amount: '80.00' });

    await expect(
      uow.run(async (r) => {
        const locked = (await r.wallets.findByIdForUpdate(wallet.id))!;
        await r.transactions.insertIfAbsent(tx);
        const now = new Date();
        const entry = locked.debit({ entryId: randomUUID(), transactionId: tx.id, money: tx.money, at: now });
        tx.markProcessed(undefined, now);
        r.wallets.save(locked);
        await r.transactions.save(tx);
        await r.ledger.append(entry);
        throw new Error('crash depois de tudo, antes do commit');
      }),
    ).rejects.toThrow('crash');

    const row = await db`SELECT balance::text AS balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(row[0].balance).toBe('100.00');
    expect(row[0].version).toBe(1);
    expect(await countTransactions(wallet.id, { kind: 'BET' })).toBe(0);
    expect((await ledgerOf(wallet.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(0);
    await assertBalanceMatchesLedger(wallet.id);
  });
});

describe('reversões', () => {
  async function processedBet(wallet: Wallet) {
    const bet = newBet(wallet, { amount: '80.00' });
    await uow.run(async (r) => {
      await r.transactions.insertIfAbsent(bet);
      bet.markProcessed(undefined, new Date());
      await r.transactions.save(bet);
    });
    return bet;
  }
  async function refund(wallet: Wallet, bet: WagerTransaction) {
    return uow.run(async (r) => {
      const rf = newBet(wallet, { kind: K.Refund, amount: '80.00', ref: bet.externalTransactionId });
      await r.transactions.insertIfAbsent(rf); // entra PENDING
      rf.markProcessed(bet.id, new Date());
      await r.transactions.save(rf);
      return rf;
    });
  }

  test('findProcessedReversalOf acha a reversão já processada, e só ela', async () => {
    const wallet = await openWallet('100.00');
    const bet = await processedBet(wallet);
    await uow.run(async (r) => expect(await r.transactions.findProcessedReversalOf(bet.id)).toBeNull());

    const rf = await refund(wallet, bet);
    await uow.run(async (r) => expect((await r.transactions.findProcessedReversalOf(bet.id))?.id).toBe(rf.id));
  });

  test('BACKSTOP: uma 2ª reversão da mesma BET é barrada pelo banco (wt_single_reversal_uq) e nada persiste', async () => {
    const wallet = await openWallet('100.00');
    const bet = await processedBet(wallet);
    await refund(wallet, bet);

    await expect(refund(wallet, bet)).rejects.toThrow(/wt_single_reversal_uq/);
    expect(await countTransactions(wallet.id, { kind: 'REFUND', status: 'PROCESSED' })).toBe(1);
    expect(await countTransactions(wallet.id, { kind: 'REFUND' })).toBe(1); // a 2ª foi desfeita por inteiro
  });
});