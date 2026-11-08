import type { MoneyProps } from '../money';
import type { WagerTransaction } from '../wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  money: MoneyProps;
  /** saldo da wallet depois de aplicada a transação */
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (que não altera o saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.observedBalance || !tx.processedAt) {
      throw new Error(`transaction ${tx.id} is not processed (no observed balance / processedAt)`);
    }
    return new WagerTransactionProcessed({
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
        balance: tx.observedBalance.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}