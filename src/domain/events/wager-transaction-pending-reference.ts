import type { MoneyProps } from '../money';
import type { WagerTransaction } from '../wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

/** REFUND/ROLLBACK cuja referência ainda não existe (ou ainda está esperando a sua). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId || !tx.pendingNextAttemptAt) {
      throw new Error(`transaction ${tx.id} is not pending a reference`);
    }
    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        attempts: tx.pendingAttempts,
        nextAttemptAt: tx.pendingNextAttemptAt.toISOString(),
      },
    });
  }
}