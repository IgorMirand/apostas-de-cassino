import type { MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction } from '../domain/wager-transaction';
import { Money } from '../domain/money';
import type { CreateWalletCommand } from './commands';
import { InvariantViolationError } from './errors';
import type { Clock, IdGenerator, UnitOfWork } from './ports';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export const toWalletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

/**
 * Cria a wallet. Se houver saldo inicial, a MESMA transação SQL cria também a
 * transação interna OPENING e o primeiro lançamento (CREDIT): nunca existe saldo sem ledger.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const now = this.clock.now();
    const wallet = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      at: now,
    });

    await this.uow.run(async (repos) => {
      await repos.wallets.insert(wallet); // a wallet ANTES dos filhos (FK); duplicada => WalletAlreadyExistsError

      if (!command.initialBalance.isPositive()) return; // saldo zero: sem OPENING nem lançamento

      const opening = WagerTransaction.opening({
        id: this.ids.next(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: command.initialBalance,
        createdAt: now,
      });
      if (!(await repos.transactions.insertIfAbsent(opening))) {
        throw new InvariantViolationError(`opening transaction for wallet ${wallet.id} already exists`);
      }
      await repos.ledger.append(
        WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: command.initialBalance,
          balanceBefore: Money.zero(command.initialBalance.currency),
          balanceAfter: command.initialBalance,
          createdAt: now,
        }),
      );
    });

    return toWalletView(wallet);
  }
}