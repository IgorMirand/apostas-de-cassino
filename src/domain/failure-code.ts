/**
 * Taxonomia de falhas de negócio (estável e legível por máquina).
 * Cada código diz ao provedor o que fazer:
 *
 *  - REENVIAR NÃO ADIANTA (corrija o payload ou desista):
 *      INSUFFICIENT_FUNDS, CURRENCY_MISMATCH, WALLET_PLAYER_MISMATCH,
 *      REFERENCE_MISMATCH, INVALID_REFERENCE_KIND, AMOUNT_MISMATCH,
 *      REFERENCE_NOT_PROCESSED, ALREADY_REVERSED
 *  - SITUAÇÃO OPERACIONAL ESPECIAL (não é "falta de saldo para apostar"):
 *      REVERSAL_WOULD_OVERDRAW
 *  - REFERÊNCIA NUNCA APARECEU (esgotou as tentativas de reprocessamento):
 *      REFERENCE_NOT_FOUND
 *  - FALHA PERMANENTE DE INFRAESTRUTURA (status FAILED):
 *      INTERNAL_ERROR
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AmountMismatch = 'AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  InternalError = 'INTERNAL_ERROR',
}