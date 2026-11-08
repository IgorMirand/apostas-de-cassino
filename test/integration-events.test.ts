import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged } from '../src/domain/events/wallet-balance-changed';
import { WagerTransactionProcessed } from '../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../src/domain/events/wager-transaction-rejected';
import type { EventContext } from '../src/domain/events/integration-event';
import { FailureCode } from '../src/domain/failure-code';
import { Wallet } from '../src/domain/wallet';
import { LedgerDirection } from '../src/domain/wallet-ledger-entry';
import { WagerTransactionKind as K } from '../src/domain/wager-transaction';
import { brl, makeTx, T0, T1 } from './support/builders';

const ctx = (over: Partial<EventContext> = {}): EventContext => ({
  eventId: 'evt-1', correlationId: 'corr-1', causationId: 'cause-1', occurredAt: T1, ...over,
});

describe('WalletBalanceChanged', () => {
  const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('100.00'), at: T0 });
  const entry = wallet.debit({ entryId: 'e-1', transactionId: 'tx-1', money: brl('30.00'), at: T1 });

  test('envelope completo, com tipo e versão fixados na CLASSE', () => {
    expect(WalletBalanceChanged.from(wallet, entry, ctx()).toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'w-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: '2026-11-05T12:00:01.000Z',
      version: 1,
      data: {
        walletId: 'w-1', transactionId: 'tx-1', direction: LedgerDirection.Debit,
        money: { amount: '30.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('o aggregateId é a wallet, e causationId ausente não vira chave', () => {
    const json = WalletBalanceChanged.from(wallet, entry, ctx({ causationId: undefined as never })).toJSON();
    expect(json.aggregateId).toBe('w-1');
    expect('causationId' in json).toBe(false);
  });

  test('o payload sobrevive a JSON.stringify/parse sem perder nada (é estável)', () => {
    const json = WalletBalanceChanged.from(wallet, entry, ctx()).toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('dinheiro no payload é SEMPRE string, nunca number', () => {
    const { data } = WalletBalanceChanged.from(wallet, entry, ctx()).toJSON();
    for (const m of [data.money, data.balanceBefore, data.balanceAfter]) {
      expect(typeof m.amount).toBe('string');
    }
  });
});

describe('WagerTransactionProcessed', () => {
  test('exige uma transação realmente processada', () => {
    expect(() => WagerTransactionProcessed.from(makeTx(), ctx())).toThrow();
  });

  test('carrega o saldo observado e o instante do processamento', () => {
    const tx = makeTx({ kind: K.Loss });
    tx.markProcessed(undefined, T1, brl('100.00'));
    const e = WagerTransactionProcessed.from(tx, ctx()).toJSON();
    expect(e.eventType).toBe('WagerTransactionProcessed');
    expect(e.aggregateId).toBe('w-1');
    expect(e.data).toMatchObject({
      transactionId: 'tx-1', kind: 'LOSS', balance: { amount: '100.00' }, processedAt: '2026-11-05T12:00:01.000Z',
      roundId: 'r-1', gameId: 'g-1',
    });
  });
});

describe('WagerTransactionRejected', () => {
  test('exige uma transação realmente rejeitada', () => {
    expect(() => WagerTransactionRejected.from(makeTx(), ctx())).toThrow();
  });

  test('carrega o failureCode e o saldo observado', () => {
    const tx = makeTx();
    tx.reject(FailureCode.InsufficientFunds, brl('20.00'));
    const e = WagerTransactionRejected.from(tx, ctx()).toJSON();
    expect(e.eventType).toBe('WagerTransactionRejected');
    expect(e.data).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '20.00' }, money: { amount: '80.00' } });
  });
});