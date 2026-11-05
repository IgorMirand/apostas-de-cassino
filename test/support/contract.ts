/**
 * Decisões de contrato que o README deixa em aberto. Estão num único lugar
 * para que mudar uma decisão não exija reescrever os testes.
 * Documente cada uma no ARCHITECTURE.md.
 */
export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
} as const;

export const HttpStatus = {
  /** mesma Idempotency-Key com payload diferente */
  IdempotencyConflict: 409,
} as const;