import { EntitySchema } from '@mikro-orm/core';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './records';

/**
 * Mapeamento SEM decorators: o MikroORM é um detalhe de infraestrutura.
 * As tabelas e constraints são donas das migrations (db/001_init.up.sql);
 * aqui só se descreve como ler e escrever as colunas.
 */

/** NUMERIC(19,2) lido e escrito como string. `runtimeType: 'string'` é o que impede a conversão para number. */
const money = { type: 'decimal', precision: 19, scale: 2, runtimeType: 'string' } as const;
const text = { type: 'string', columnType: 'text' } as const;
const timestamptz = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { ...text, fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { ...money },
    version: { type: 'integer' },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
    updatedAt: { ...timestamptz, fieldName: 'updated_at' },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { ...text, fieldName: 'provider_id' },
    externalTransactionId: { ...text, fieldName: 'external_transaction_id' },
    idempotencyKey: { ...text, fieldName: 'idempotency_key' },
    payloadHash: { ...text, fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { ...text, fieldName: 'player_id' },
    roundId: { ...text, fieldName: 'round_id', nullable: true },
    gameId: { ...text, fieldName: 'game_id', nullable: true },
    kind: { ...text },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { ...text, fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { ...text },
    failureCode: { ...text, fieldName: 'failure_code', nullable: true },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
    processedAt: { ...timestamptz, fieldName: 'processed_at', nullable: true },
    pendingAttempts: { type: 'integer', fieldName: 'pending_attempts' },
    pendingNextAttemptAt: { ...timestamptz, fieldName: 'pending_next_attempt_at', nullable: true },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { ...text },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { ...money, fieldName: 'balance_before' },
    balanceAfter: { ...money, fieldName: 'balance_after' },
    createdAt: { ...timestamptz, fieldName: 'created_at' },
  },
});

export const schemas = [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema];