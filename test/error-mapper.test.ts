import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException, HttpException } from '@nestjs/common';
import { ConnectionException, DeadlockException, LockWaitTimeoutException } from '@mikro-orm/core';
import { mapError } from '../src/http/error-mapper';
import {
  IdempotencyConflictError, InvalidRequestError, InvariantViolationError,
  WalletAlreadyExistsError, WalletNotFoundError,
} from '../src/application/errors';
import { InvalidMoneyError, InvalidTransactionError, InsufficientFundsError } from '../src/domain/errors';

const pgError = (message: string) => Object.assign(new Error(message), { code: '40P01' });

describe('mapError: erros do cliente', () => {
  test.each([
    ['InvalidRequestError', new InvalidRequestError(['a', 'b']), 400, 'INVALID_REQUEST'],
    ['InvalidMoneyError', new InvalidMoneyError('x'), 400, 'INVALID_REQUEST'],
    ['InvalidTransactionError', new InvalidTransactionError('x'), 400, 'INVALID_REQUEST'],
    ['WalletNotFoundError', new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    ['WalletAlreadyExistsError', new WalletAlreadyExistsError('p', 'BRL'), 409, 'WALLET_ALREADY_EXISTS'],
    ['IdempotencyConflictError', new IdempotencyConflictError('x'), 409, 'IDEMPOTENCY_CONFLICT'],
  ])('%s', (_name, error, status, code) => {
    const mapped = mapError(error);
    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
    expect(mapped.logLevel).toBeUndefined(); // erro do cliente não é ruído de log
  });

  test('InvalidRequestError devolve a lista de problemas em details', () => {
    expect(mapError(new InvalidRequestError(['a', 'b'])).body.error.details).toEqual(['a', 'b']);
  });

  test('HttpException do Nest: 400 e 404 viram códigos estáveis', () => {
    expect(mapError(new BadRequestException('Unexpected token')).body.error.code).toBe('INVALID_REQUEST');
    const nf = mapError(new NotFoundException());
    expect(nf.status).toBe(404);
    expect(nf.body.error).toEqual({ code: 'NOT_FOUND', message: 'route not found' });
    expect(mapError(new HttpException('big', 413)).body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('mapError: falhas transitórias => 503 com Retry-After', () => {
  test.each([
    ['deadlock', new DeadlockException(pgError('deadlock detected'))],
    ['lock timeout', new LockWaitTimeoutException(pgError('lock timeout'))],
    ['conexão', new ConnectionException(pgError('connection refused'))],
  ])('%s', (_name, error) => {
    const mapped = mapError(error);
    expect(mapped.status).toBe(503);
    expect(mapped.headers['Retry-After']).toBe('1');
    expect(mapped.body.error.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect(mapped.logLevel).toBe('warn');
  });
});

describe('mapError: defeitos nossos => 500 sem vazar detalhes', () => {
  test('erro desconhecido não expõe a mensagem original', () => {
    const mapped = mapError(new Error('connection string postgres://app:SEGREDO@db'));
    expect(mapped.status).toBe(500);
    expect(JSON.stringify(mapped.body)).not.toContain('SEGREDO');
    expect(mapped.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'internal error' });
    expect(mapped.logLevel).toBe('error');
  });

  test('valores que não são Error (throw "x") também viram 500', () => {
    expect(mapError('texto').status).toBe(500);
    expect(mapError(undefined).status).toBe(500);
  });

  test('InvariantViolationError mantém seu código (é bug, mas rastreável)', () => {
    const mapped = mapError(new InvariantViolationError('x'));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe('INVARIANT_VIOLATION');
    expect(mapped.logLevel).toBe('error');
  });

  test('erro de DOMÍNIO inesperado (ex.: saldo insuficiente que vazou) é 500, não 4xx', () => {
    expect(mapError(new InsufficientFundsError('x')).status).toBe(500);
  });
});