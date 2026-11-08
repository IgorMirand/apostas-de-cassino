import { HttpException } from '@nestjs/common';
import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';
import {
  ApplicationError, IdempotencyConflictError, InvalidRequestError,
  WalletAlreadyExistsError, WalletNotFoundError,
} from '../application/errors';
import { InvalidMoneyError, InvalidTransactionError } from '../domain/errors';

export interface HttpErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface MappedError {
  status: number;
  body: HttpErrorBody;
  headers: Record<string, string>;
  /** 'error' = defeito/inesperado (5xx); 'warn' = falha transitória esperada; undefined = erro do cliente */
  logLevel?: 'error' | 'warn';
}

const body = (code: string, message: string, details?: unknown): HttpErrorBody => ({
  error: { code, message, ...(details !== undefined ? { details } : {}) },
});

/**
 * Tradução ÚNICA de erros para HTTP, usada por TODOS os endpoints (contrato consistente).
 *
 *   400  entrada inválida                       -> corrija e reenvie
 *   404  wallet inexistente / rota inexistente
 *   409  conflito de idempotência / wallet duplicada
 *   501  tipo de transação ainda não suportado
 *   503  falha TRANSITÓRIA de infraestrutura    -> reenvie com a MESMA Idempotency-Key (+ Retry-After)
 *   500  defeito nosso (detalhes só no log, nunca na resposta)
 *
 * (A rejeição de NEGÓCIO de uma transação não é erro: é uma resposta 422 do próprio endpoint.)
 */
export function mapError(e: unknown): MappedError {
  if (e instanceof InvalidRequestError) {
    return { status: 400, headers: {}, body: body(e.code, e.message, e.issues) };
  }
  if (e instanceof InvalidMoneyError || e instanceof InvalidTransactionError) {
    return { status: 400, headers: {}, body: body('INVALID_REQUEST', e.message) };
  }
  if (e instanceof WalletNotFoundError) {
    return { status: 404, headers: {}, body: body(e.code, e.message) };
  }
  if (e instanceof WalletAlreadyExistsError || e instanceof IdempotencyConflictError) {
    return { status: 409, headers: {}, body: body(e.code, e.message) };
  }
  if (e instanceof DeadlockException || e instanceof LockWaitTimeoutException || e instanceof ConnectionException) {
    return {
      status: 503,
      headers: { 'Retry-After': '1' },
      logLevel: 'warn',
      body: body('TEMPORARILY_UNAVAILABLE', 'temporary failure, retry with the same Idempotency-Key'),
    };
  }
  if (e instanceof HttpException) {
    const status = e.getStatus();
    const code = status === 400 ? 'INVALID_REQUEST' : status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'HTTP_ERROR';
    const message = status === 404 ? 'route not found' : e.message;
    return { status, headers: {}, body: body(code, message), ...(status >= 500 ? { logLevel: 'error' as const } : {}) };
  }
  // Qualquer outra coisa (inclui ApplicationError não mapeado e InvariantViolationError) é defeito nosso.
  const known = e instanceof ApplicationError ? e.code : 'INTERNAL_ERROR';
  return { status: 500, headers: {}, logLevel: 'error', body: body(known === 'INVARIANT_VIOLATION' ? known : 'INTERNAL_ERROR', 'internal error') };
}