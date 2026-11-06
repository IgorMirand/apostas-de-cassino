import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/wallet-ledger-entry';
import {
  WagerTransaction, WagerTransactionKind, WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { FailureCode } from '../../domain/failure-code';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './records';

/**
 * Ponte domínio ⇄ persistência. Regras:
 *  - Money vira (amount string, currency) e volta via Money.from: exato, sem number no caminho;
 *  - a leitura usa SEMPRE `rehydrate` (não revalida transições);
 *  - null do banco ⇄ undefined do domínio;
 *  - o domínio nunca importa nada daqui.
 */
const money = (amount: string, currency: string) => Money.from({ amount, currency });
const amountOf = (m: Money) => m.toJSON().amount;
const orUndefined = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

// ----------------------------------------------------------------- Wallet
export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

/** Copia para o registro SÓ o que muda numa wallet existente. */
export function applyWalletToRecord(wallet: Wallet, record: WalletRecord): void {
  record.balance = amountOf(wallet.balance);
  record.version = wallet.version;
  record.updatedAt = wallet.updatedAt;
}

export function walletToNewRecord(wallet: Wallet): WalletRecord {
  const r = new WalletRecord();
  r.id = wallet.id;
  r.playerId = wallet.playerId;
  r.currency = wallet.currency;
  r.createdAt = wallet.createdAt;
  applyWalletToRecord(wallet, r);
  return r;
}

// ------------------------------------------------------- WagerTransaction
export function transactionToDomain(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: orUndefined(r.roundId),
    gameId: orUndefined(r.gameId),
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: orUndefined(r.referenceExternalTransactionId),
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(r.referenceTransactionId),
    failureCode: orUndefined(r.failureCode) as FailureCode | undefined,
    createdAt: r.createdAt,
    processedAt: orUndefined(r.processedAt),
    pendingAttempts: r.pendingAttempts,
    pendingNextAttemptAt: orUndefined(r.pendingNextAttemptAt),
  });
}

/** Copia para o registro o que uma transação pode mudar depois de criada (as transições). */
export function applyTransactionToRecord(tx: WagerTransaction, record: WagerTransactionRecord): void {
  record.status = tx.status;
  record.referenceTransactionId = tx.referenceTransactionId ?? null;
  record.failureCode = tx.failureCode ?? null;
  record.processedAt = tx.processedAt ?? null;
  record.pendingAttempts = tx.pendingAttempts;
  record.pendingNextAttemptAt = tx.pendingNextAttemptAt ?? null;
}

export function transactionToNewRecord(tx: WagerTransaction): WagerTransactionRecord {
  const r = new WagerTransactionRecord();
  r.id = tx.id;
  r.providerId = tx.providerId;
  r.externalTransactionId = tx.externalTransactionId;
  r.idempotencyKey = tx.idempotencyKey;
  r.payloadHash = tx.payloadHash;
  r.walletId = tx.walletId;
  r.playerId = tx.playerId;
  r.roundId = tx.roundId ?? null;
  r.gameId = tx.gameId ?? null;
  r.kind = tx.kind;
  r.amount = amountOf(tx.money);
  r.currency = tx.money.currency;
  r.referenceExternalTransactionId = tx.referenceExternalTransactionId ?? null;
  r.createdAt = tx.createdAt;
  applyTransactionToRecord(tx, r);
  return r;
}

// ------------------------------------------------------ WalletLedgerEntry
export function ledgerEntryToDomain(r: WalletLedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    createdAt: r.createdAt,
  });
}

/** O ledger é append-only: só existe "novo registro", nunca "aplicar mudança". */
export function ledgerEntryToNewRecord(e: WalletLedgerEntry): WalletLedgerEntryRecord {
  const r = new WalletLedgerEntryRecord();
  r.id = e.id;
  r.walletId = e.walletId;
  r.transactionId = e.transactionId;
  r.direction = e.direction;
  r.amount = amountOf(e.money);
  r.currency = e.money.currency;
  r.balanceBefore = amountOf(e.balanceBefore);
  r.balanceAfter = amountOf(e.balanceAfter);
  r.createdAt = e.createdAt;
  return r;
}