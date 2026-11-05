export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// ---- Money
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

// ---- Wallet / Ledger
/** Débito maior que o saldo. O use case decide o failureCode conforme o tipo da transação. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidMovementError extends DomainError {
  readonly code = 'INVALID_MOVEMENT';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

// ---- WagerTransaction
/** Entrada inválida para criar/usar uma transação (regra estática, ex.: REFUND sem referência). */
export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
}

/** Transição proibida (ex.: mexer em transação terminal). É erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}