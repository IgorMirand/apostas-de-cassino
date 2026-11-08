import type { MoneyProps } from '../money';
import type { WagerTransaction } from '../wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  money: MoneyProps;
  failureCode: string;
  /** saldo da wallet no momento da rejeição */
  balance: MoneyProps;
}

/** Transação rejeitada por regra de negócio (o saldo NÃO muda). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode || !tx.observedBalance) {
      throw new Error(`transaction ${tx.id} is not rejected (no failureCode / observed balance)`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        ...(tx.roundId !== undefined ? { roundId: tx.roundId } : {}),
        ...(tx.gameId !== undefined ? { gameId: tx.gameId } : {}),
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
        balance: tx.observedBalance.toJSON(),
      },
    });
  }
}