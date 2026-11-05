import { InsufficientFundsError, InvalidMovementError, CurrencyMismatchError, InvalidMoneyError } from './errors';
import type { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
}

export interface MovementProps {
  /** id do novo lançamento (o domínio não gera ids: não depende de lib nem de relógio) */
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. Invariantes:
 *  - saldo nunca negativo;
 *  - cada alteração de saldo devolve o lançamento de ledger correspondente;
 *  - `version` inicia em 1 e só incrementa quando o saldo muda;
 *  - a moeda da operação deve ser a da wallet.
 *
 * Atenção: este objeto NÃO resolve concorrência. Ele só garante regras de uma
 * instância; quem serializa acessos à mesma wallet é o lock no banco.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version = 1.
   * O lançamento CREDIT do OPENING é criado pelo use case, na mesma transação SQL.
   */
  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('initial balance must not be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrói estado já persistido. Não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt,
    );
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  /** Lança InsufficientFundsError se o saldo não cobre o valor. */
  debit(movement: MovementProps): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, movement);
  }

  credit(movement: MovementProps): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, movement);
  }

  private move(direction: LedgerDirection, movement: MovementProps): WalletLedgerEntry {
    // 1) valida TUDO antes de mutar: se algo falhar, a wallet continua intacta
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidMovementError('movement amount must be positive');
    }
    const before = this._balance;
    const after =
      direction === LedgerDirection.Debit ? before.subtract(movement.money) : before.add(movement.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError(`insufficient funds: balance ${before}, debit ${movement.money}`);
    }
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });

    // 2) só agora muta
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet currency ${this.currency} != operation currency ${money.currency}`);
    }
  }
}