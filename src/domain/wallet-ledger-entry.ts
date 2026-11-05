import { CurrencyMismatchError, InvalidLedgerEntryError } from './errors';
import type { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento imutável do ledger.
 * A imutabilidade é estrutural: só há campos `readonly` e nenhum método de transição.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Valida a aritmética do lançamento. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const currencies = new Set([props.money.currency, props.balanceBefore.currency, props.balanceAfter.currency]);
    if (currencies.size !== 1) {
      throw new CurrencyMismatchError(`ledger entry mixes currencies: ${[...currencies].join(', ')}`);
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('ledger entry amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('ledger balances must not be negative');
    }
    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `unbalanced entry: ${props.balanceBefore} ${props.direction === LedgerDirection.Debit ? '-' : '+'} ${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrói estado já persistido. Não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }

  private static build(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id, s.walletId, s.transactionId, s.direction, s.money, s.balanceBefore, s.balanceAfter, s.createdAt,
    );
  }
}