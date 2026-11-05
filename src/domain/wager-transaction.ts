import { FailureCode } from './failure-code';
import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import type { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
  /** INTERNO: saldo inicial da wallet. Nunca entra pela API nem pela fila. */
  Opening = 'OPENING',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Kinds que um provedor pode submeter (tudo menos OPENING). */
export type SubmittableKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export const INTERNAL_PROVIDER_ID = 'INTERNAL';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  /** obrigatório para REFUND/ROLLBACK, proibido nos demais */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  createdAt: Date;
  processedAt?: Date;
  pendingAttempts: number;
  pendingNextAttemptAt?: Date;
}

/**
 * Transições válidas:
 *
 *   PENDING ──► PROCESSED            (terminal)
 *      │  ├───► REJECTED             (terminal)  violação de regra de negócio
 *      │  ├───► FAILED               (terminal)  erro permanente de infraestrutura
 *      │  └───► PENDING_REFERENCE
 *   PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *                    └──► PENDING_REFERENCE   (nova tentativa sem achar a referência)
 *
 * PROCESSED, REJECTED e FAILED são terminais: tentar transicioná-los é erro de programação.
 */
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string | undefined;
  public readonly gameId: string | undefined;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  /** id no provedor, não o id interno */
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _pendingAttempts: number;
  private _pendingNextAttemptAt: Date | undefined;

  private constructor(s: WagerTransactionState) {
    this.id = s.id;
    this.providerId = s.providerId;
    this.externalTransactionId = s.externalTransactionId;
    this.idempotencyKey = s.idempotencyKey;
    this.payloadHash = s.payloadHash;
    this.walletId = s.walletId;
    this.playerId = s.playerId;
    this.roundId = s.roundId;
    this.gameId = s.gameId;
    this.kind = s.kind;
    this.money = s.money;
    this.referenceExternalTransactionId = s.referenceExternalTransactionId;
    this.createdAt = s.createdAt;
    this._status = s.status;
    this._referenceTransactionId = s.referenceTransactionId;
    this._failureCode = s.failureCode;
    this._processedAt = s.processedAt;
    this._pendingAttempts = s.pendingAttempts;
    this._pendingNextAttemptAt = s.pendingNextAttemptAt;
  }

  /** Nasce PENDING. Valida o que é estático (referência por kind, valor, OPENING proibido). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    // defesa em profundidade: o tipo já exclui OPENING, mas a entrada real vem de JSON
    if ((props.kind as WagerTransactionKind) === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING is internal and cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidTransactionError(`unknown kind: ${String(props.kind)}`);
    }
    if (props.money.isNegative()) {
      throw new InvalidTransactionError('amount must not be negative');
    }
    // LOSS pode ter valor zero; todo o resto precisa mover dinheiro
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidTransactionError(`${props.kind} amount must be positive`);
    }
    const needsReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsReference && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (!needsReference && props.referenceExternalTransactionId !== undefined) {
      throw new InvalidTransactionError(`${props.kind} must not carry a reference`);
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      pendingAttempts: 0,
    });
  }

  /** Transação interna do saldo inicial. Nasce já PROCESSED (é criada junto do primeiro lançamento). */
  static opening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('OPENING amount must be positive (no opening for a zero balance)');
    }
    const key = `opening:${props.walletId}`;
    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: 'internal',
      walletId: props.walletId,
      playerId: props.playerId,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      status: WagerTransactionStatus.Processed,
      createdAt: props.createdAt,
      processedAt: props.createdAt,
      pendingAttempts: 0,
    });
  }

  /** Reconstrói estado já persistido. NÃO revalida regras de transição. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get pendingAttempts(): number { return this._pendingAttempts; }
  get pendingNextAttemptAt(): Date | undefined { return this._pendingNextAttemptAt; }

  // ------------------------------------------------------------ transições

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertOpen('markProcessed');
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionError(`${this.kind} cannot be processed without its resolved reference`);
    }
    if (!this.requiresReference() && referenceTransactionId !== undefined) {
      throw new InvalidTransactionError(`${this.kind} does not take a reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._failureCode = undefined;
    this._pendingNextAttemptAt = undefined;
  }

  /** Cada chamada conta uma tentativa de resolver a referência. Política (limite, backoff) é da aplicação. */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertOpen('markPendingReference');
    if (!this.requiresReference()) {
      throw new InvalidTransactionError(`${this.kind} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._pendingAttempts += 1;
    this._pendingNextAttemptAt = nextAttemptAt;
  }

  /** Violação de regra de negócio. Terminal e auditável. */
  reject(code: FailureCode): void {
    this.assertOpen('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._pendingNextAttemptAt = undefined;
  }

  /** Erro permanente de infraestrutura. Terminal e auditável. */
  fail(code: FailureCode): void {
    this.assertOpen('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._pendingNextAttemptAt = undefined;
  }

  // ---------------------------------------------------- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** false para LOSS */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento que esta transação produz.
   *  BET → DEBIT | WIN, OPENING, REFUND → CREDIT | ROLLBACK → o INVERSO da referência.
   * LOSS não gera lançamento, então perguntar a direção dele é erro de programação.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionError('ROLLBACK needs its reference to know the inverse direction');
        }
        // reverter um débito (BET) credita; reverter um crédito (WIN, REFUND) debita
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS does not affect the balance and has no ledger direction');
    }
  }

  /**
   * Regras 2, 3 e 5 do README, contra a transação referenciada.
   * Devolve o FailureCode da primeira violação, ou undefined se a referência é válida.
   *
   * NÃO cobre "já foi revertida": isso depende de outras linhas e é garantido
   * pelo índice único `wt_single_reversal_uq` no banco (o use case traduz a
   * violação em ALREADY_REVERSED).
   */
  referenceViolation(reference: WagerTransaction): FailureCode | undefined {
    if (!this.requiresReference()) {
      throw new InvalidTransactionError(`${this.kind} has no reference to validate`);
    }
    // regra 3: REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND
    const allowed =
      this.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
    if (!allowed.includes(reference.kind)) {
      return FailureCode.InvalidReferenceKind;
    }
    // regra 2: mesmo provider, player, wallet, moeda e rodada
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    // só se reverte o que foi de fato aplicado
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    // regra 5: valor igual (reversão parcial está fora de escopo)
    if (!reference.money.equals(this.money)) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  private assertOpen(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${operation} transaction ${this.id}: already terminal (${this._status})`,
      );
    }
  }
}