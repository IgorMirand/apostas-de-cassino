import { InsufficientFundsError } from '../domain/errors';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { FailureCode } from '../domain/failure-code';
import { OutboxMessage } from '../domain/outbox-message';
import type { Wallet } from '../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { InvariantViolationError } from './errors';
import {
  DEFAULT_PENDING_REFERENCE_POLICY, pendingReferenceBackoffMs, type PendingReferencePolicy,
} from './pending-reference-policy';
import type { IdGenerator, Repositories } from './ports';

/**
 * Regras de negócio de UMA transação já inserida, com a wallet JÁ TRAVADA (FOR UPDATE) na transação SQL corrente.
 * Quem chama (use case HTTP/SQS ou worker de PENDING_REFERENCE) é responsável por travar a wallet primeiro.
 * Rejeição de negócio é COMMIT de transação REJECTED, nunca exceção.
 */
export class WagerTransactionApplier {
  constructor(
    private readonly ids: IdGenerator,
    private readonly policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
  ) {}

  async apply(repos: Repositories, wallet: Wallet, tx: WagerTransaction, now: Date): Promise<void> {
    if (tx.playerId !== wallet.playerId) return this.reject(repos, wallet, tx, FailureCode.WalletPlayerMismatch, now);
    if (tx.money.currency !== wallet.currency) return this.reject(repos, wallet, tx, FailureCode.CurrencyMismatch, now);

    switch (tx.kind) {
      case WagerTransactionKind.Bet:
        return this.move(repos, wallet, tx, now, LedgerDirection.Debit, FailureCode.InsufficientFunds);
      case WagerTransactionKind.Win:
        return this.move(repos, wallet, tx, now, LedgerDirection.Credit, FailureCode.InsufficientFunds);
      case WagerTransactionKind.Loss:
        // LOSS não mexe no saldo nem gera lançamento: só registra
        tx.markProcessed(undefined, now, wallet.balance);
        await repos.transactions.save(tx);
        return this.emit(repos, WagerTransactionProcessed.from(tx, this.context(tx, now)));
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return this.reverse(repos, wallet, tx, now);
      default:
        throw new InvariantViolationError(`unexpected kind ${tx.kind} reached the business rules`);
    }
  }

  private async reverse(repos: Repositories, wallet: Wallet, tx: WagerTransaction, now: Date): Promise<void> {
    const referenceExternalId = tx.referenceExternalTransactionId;
    if (referenceExternalId === undefined) {
      throw new InvariantViolationError(`${tx.kind} ${tx.id} has no reference`);
    }
    const reference = await repos.transactions.findByExternalId(tx.providerId, referenceExternalId);

    // referência ausente, ou ela própria ainda esperando a sua (cadeia fora de ordem): esperar
    if (!reference || (reference.id !== tx.id && reference.status === WagerTransactionStatus.PendingReference)) {
      return this.waitForReference(repos, wallet, tx, now);
    }

    const violation = tx.referenceViolation(reference);
    if (violation !== undefined) return this.reject(repos, wallet, tx, violation, now);

    // ALREADY_REVERSED se checa ANTES (sob o lock): um INSERT que viola o índice único abortaria a transação do Postgres
    if ((await repos.transactions.findProcessedReversalOf(reference.id)) !== null) {
      return this.reject(repos, wallet, tx, FailureCode.AlreadyReversed, now);
    }
    return this.move(
      repos, wallet, tx, now, tx.ledgerDirectionFor(reference), FailureCode.ReversalWouldOverdraw, reference.id,
    );
  }

  private async waitForReference(repos: Repositories, wallet: Wallet, tx: WagerTransaction, now: Date): Promise<void> {
    if (tx.pendingAttempts >= this.policy.maxAttempts) {
      return this.reject(repos, wallet, tx, FailureCode.ReferenceNotFound, now);
    }
    const firstTime = tx.status === WagerTransactionStatus.Pending;
    tx.markPendingReference(new Date(now.getTime() + pendingReferenceBackoffMs(tx.pendingAttempts + 1, this.policy)));
    await repos.transactions.save(tx);
    if (firstTime) await this.emit(repos, WagerTransactionPendingReference.from(tx, this.context(tx, now)));
  }

  private async move(
    repos: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    now: Date,
    direction: LedgerDirection,
    overdrawCode: FailureCode,
    referenceId?: string,
  ): Promise<void> {
    const movement = { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, at: now };
    let entry: WalletLedgerEntry;
    try {
      entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    } catch (e) {
      if (e instanceof InsufficientFundsError) return this.reject(repos, wallet, tx, overdrawCode, now);
      throw e;
    }
    tx.markProcessed(referenceId, now, wallet.balance);
    repos.wallets.save(wallet);
    await repos.transactions.save(tx);
    await repos.ledger.append(entry);
    await this.emit(
      repos,
      WagerTransactionProcessed.from(tx, this.context(tx, now)),
      WalletBalanceChanged.from(wallet, entry, this.context(tx, now)),
    );
  }

  private async reject(
    repos: Repositories, wallet: Wallet, tx: WagerTransaction, code: FailureCode, now: Date,
  ): Promise<void> {
    tx.reject(code, wallet.balance); // saldo observado = o da WALLET (pode estar em outra moeda que a transação)
    await repos.transactions.save(tx);
    await this.emit(repos, WagerTransactionRejected.from(tx, this.context(tx, now)));
  }

  private context(tx: WagerTransaction, now: Date): EventContext {
    return { eventId: this.ids.next(), correlationId: tx.idempotencyKey, causationId: tx.id, occurredAt: now };
  }

  private async emit(repos: Repositories, ...events: IntegrationEvent<unknown>[]): Promise<void> {
    for (const event of events) await repos.outbox.add(OutboxMessage.enqueue(event));
  }
}