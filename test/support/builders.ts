import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type SubmittableKind,
} from '../../src/domain/wager-transaction';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
export const T0 = new Date('2026-11-05T12:00:00.000Z');
export const T1 = new Date('2026-11-05T12:00:01.000Z');

interface TxOverrides {
  id?: string;
  kind?: SubmittableKind;
  amount?: string;
  currency?: string;
  providerId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  ref?: string | undefined;
}

/** Cria uma WagerTransaction PENDING válida; `ref` só é aplicado quando o kind exige referência. */
export function makeTx(o: TxOverrides = {}): WagerTransaction {
  const kind = o.kind ?? WagerTransactionKind.Bet;
  const needsRef = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  const id = o.id ?? 'tx-1';
  return WagerTransaction.create({
    id,
    providerId: o.providerId ?? 'prov',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `prov:ext-${id}`,
    payloadHash: `hash-${id}`,
    walletId: o.walletId ?? 'w-1',
    playerId: o.playerId ?? 'p-1',
    roundId: o.roundId ?? 'r-1',
    gameId: 'g-1',
    kind,
    money: Money.from({ amount: o.amount ?? '80.00', currency: o.currency ?? 'BRL' }),
    referenceExternalTransactionId: needsRef ? (o.ref ?? 'ext-tx-ref') : undefined,
    createdAt: T0,
  });
}

/** Uma transação já PROCESSED, como se viesse do banco (serve de referência). */
export function makeProcessed(o: TxOverrides = {}): WagerTransaction {
  const tx = makeTx(o);
  tx.markProcessed(tx.requiresReference() ? `resolved-ref-of-${tx.id}` : undefined, T0);
  return tx;
}

export { WagerTransactionStatus };