import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';
import { InvalidLedgerEntryError, CurrencyMismatchError } from '../src/domain/errors';
import { brl, usd, T0 } from './support/builders';

const props = (over: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) => ({
  id: 'e-1', walletId: 'w-1', transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('80.00'), balanceBefore: brl('100.00'), balanceAfter: brl('20.00'),
  createdAt: T0,
  ...over,
});

describe('WalletLedgerEntry.create', () => {
  test('aceita lançamento balanceado (débito e crédito)', () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(props({
      direction: LedgerDirection.Credit, balanceBefore: brl('20.00'), balanceAfter: brl('100.00'),
    }));
    expect(credit.isBalanced()).toBe(true);
  });

  test('rejeita aritmética que não fecha', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('25.00') }))).toThrow(InvalidLedgerEntryError);
    // direção trocada: um débito de 80 não leva 20 → 100
    expect(() => WalletLedgerEntry.create(props({ balanceBefore: brl('20.00'), balanceAfter: brl('100.00') })))
      .toThrow(InvalidLedgerEntryError);
  });

  test('rejeita valor zero e saldo negativo', () => {
    expect(() => WalletLedgerEntry.create(props({ money: brl('0.00'), balanceAfter: brl('100.00') })))
      .toThrow(InvalidLedgerEntryError);
    const negativeAfter = brl('20.00').subtract(brl('30.00'));
    expect(() => WalletLedgerEntry.create(props({ money: brl('30.00'), balanceBefore: brl('20.00'), balanceAfter: negativeAfter })))
      .toThrow(InvalidLedgerEntryError);
  });

  test('moedas misturadas são erro de domínio', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: usd('20.00') }))).toThrow(CurrencyMismatchError);
  });
});

describe('imutabilidade estrutural', () => {
  test('não expõe nenhum método de transição', () => {
    const entry = WalletLedgerEntry.create(props());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((n) => n !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });
});

describe('rehydrate', () => {
  test('não revalida: reconstrói o que veio do banco', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('25.00') }));
    expect(entry.isBalanced()).toBe(false); // estado inconsistente é reconstruído como está
  });
});