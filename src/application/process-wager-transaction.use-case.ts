import type { FailureCode } from '../domain/failure-code';
import type { MoneyProps } from '../domain/money';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { SubmitTransactionCommand } from './commands';
import { IdempotencyConflictError, InvariantViolationError, WalletNotFoundError } from './errors';
import { computePayloadHash } from './payload-hash';
import type { Clock, IdGenerator, Repositories, UnitOfWork } from './ports';
import { WagerTransactionApplier } from './wager-transaction-applier';

export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /**
   * Saldo observado QUANDO a transação foi decidida (no replay, é o da época, não o atual).
   * AUSENTE em PENDING_REFERENCE: a transação ainda não foi decidida.
   */
  balance?: MoneyProps | undefined;
  failureCode?: FailureCode | undefined;
  idempotentReplay: boolean;
}

/**
 * Processa uma transação de aposta. Tudo numa única transação SQL, nesta ORDEM (medida: inserir antes de
 * travar a wallet causa deadlock sob concorrência):
 *   1. lookup por idempotency key, sem lock  -> caminho rápido do replay
 *   2. SELECT wallet ... FOR UPDATE          -> serializa tudo que toca esta wallet
 *   3. INSERT transação ... ON CONFLICT DO NOTHING
 *   4. regra de negócio (WagerTransactionApplier)
 */
export class ProcessWagerTransactionUseCase {
  private readonly applier: WagerTransactionApplier;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private ids: IdGenerator,
  ) {
    this.applier = new WagerTransactionApplier(ids);
  }

  async execute(command: SubmitTransactionCommand): Promise<TransactionResult> {
    const now = this.clock.now();
    const candidate = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: computePayloadHash(command),
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    return this.uow.run(async (repos) => {
      const existing = await repos.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
      if (existing) return this.replay(existing, candidate);

      const wallet = await repos.wallets.findByIdForUpdate(command.walletId);
      if (!wallet) throw new WalletNotFoundError(command.walletId); // sem wallet não há onde registrar (FK)

      const inserted = await repos.transactions.insertIfAbsent(candidate);
      if (!inserted) return this.resolveConflict(repos, candidate);

      await this.applier.apply(repos, wallet, candidate, now);
      return this.resultOf(candidate, false);
    });
  }

  /** O INSERT não inseriu: descobrir se é replay legítimo ou conflito. */
  private async resolveConflict(repos: Repositories, candidate: WagerTransaction): Promise<TransactionResult> {
    const byKey = await repos.transactions.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
    if (byKey) return this.replay(byKey, candidate);

    const byExternalId = await repos.transactions.findByExternalId(candidate.providerId, candidate.externalTransactionId);
    if (byExternalId) {
      throw new IdempotencyConflictError(
        `externalTransactionId ${candidate.externalTransactionId} was already used with a different Idempotency-Key`,
      );
    }
    throw new InvariantViolationError('insert reported a conflict but no conflicting row was found');
  }

  private replay(existing: WagerTransaction, candidate: WagerTransaction): TransactionResult {
    if (!existing.matchesPayload(candidate.payloadHash)) {
      throw new IdempotencyConflictError(
        `Idempotency-Key ${existing.idempotencyKey} was already used with a different payload`,
      );
    }
    return this.resultOf(existing, true);
  }

  private resultOf(tx: WagerTransaction, idempotentReplay: boolean): TransactionResult {
    const base = { transactionId: tx.id, status: tx.status, failureCode: tx.failureCode, idempotentReplay };
    if (tx.status === WagerTransactionStatus.PendingReference) return base; // ainda não decidida: sem saldo observado
    const balance = tx.observedBalance;
    if (!balance) {
      throw new InvariantViolationError(`transaction ${tx.id} (${tx.status}) has no observed balance`);
    }
    return { ...base, balance: balance.toJSON() };
  }
}