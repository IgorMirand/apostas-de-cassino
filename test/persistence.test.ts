import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infra/orm.config';
import { Wallet } from '../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';
import {
  WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S,
} from '../src/domain/wager-transaction';
import { FailureCode } from '../src/domain/failure-code';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from '../src/infra/persistence/records';
import {
  applyTransactionToRecord, applyWalletToRecord, ledgerEntryToDomain, ledgerEntryToNewRecord,
  transactionToDomain, transactionToNewRecord, walletToDomain, walletToNewRecord,
} from '../src/infra/persistence/mappers';
import { db } from './support/db';
import { brl, T0, T1 } from './support/builders';

/**
 * Round-trip contra Postgres REAL: domínio → registro → banco → registro → domínio.
 * Pré-requisito: `docker compose up -d` e `bun run db:up`.
 */
let orm: MikroORM;
beforeAll(async () => { orm = await MikroORM.init(config); });
afterAll(async () => { await orm.close(); }); // NÃO feche `db`: o pool é compartilhado entre arquivos

const fresh = () => orm.em.fork(); // EntityManager limpo = nenhum Identity Map reaproveitado

async function saveWallet(initial: string) {
  const wallet = Wallet.open({ id: randomUUID(), playerId: `player-${randomUUID()}`, initialBalance: brl(initial), at: T0 });
  const em = fresh();
  em.persist(walletToNewRecord(wallet));
  await em.flush();
  return wallet;
}

describe('Money na persistência: exato, sem number no caminho', () => {
  test('um valor que o float64 NÃO representa sobrevive ao ciclo completo', async () => {
    const huge = '12345678901234567.89'; // 19 dígitos significativos: float64 não segura
    expect(Number(huge).toFixed(2)).not.toBe(huge); // prova de que o teste teria pegado um number

    const wallet = await saveWallet(huge);

    const record = await fresh().findOneOrFail(WalletRecord, { id: wallet.id });
    expect(typeof record.balance).toBe('string');
    expect(record.balance).toBe(huge);
    expect(walletToDomain(record).balance.toJSON().amount).toBe(huge);

    // e no próprio banco, como texto
    const rows = await db`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(rows[0].balance).toBe(huge);
  });

  test('0.10 + 0.20 persistido continua 0.30 (nada de 0.30000000000000004)', async () => {
    const wallet = await saveWallet('0.10');
    const em = fresh();
    const record = await em.findOneOrFail(WalletRecord, { id: wallet.id });
    const domain = walletToDomain(record);
    domain.credit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('0.20'), at: T1 });
    applyWalletToRecord(domain, record);
    await em.flush();

    const reloaded = await fresh().findOneOrFail(WalletRecord, { id: wallet.id });
    expect(reloaded.balance).toBe('0.30');
  });
});

describe('Wallet', () => {
  test('round-trip preserva todos os campos', async () => {
    const wallet = await saveWallet('1000.00');
    const loaded = walletToDomain(await fresh().findOneOrFail(WalletRecord, { id: wallet.id }));
    expect(loaded.id).toBe(wallet.id);
    expect(loaded.playerId).toBe(wallet.playerId);
    expect(loaded.currency).toBe('BRL');
    expect(loaded.balance.equals(wallet.balance)).toBe(true);
    expect(loaded.version).toBe(1);
    expect(loaded.createdAt.getTime()).toBe(T0.getTime());
  });

  test('aplicar uma movimentação atualiza saldo, version e updatedAt', async () => {
    const wallet = await saveWallet('100.00');
    const em = fresh();
    const record = await em.findOneOrFail(WalletRecord, { id: wallet.id });
    const domain = walletToDomain(record);
    domain.debit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl('80.00'), at: T1 });
    applyWalletToRecord(domain, record);
    await em.flush();

    const after = walletToDomain(await fresh().findOneOrFail(WalletRecord, { id: wallet.id }));
    expect(after.balance.toJSON().amount).toBe('20.00');
    expect(after.version).toBe(2);
    expect(after.updatedAt.getTime()).toBe(T1.getTime());
  });
});

describe('WagerTransaction', () => {
  async function save(tx: WagerTransaction) {
    const em = fresh();
    em.persist(transactionToNewRecord(tx));
    await em.flush();
  }
  const load = async (id: string) =>
    transactionToDomain(await fresh().findOneOrFail(WagerTransactionRecord, { id }));
  const newTx = (walletId: string, playerId: string, kind: K.Bet | K.Refund | K.Win = K.Bet) => {
    const id = randomUUID();
    return WagerTransaction.create({
      id, providerId: 'prov', externalTransactionId: `ext-${id}`, idempotencyKey: `prov:ext-${id}`,
      payloadHash: `h-${id}`, walletId, playerId, roundId: 'r-1', gameId: 'g-1', kind,
      money: brl('80.00'), referenceExternalTransactionId: kind === K.Refund ? `ext-bet` : undefined, createdAt: T0,
    });
  };

  test('PENDING: opcionais ausentes voltam como undefined (null do banco ⇄ undefined do domínio)', async () => {
    const w = await saveWallet('100.00');
    const tx = newTx(w.id, w.playerId);
    await save(tx);
    const loaded = await load(tx.id);
    expect(loaded.status).toBe(S.Pending);
    expect(loaded.referenceTransactionId).toBeUndefined();
    expect(loaded.failureCode).toBeUndefined();
    expect(loaded.processedAt).toBeUndefined();
    expect(loaded.referenceExternalTransactionId).toBeUndefined();
    expect(loaded.money.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(loaded.roundId).toBe('r-1');
  });

  test('REJECTED guarda failureCode; transição aplicada sobre registro existente', async () => {
    const w = await saveWallet('100.00');
    const tx = newTx(w.id, w.playerId);
    await save(tx);

    const em = fresh();
    const record = await em.findOneOrFail(WagerTransactionRecord, { id: tx.id });
    const domain = transactionToDomain(record);
    domain.reject(FailureCode.InsufficientFunds);
    applyTransactionToRecord(domain, record);
    await em.flush();

    const loaded = await load(tx.id);
    expect(loaded.status).toBe(S.Rejected);
    expect(loaded.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(loaded.processedAt).toBeUndefined();
    expect(loaded.isTerminal()).toBe(true);
  });

  test('PENDING_REFERENCE guarda tentativas e próxima tentativa', async () => {
    const w = await saveWallet('100.00');
    const tx = newTx(w.id, w.playerId, K.Refund);
    tx.markPendingReference(T1);
    await save(tx);
    const loaded = await load(tx.id);
    expect(loaded.status).toBe(S.PendingReference);
    expect(loaded.pendingAttempts).toBe(1);
    expect(loaded.pendingNextAttemptAt?.getTime()).toBe(T1.getTime());
    expect(loaded.referenceExternalTransactionId).toBe('ext-bet');
  });

  test('PROCESSED guarda processedAt', async () => {
    const w = await saveWallet('100.00');
    const tx = newTx(w.id, w.playerId);
    tx.markProcessed(undefined, T1);
    await save(tx);
    const loaded = await load(tx.id);
    expect(loaded.status).toBe(S.Processed);
    expect(loaded.processedAt?.getTime()).toBe(T1.getTime());
  });

  test('saldo observado faz round-trip exato, inclusive com moeda diferente da transação', async () => {
    const w = await saveWallet('100.00');
    const tx = newTx(w.id, w.playerId);
    tx.reject(FailureCode.CurrencyMismatch, brl('12345678901234567.89'));
    await save(tx);
    const loaded = await load(tx.id);
    expect(loaded.observedBalance?.toJSON()).toEqual({ amount: '12345678901234567.89', currency: 'BRL' });

    const pending = newTx(w.id, w.playerId); // sem saldo observado: volta undefined
    await save(pending);
    expect((await load(pending.id)).observedBalance).toBeUndefined();
  });

  test('OPENING: sem rodada nem jogo (colunas NULL) persiste e volta', async () => {
    const w = await saveWallet('100.00');
    const opening = WagerTransaction.opening({ id: randomUUID(), walletId: w.id, playerId: w.playerId, money: brl('100.00'), createdAt: T0 });
    await save(opening);
    const loaded = await load(opening.id);
    expect(loaded.kind).toBe(K.Opening);
    expect(loaded.roundId).toBeUndefined();
    expect(loaded.gameId).toBeUndefined();
    expect(loaded.status).toBe(S.Processed);
  });

  test('as constraints do banco continuam valendo através do ORM (REFUND sem referência é barrado)', async () => {
    const w = await saveWallet('100.00');
    const bad = transactionToNewRecord(newTx(w.id, w.playerId));
    bad.kind = 'REFUND'; // burla o domínio de propósito: quem barra agora é o banco
    const em = fresh();
    em.persist(bad);
    await expect(em.flush()).rejects.toThrow(/wt_reference_by_kind/);
  });
});

describe('WalletLedgerEntry', () => {
  async function setup() {
    const w = await saveWallet('100.00');
    const opening = WagerTransaction.opening({ id: randomUUID(), walletId: w.id, playerId: w.playerId, money: brl('100.00'), createdAt: T0 });
    const em = fresh();
    em.persist(transactionToNewRecord(opening));
    await em.flush();
    const domain = Wallet.rehydrate({ id: w.id, playerId: w.playerId, currency: 'BRL', balance: brl('100.00'), version: 1, createdAt: T0, updatedAt: T0 });
    const entry = domain.debit({ entryId: randomUUID(), transactionId: opening.id, money: brl('80.00'), at: T1 });
    const em2 = fresh();
    em2.persist(ledgerEntryToNewRecord(entry));
    await em2.flush();
    return { entry };
  }

  test('round-trip preserva direção, valores e a aritmética (isBalanced)', async () => {
    const { entry } = await setup();
    const loaded = ledgerEntryToDomain(await fresh().findOneOrFail(WalletLedgerEntryRecord, { id: entry.id }));
    expect(loaded.direction).toBe(LedgerDirection.Debit);
    expect(loaded.money.toJSON().amount).toBe('80.00');
    expect(loaded.balanceBefore.toJSON().amount).toBe('100.00');
    expect(loaded.balanceAfter.toJSON().amount).toBe('20.00');
    expect(loaded.isBalanced()).toBe(true);
  });

  test('o ORM não gera UPDATE espúrio: carregar e dar flush sem mudar nada NÃO dispara o trigger', async () => {
    const { entry } = await setup();
    const em = fresh();
    await em.findOneOrFail(WalletLedgerEntryRecord, { id: entry.id });
    await expect(em.flush()).resolves.toBeUndefined();
  });

  test('alterar um lançamento pelo ORM é barrado pelo trigger (append-only)', async () => {
    const { entry } = await setup();
    const em = fresh();
    const record = await em.findOneOrFail(WalletLedgerEntryRecord, { id: entry.id });
    record.balanceAfter = '999.00';
    await expect(em.flush()).rejects.toThrow(/append-only/);
  });

  test('apagar um lançamento pelo ORM é barrado pelo trigger', async () => {
    const { entry } = await setup();
    const em = fresh();
    const record = await em.findOneOrFail(WalletLedgerEntryRecord, { id: entry.id });
    em.remove(record);
    await expect(em.flush()).rejects.toThrow(/append-only/);
  });
});