/**
 * Registros de persistência: classes planas, só escalares, SEM regra de negócio.
 * O domínio nunca os enxerga; os mappers fazem a ponte (`mappers.ts`).
 *
 * Dinheiro aqui é SEMPRE `string` (NUMERIC no banco). Nunca `number`.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  createdAt!: Date;
  processedAt!: Date | null;
  pendingAttempts!: number;
  pendingNextAttemptAt!: Date | null;
  observedBalance!: string | null;
  observedCurrency!: string | null;
}

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}