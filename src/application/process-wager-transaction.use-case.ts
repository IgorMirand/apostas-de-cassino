import { InsufficientFundsError } from '../domain/errors';
import { FailureCode } from '../domain/failure-code';
import type { MoneyProps } from '../domain/money';
import type { Wallet } from '../domain/wallet';
import {
  WagerTransaction, WagerTransactionKind, type WagerTransactionStatus,
} from '../domain/wager-transaction';
import type { SubmitTransactionCommand } from './commands';
import {
  IdempotencyConflictError, InvariantViolationError, UnsupportedTransactionKindError, WalletNotFoundError,
} from './errors';
import { computePayloadHash } from './payload-hash';
import type { Clock, IdGenerator, Repositories, UnitOfWork } from './ports';

export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** saldo observado QUANDO a transação foi decidida (no replay, é o saldo da época, não o atual) */
  balance: MoneyProps;
  failureCode?: FailureCode | undefined;
  idempotentReplay: boolean;
}

/**
 * Processa uma transação de aposta (BET, WIN, LOSS). Tudo numa única transação SQL, nesta ORDEM
 * (a ordem foi MEDIDA: inserir antes de travar a wallet causa deadlock sob concorrência):
 *
 *   1. lookup por idempotency key, sem lock  -> caminho rápido do replay
 *   2. SELECT wallet ... FOR UPDATE          -> serializa tudo que toca esta wallet
 *   3. INSERT transação ... ON CONFLICT DO NOTHING
 *   4. regra de negócio -> saldo + ledger + status
 *
 * Rejeição de negócio é COMMIT de uma transação REJECTED (auditável), nunca uma exceção:
 * a exceção desfaria a transação SQL inteira e o registro da rejeição se perderia.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

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

    if (candidate.requiresReference()) {
      throw new UnsupportedTransactionKindError(candidate.kind);
    }

    return this.uow.run(async (repos) => {
      // 1) caminho rápido: já processamos esta requisição?
      const existing = await repos.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
      if (existing) return this.replay(existing, candidate);

      // 2) trava a wallet ANTES de inserir qualquer transação
      const wallet = await repos.wallets.findByIdForUpdate(command.walletId);
      if (!wallet) throw new WalletNotFoundError(command.walletId); // sem wallet não há onde registrar (FK)

      // 3) registra a transação; false = outra já ocupa a chave (corrida ou id externo repetido)
      const inserted = await repos.transactions.insertIfAbsent(candidate);
      if (!inserted) return this.resolveConflict(repos, candidate);

      // 4) regra de negócio
      return this.apply(repos, wallet, candidate, now);
    });
  }

  private async apply(
    repos: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    now: Date,
  ): Promise<TransactionResult> {
    if (tx.playerId !== wallet.playerId) return this.reject(repos, wallet, tx, FailureCode.WalletPlayerMismatch);
    if (tx.money.currency !== wallet.currency) return this.reject(repos, wallet, tx, FailureCode.CurrencyMismatch);

    switch (tx.kind) {
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Win: {
        const movement = { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, at: now };
        let entry;
        try {
          entry = tx.kind === WagerTransactionKind.Bet ? wallet.debit(movement) : wallet.credit(movement);
        } catch (e) {
          if (e instanceof InsufficientFundsError) {
            return this.reject(repos, wallet, tx, FailureCode.InsufficientFunds);
          }
          throw e;
        }
        tx.markProcessed(undefined, now, wallet.balance);
        repos.wallets.save(wallet);
        await repos.transactions.save(tx);
        await repos.ledger.append(entry);
        // OUTBOX: os eventos de integração entram AQUI, na mesma transação (próximo passo).
        return this.resultOf(tx, false);
      }
      case WagerTransactionKind.Loss:
        // LOSS não mexe no saldo nem gera lançamento: só registra
        tx.markProcessed(undefined, now, wallet.balance);
        await repos.transactions.save(tx);
        return this.resultOf(tx, false);
      default:
        throw new InvariantViolationError(`unexpected kind ${tx.kind} reached the business rules`);
    }
  }

  private async reject(
    repos: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    code: FailureCode,
  ): Promise<TransactionResult> {
    tx.reject(code, wallet.balance); // o saldo observado é o da WALLET (pode estar em outra moeda que a transação)
    await repos.transactions.save(tx);
    return this.resultOf(tx, false);
  }

  /** O INSERT não inseriu: descobrir se é replay legítimo ou conflito. */
  private async resolveConflict(repos: Repositories, candidate: WagerTransaction): Promise<TransactionResult> {
    const byKey = await repos.transactions.findByIdempotencyKey(candidate.providerId, candidate.idempotencyKey);
    if (byKey) return this.replay(byKey, candidate);

    const byExternalId = await repos.transactions.findByExternalId(
      candidate.providerId,
      candidate.externalTransactionId,
    );
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
    const balance = tx.observedBalance;
    if (!balance) {
      throw new InvariantViolationError(`transaction ${tx.id} (${tx.status}) has no observed balance`);
    }
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: balance.toJSON(),
      failureCode: tx.failureCode,
      idempotentReplay,
    };
  }
}