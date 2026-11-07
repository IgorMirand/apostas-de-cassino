/** Erros da camada de aplicação. O adaptador (HTTP ou SQS) decide como traduzi-los. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada malformada ou inválida. Não adianta reenviar sem corrigir. */
export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_REQUEST';

  constructor(public readonly issues: string[]) {
    super(`invalid request: ${issues.join('; ')}`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

/** Já existe wallet para este (playerId, moeda). */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`wallet already exists for player ${playerId} in ${currency}`);
  }
}

/** Mesma Idempotency-Key com payload diferente, ou mesmo id externo com outra chave. NÃO é replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** Tipo de transação ainda não suportado por este use case. */
export class UnsupportedTransactionKindError extends ApplicationError {
  readonly code = 'UNSUPPORTED_TRANSACTION_KIND';

  constructor(kind: string) {
    super(`transaction kind ${kind} is not supported yet`);
  }
}

/** Estado que NUNCA deveria existir. É bug ou corrupção, não regra de negócio. */
export class InvariantViolationError extends ApplicationError {
  readonly code = 'INVARIANT_VIOLATION';
}