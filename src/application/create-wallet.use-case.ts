import type { MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction } from '../domain/wager-transaction';
import { Money } from '../domain/money';
import type { CreateWalletCommand } from './commands';
import { InvariantViolationError } from './errors';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { OutboxMessage } from '../domain/outbox-message';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';

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
      const entry = WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: command.initialBalance,
          balanceBefore: Money.zero(command.initialBalance.currency),
          balanceAfter: command.initialBalance,
          createdAt: now,
        });
        await repos.ledger.append(entry);
        await repos.outbox.add(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, entry, {
              eventId: this.ids.next(),
              correlationId: opening.idempotencyKey,
              causationId: opening.id,
              occurredAt: now,
            }),
          ),
        );
      
    });

    return toWalletView(wallet);
  }
}