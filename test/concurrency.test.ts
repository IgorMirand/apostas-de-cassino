import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startApp, type TestApp } from './support/app';
import { ApiClient, PROVIDER_ID, type ApiResult } from './support/api';
import { FailureCode, HttpStatus } from './support/contract';
import {
  assertBalanceMatchesLedger,
  countTransactions,
  ledgerOf,
} from './support/db';

/**
 * Testes de concorrência contra Postgres REAL e a aplicação REAL (sem mocks).
 * Pré-requisito: `docker compose up -d` e `bun run db:up`.
 *
 * Cada teste cria seu próprio jogador/wallet, então não há limpeza de dados
 * (o ledger é imutável: nem TRUNCATE nem DELETE são possíveis, de propósito).
 */
let app: TestApp;
let api: ApiClient;
const touchedWallets: string[] = [];

beforeAll(async () => {
  app = await startApp();
  api = new ApiClient(app.baseUrl);
});

afterAll(async () => {
  await app?.close();
});

// Rede de segurança: TODO teste termina checando saldo == soma do ledger.
afterEach(async () => {
  for (const walletId of touchedWallets.splice(0)) {
    await assertBalanceMatchesLedger(walletId);
  }
});

async function newWallet(initial: string) {
  const wallet = await api.createWallet(initial);
  touchedWallets.push(wallet.walletId);
  return wallet;
}

const byStatus = (results: ApiResult[], status: string) =>
  results.filter((r) => r.body?.status === status);

describe('cenário obrigatório do README: duas apostas disputando o mesmo saldo', () => {
  test('saldo 100.00, duas BETs de 80.00 simultâneas: uma passa, outra é rejeitada', async () => {
    const { walletId, playerId } = await newWallet('100.00');

    const results = await Promise.all([
      api.submit({ walletId, playerId, amount: '80.00' }),
      api.submit({ walletId, playerId, amount: '80.00' }),
    ]);

    expect(byStatus(results, 'PROCESSED')).toHaveLength(1);
    const rejected = byStatus(results, 'REJECTED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.body.failureCode).toBe(FailureCode.InsufficientFunds);

    // saldo final 20.00
    const wallet = await api.getWallet(walletId);
    expect(wallet.body.balance.amount).toBe('20.00');

    // exatamente UM débito (mais o crédito OPENING do saldo inicial)
    const ledger = await ledgerOf(walletId);
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect(ledger).toHaveLength(2);

    // a rejeitada continua auditável: foi COMMITADA como REJECTED, não desfeita
    expect(await countTransactions(walletId, { kind: 'BET', status: 'REJECTED' })).toBe(1);
    expect(await countTransactions(walletId, { kind: 'BET', status: 'PROCESSED' })).toBe(1);
  }, 30_000);
});

describe('carteira quente: muitas apostas distintas na mesma wallet', () => {
  test('saldo 100.00, 20 BETs de 10.00 em paralelo: exatamente 10 passam e o saldo zera', async () => {
    const { walletId, playerId } = await newWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 20 }, () => api.submit({ walletId, playerId, amount: '10.00' })),
    );

    expect(byStatus(results, 'PROCESSED')).toHaveLength(10);
    expect(byStatus(results, 'REJECTED')).toHaveLength(10);

    const wallet = await api.getWallet(walletId);
    expect(wallet.body.balance.amount).toBe('0.00'); // nunca negativo

    const ledger = await ledgerOf(walletId);
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(10);
  }, 30_000);
});

describe('idempotência sob concorrência', () => {
  test('50 requisições IDÊNTICAS em paralelo geram um único débito', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const externalTransactionId = `txn-${randomUUID()}`;
    const idempotencyKey = `${PROVIDER_ID}:${externalTransactionId}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        api.submit({ walletId, playerId, amount: '25.00', externalTransactionId, idempotencyKey }),
      ),
    );

    // todas respondem sucesso, todas apontam para a MESMA transação
    expect(results.every((r) => r.http < 300)).toBe(true);
    expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);

    // exatamente um processamento "de verdade"; os outros 49 são replays
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);

    // todos veem o mesmo resultado original
    expect(new Set(results.map((r) => r.body.balance.amount))).toEqual(new Set(['75.00']));

    // no banco: um débito, uma transação
    const ledger = await ledgerOf(walletId);
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    expect(await countTransactions(walletId, { kind: 'BET' })).toBe(1);

    const wallet = await api.getWallet(walletId);
    expect(wallet.body.balance.amount).toBe('75.00');
  }, 30_000);

  test('mesma Idempotency-Key com payload diferente é CONFLITO, não replay', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const externalTransactionId = `txn-${randomUUID()}`;
    const idempotencyKey = `${PROVIDER_ID}:${externalTransactionId}`;

    const first = await api.submit({ walletId, playerId, amount: '25.00', externalTransactionId, idempotencyKey });
    expect(first.body.status).toBe('PROCESSED');

    const second = await api.submit({ walletId, playerId, amount: '30.00', externalTransactionId, idempotencyKey });
    expect(second.http).toBe(HttpStatus.IdempotencyConflict);
    expect(second.body.idempotentReplay).not.toBe(true);

    // o conflito não mexeu no dinheiro
    const wallet = await api.getWallet(walletId);
    expect(wallet.body.balance.amount).toBe('75.00');
    expect((await ledgerOf(walletId)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  }, 30_000);
});