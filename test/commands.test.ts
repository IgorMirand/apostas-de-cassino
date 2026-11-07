import { describe, expect, test } from 'bun:test';
import { parseCreateWalletCommand, parseSubmitTransactionCommand } from '../src/application/commands';
import { InvalidRequestError } from '../src/application/errors';
import { WagerTransactionKind } from '../src/domain/wager-transaction';

const WALLET = '0198f1d2-7a3b-7c4d-8e5f-0123456789ab';
const valid = () => ({
  providerId: 'prov', externalTransactionId: 'ext-1', idempotencyKey: 'prov:ext-1', playerId: 'p-1',
  walletId: WALLET, roundId: 'r-1', gameId: 'g-1', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
});

const issuesOf = (fn: () => unknown): string[] => {
  try { fn(); } catch (e) { if (e instanceof InvalidRequestError) return e.issues; throw e; }
  return [];
};

describe('parseSubmitTransactionCommand', () => {
  test('aceita um payload válido e normaliza o valor', () => {
    const c = parseSubmitTransactionCommand({ ...valid(), money: { amount: '25', currency: 'BRL' } });
    expect(c.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(c.kind).toBe(WagerTransactionKind.Bet);
    expect(c.referenceExternalTransactionId).toBeUndefined();
  });

  test('aceita referenceExternalTransactionId e trata null como ausente', () => {
    expect(parseSubmitTransactionCommand({ ...valid(), kind: 'REFUND', referenceExternalTransactionId: 'bet-1' })
      .referenceExternalTransactionId).toBe('bet-1');
    expect(parseSubmitTransactionCommand({ ...valid(), referenceExternalTransactionId: null })
      .referenceExternalTransactionId).toBeUndefined();
  });

  // cada caso embrulhado na sua lista de argumentos: o test.each do Bun ESPALHA elementos que são arrays
  test.each([[null], [undefined], ['texto'], [42], [[]], [[valid()]]])('corpo que não é objeto JSON: %p', (body) => {
    expect(issuesOf(() => parseSubmitTransactionCommand(body))).toEqual(['body must be a JSON object']);
  });

  test('OPENING e kinds desconhecidos são recusados', () => {
    for (const kind of ['OPENING', 'JACKPOT', 'bet', 42, undefined]) {
      expect(issuesOf(() => parseSubmitTransactionCommand({ ...valid(), kind }))).toHaveLength(1);
    }
  });

  test.each(['', '   ', 42, null, undefined])('campo de texto inválido: %p', (value) => {
    for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'roundId', 'gameId']) {
      const issues = issuesOf(() => parseSubmitTransactionCommand({ ...valid(), [field]: value }));
      expect(issues).toEqual([`${field} must be a non-empty string`]);
    }
  });

  test('walletId precisa ser UUID', () => {
    for (const walletId of ['abc', '', 42, null]) {
      expect(issuesOf(() => parseSubmitTransactionCommand({ ...valid(), walletId }))).toEqual(['walletId must be a UUID']);
    }
  });

  test.each([
    ['float JSON (number)', { amount: 25, currency: 'BRL' }],
    ['notação científica', { amount: '1e3', currency: 'BRL' }],
    ['3 casas', { amount: '1.234', currency: 'BRL' }],
    ['negativo', { amount: '-1.00', currency: 'BRL' }],
    ['moeda minúscula', { amount: '1.00', currency: 'brl' }],
    ['ausente', undefined],
  ])('money inválido: %s', (_label, money) => {
    const issues = issuesOf(() => parseSubmitTransactionCommand({ ...valid(), money }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toStartWith('money:');
  });

  test('acumula TODOS os problemas de uma vez (não só o primeiro)', () => {
    const issues = issuesOf(() => parseSubmitTransactionCommand({ ...valid(), providerId: '', walletId: 'x', kind: 'NOPE' }));
    expect(issues).toHaveLength(3);
  });

  test('limites de tamanho (128; idempotencyKey 255)', () => {
    expect(issuesOf(() => parseSubmitTransactionCommand({ ...valid(), providerId: 'x'.repeat(129) }))).toHaveLength(1);
    expect(issuesOf(() => parseSubmitTransactionCommand({ ...valid(), idempotencyKey: 'x'.repeat(255) }))).toEqual([]);
    expect(issuesOf(() => parseSubmitTransactionCommand({ ...valid(), idempotencyKey: 'x'.repeat(256) }))).toHaveLength(1);
  });
});

describe('parseCreateWalletCommand', () => {
  test('aceita saldo inicial positivo e zero', () => {
    expect(parseCreateWalletCommand({ playerId: 'p', initialBalance: { amount: '1000.00', currency: 'BRL' } })
      .initialBalance.toJSON().amount).toBe('1000.00');
    expect(parseCreateWalletCommand({ playerId: 'p', initialBalance: { amount: '0', currency: 'BRL' } })
      .initialBalance.isZero()).toBe(true);
  });

  test('recusa playerId vazio e saldo inicial inválido, acumulando os problemas', () => {
    expect(issuesOf(() => parseCreateWalletCommand({ playerId: '', initialBalance: { amount: 'x', currency: 'BRL' } })))
      .toHaveLength(2);
    expect(issuesOf(() => parseCreateWalletCommand(null))).toEqual(['body must be a JSON object']);
  });
});