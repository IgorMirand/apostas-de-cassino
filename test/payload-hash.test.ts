import { describe, expect, test } from 'bun:test';
import { computePayloadHash, type PayloadFields } from '../src/application/payload-hash';
import { brl, usd } from './support/builders';

const base = (over: Partial<PayloadFields> = {}): PayloadFields => ({
  providerId: 'prov', externalTransactionId: 'ext-1', playerId: 'p-1',
  walletId: 'w-1', roundId: 'r-1', gameId: 'g-1', kind: 'BET', money: brl('25.00'),
  ...over,
});

describe('computePayloadHash', () => {
  test('é determinístico (64 hex do SHA-256)', () => {
    expect(computePayloadHash(base())).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash(base())).toBe(computePayloadHash(base()));
  });

  test('o valor entra NORMALIZADO: "25", "25.0" e "25.00" geram o mesmo hash', () => {
    const h = computePayloadHash(base({ money: brl('25.00') }));
    expect(computePayloadHash(base({ money: brl('25') }))).toBe(h);
    expect(computePayloadHash(base({ money: brl('25.0') }))).toBe(h);
  });

  test.each([
    ['valor', { money: brl('25.01') }],
    ['moeda', { money: usd('25.00') }],
    ['providerId', { providerId: 'outro' }],
    ['externalTransactionId', { externalTransactionId: 'ext-2' }],
    ['playerId', { playerId: 'p-2' }],
    ['walletId', { walletId: 'w-2' }],
    ['roundId', { roundId: 'r-2' }],
    ['gameId', { gameId: 'g-2' }],
    ['kind', { kind: 'WIN' }],
    ['referência', { referenceExternalTransactionId: 'ref-1' }],
  ] as const)('qualquer mudança em %s muda o hash', (_name, over) => {
    expect(computePayloadHash(base(over))).not.toBe(computePayloadHash(base()));
  });

  test('sem ambiguidade entre campos adjacentes ("ab"+"c" != "a"+"bc")', () => {
    expect(computePayloadHash(base({ providerId: 'ab', externalTransactionId: 'c' })))
      .not.toBe(computePayloadHash(base({ providerId: 'a', externalTransactionId: 'bc' })));
  });

  test('referência ausente e string vazia não colidem', () => {
    expect(computePayloadHash(base({ referenceExternalTransactionId: '' })))
      .not.toBe(computePayloadHash(base()));
  });
});