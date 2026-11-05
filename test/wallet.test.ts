import { describe, expect, test } from 'bun:test';
import { Wallet } from '../src/domain/wallet';
import { LedgerDirection } from '../src/domain/wallet-ledger-entry';
import {
  CurrencyMismatchError, InsufficientFundsError, InvalidMovementError, InvalidMoneyError,
} from '../src/domain/errors';
import { brl, usd, T0, T1 } from './support/builders';

const open = (initial = '100.00') =>
  Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(initial), at: T0 });

const move = (amount: string, id = 'e-1') => ({
  entryId: id, transactionId: 'tx-1', money: brl(amount), at: T1,
});

describe('Wallet.open', () => {
  test('nasce com o saldo inicial, version 1 e a moeda do saldo', () => {
    const w = open('1000.00');
    expect(w.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(w.version).toBe(1);
    expect(w.currency).toBe('BRL');
    expect(w.createdAt).toBe(T0);
    expect(w.updatedAt).toBe(T0);
  });

  test('aceita saldo inicial zero', () => {
    expect(open('0.00').balance.isZero()).toBe(true);
  });

  test('rejeita saldo inicial negativo', () => {
    const negative = brl('1.00').subtract(brl('5.00'));
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: negative, at: T0 })).toThrow(InvalidMoneyError);
  });
});

describe('Wallet.debit / credit', () => {
  test('debit reduz o saldo, sobe a version e devolve o lançamento correspondente', () => {
    const w = open('100.00');
    const entry = w.debit(move('80.00'));

    expect(w.balance.toJSON().amount).toBe('20.00');
    expect(w.version).toBe(2);
    expect(w.updatedAt).toBe(T1);

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('w-1');
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit aumenta o saldo e devolve um lançamento CREDIT', () => {
    const w = open('20.00');
    const entry = w.credit(move('80.00'));
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('débito exatamente igual ao saldo é permitido e zera a wallet', () => {
    const w = open('80.00');
    w.debit(move('80.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente lança erro e NÃO altera saldo, version nem updatedAt', () => {
    const w = open('100.00');
    expect(() => w.debit(move('100.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.version).toBe(1);
    expect(w.updatedAt).toBe(T0);
  });

  test('moeda diferente da wallet é erro de domínio e não altera nada', () => {
    const w = open('100.00');
    const usdMove = { entryId: 'e', transactionId: 't', money: usd('10.00'), at: T1 };
    expect(() => w.debit(usdMove)).toThrow(CurrencyMismatchError);
    expect(() => w.credit(usdMove)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('valor zero não é uma movimentação', () => {
    const w = open('100.00');
    expect(() => w.debit(move('0.00'))).toThrow(InvalidMovementError);
    expect(() => w.credit(move('0.00'))).toThrow(InvalidMovementError);
    expect(w.version).toBe(1);
  });

  test('version só incrementa quando o saldo muda (uma vez por movimentação)', () => {
    const w = open('100.00');
    w.debit(move('10.00', 'e1'));
    w.credit(move('5.00', 'e2'));
    w.debit(move('1.00', 'e3'));
    expect(w.version).toBe(4);
    expect(w.balance.toJSON().amount).toBe('94.00');
  });

  test('sequência de movimentações mantém a cadeia balanceBefore/balanceAfter', () => {
    const w = open('100.00');
    const a = w.debit(move('30.00', 'e1'));
    const b = w.credit(move('10.00', 'e2'));
    const c = w.debit(move('0.10', 'e3'));
    expect(a.balanceAfter.equals(b.balanceBefore)).toBe(true);
    expect(b.balanceAfter.equals(c.balanceBefore)).toBe(true);
    expect(c.balanceAfter.toJSON().amount).toBe('79.90');
  });
});

describe('atomicidade em memória', () => {
  test('se o lançamento for inválido, a wallet continua intacta (estado corrompido vindo do banco)', () => {
    // saldo persistido negativo NÃO deveria existir (o CHECK do banco impede), mas se vier:
    const corrupt = Wallet.rehydrate({
      id: 'w-x', playerId: 'p', currency: 'BRL', balance: brl('1.00').subtract(brl('5.00')),
      version: 3, createdAt: T0, updatedAt: T0,
    });
    // after = -4 + 10 = 6 (não negativo), mas balanceBefore = -4 invalida o lançamento
    expect(() => corrupt.credit(move('10.00'))).toThrow();
    expect(corrupt.balance.toJSON().amount).toBe('-4.00'); // nada foi alterado
    expect(corrupt.version).toBe(3);
    expect(corrupt.updatedAt).toBe(T0);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói exatamente o estado persistido', () => {
    const w = Wallet.rehydrate({
      id: 'w-9', playerId: 'p-9', currency: 'BRL', balance: brl('42.50'), version: 7, createdAt: T0, updatedAt: T1,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toJSON().amount).toBe('42.50');
    expect(w.updatedAt).toBe(T1);
  });
});