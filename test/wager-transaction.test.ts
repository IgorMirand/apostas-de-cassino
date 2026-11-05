import { describe, expect, test } from 'bun:test';
import {
  INTERNAL_PROVIDER_ID, WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S,
} from '../src/domain/wager-transaction';
import { FailureCode } from '../src/domain/failure-code';
import { LedgerDirection } from '../src/domain/wallet-ledger-entry';
import { InvalidTransactionError, InvalidTransactionStateError } from '../src/domain/errors';
import { brl, makeProcessed, makeTx, T0, T1 } from './support/builders';

describe('WagerTransaction.create', () => {
  test('nasce PENDING, sem referência resolvida, falha ou processedAt', () => {
    const tx = makeTx();
    expect(tx.status).toBe(S.Pending);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.pendingAttempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING não pode ser submetido (nem se burlar o tipo, como faria um JSON)', () => {
    expect(() => makeTx({ kind: 'OPENING' as never })).toThrow(InvalidTransactionError);
  });

  test('kind desconhecido é rejeitado', () => {
    expect(() => makeTx({ kind: 'JACKPOT' as never })).toThrow(InvalidTransactionError);
  });

  test.each([K.Refund, K.Rollback] as const)('%s exige referência', (kind) => {
    expect(() =>
      WagerTransaction.create({
        id: 't', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h',
        walletId: 'w', playerId: 'pl', roundId: 'r', gameId: 'g', kind, money: brl('10.00'), createdAt: T0,
      }),
    ).toThrow(InvalidTransactionError);
  });

  test.each([K.Bet, K.Win, K.Loss] as const)('%s não pode carregar referência', (kind) => {
    expect(() =>
      WagerTransaction.create({
        id: 't', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h',
        walletId: 'w', playerId: 'pl', roundId: 'r', gameId: 'g', kind, money: brl('10.00'),
        referenceExternalTransactionId: 'x', createdAt: T0,
      }),
    ).toThrow(InvalidTransactionError);
  });

  test('valor zero: permitido só em LOSS', () => {
    expect(makeTx({ kind: K.Loss, amount: '0.00' }).money.isZero()).toBe(true);
    for (const kind of [K.Bet, K.Win, K.Refund, K.Rollback] as const) {
      expect(() => makeTx({ kind, amount: '0.00' })).toThrow(InvalidTransactionError);
    }
  });
});

describe('WagerTransaction.opening', () => {
  test('é interna, nasce PROCESSED e tem chave determinística por wallet', () => {
    const tx = WagerTransaction.opening({ id: 't', walletId: 'w-1', playerId: 'p-1', money: brl('1000.00'), createdAt: T0 });
    expect(tx.kind).toBe(K.Opening);
    expect(tx.status).toBe(S.Processed);
    expect(tx.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(tx.idempotencyKey).toBe('opening:w-1');
    expect(tx.processedAt).toBe(T0);
    expect(tx.roundId).toBeUndefined();
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('saldo inicial zero não gera OPENING', () => {
    expect(() => WagerTransaction.opening({ id: 't', walletId: 'w', playerId: 'p', money: brl('0.00'), createdAt: T0 }))
      .toThrow(InvalidTransactionError);
  });
});

describe('transições', () => {
  test('PENDING → PROCESSED (BET)', () => {
    const tx = makeTx();
    tx.markProcessed(undefined, T1);
    expect(tx.status).toBe(S.Processed);
    expect(tx.processedAt).toBe(T1);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED guarda o failureCode e não tem processedAt', () => {
    const tx = makeTx();
    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → FAILED', () => {
    const tx = makeTx();
    tx.fail(FailureCode.InternalError);
    expect(tx.status).toBe(S.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test('REFUND: PENDING → PENDING_REFERENCE (conta tentativas) → PROCESSED com a referência resolvida', () => {
    const tx = makeTx({ kind: K.Refund });
    tx.markPendingReference(T1);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.pendingAttempts).toBe(1);
    expect(tx.pendingNextAttemptAt).toBe(T1);
    expect(tx.isTerminal()).toBe(false);

    const later = new Date('2026-11-05T12:01:00.000Z');
    tx.markPendingReference(later); // reprocessou e a referência continua ausente
    expect(tx.pendingAttempts).toBe(2);
    expect(tx.pendingNextAttemptAt).toBe(later);

    tx.markProcessed('ref-internal-id', later);
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBe('ref-internal-id');
    expect(tx.pendingNextAttemptAt).toBeUndefined();
  });

  test('PENDING_REFERENCE → REJECTED (esgotou as tentativas)', () => {
    const tx = makeTx({ kind: K.Rollback });
    tx.markPendingReference(T1);
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('só REFUND/ROLLBACK esperam referência', () => {
    expect(() => makeTx().markPendingReference(T1)).toThrow(InvalidTransactionError);
  });

  test('REFUND/ROLLBACK não podem ser PROCESSED sem a referência resolvida; os demais não aceitam uma', () => {
    expect(() => makeTx({ kind: K.Refund }).markProcessed(undefined, T1)).toThrow(InvalidTransactionError);
    expect(() => makeTx({ kind: K.Bet }).markProcessed('x', T1)).toThrow(InvalidTransactionError);
  });

  test.each([
    ['markProcessed', (t: WagerTransaction) => t.markProcessed(undefined, T1)],
    ['reject', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ['fail', (t: WagerTransaction) => t.fail(FailureCode.InternalError)],
  ] as const)('estados terminais não mudam mais: %s', (_name, apply) => {
    const finishers = [
      (t: WagerTransaction) => t.markProcessed(undefined, T1),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds),
      (t: WagerTransaction) => t.fail(FailureCode.InternalError),
    ];
    for (const finish of finishers) {
      const tx = makeTx();
      finish(tx);
      const before = tx.status;
      expect(() => apply(tx)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(before); // a tentativa inválida não corrompe o estado
    }
  });

  test('terminal também recusa markPendingReference', () => {
    const tx = makeTx({ kind: K.Refund });
    tx.reject(FailureCode.ReferenceNotFound);
    expect(() => tx.markPendingReference(T1)).toThrow(InvalidTransactionStateError);
  });
});

describe('rehydrate', () => {
  test('não revalida transições: reconstrói um estado terminal como está', () => {
    const tx = WagerTransaction.rehydrate({
      id: 't', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h',
      walletId: 'w', playerId: 'pl', roundId: 'r', gameId: 'g', kind: K.Bet, money: brl('10.00'),
      status: S.Rejected, failureCode: FailureCode.InsufficientFunds, createdAt: T0, pendingAttempts: 0,
    });
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => tx.reject(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
  });
});

describe('consultas de domínio', () => {
  test('affectsBalance: false só para LOSS', () => {
    expect(makeTx({ kind: K.Loss }).affectsBalance()).toBe(false);
    for (const kind of [K.Bet, K.Win, K.Refund, K.Rollback] as const) {
      expect(makeTx({ kind }).affectsBalance()).toBe(true);
    }
  });

  test('requiresReference: true só para REFUND e ROLLBACK', () => {
    for (const kind of [K.Refund, K.Rollback] as const) expect(makeTx({ kind }).requiresReference()).toBe(true);
    for (const kind of [K.Bet, K.Win, K.Loss] as const) expect(makeTx({ kind }).requiresReference()).toBe(false);
  });

  test('matchesPayload compara o hash', () => {
    const tx = makeTx({ id: 'abc' });
    expect(tx.matchesPayload('hash-abc')).toBe(true);
    expect(tx.matchesPayload('hash-outro')).toBe(false);
  });
});

describe('ledgerDirectionFor', () => {
  test('BET debita; WIN e REFUND creditam', () => {
    expect(makeTx({ kind: K.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(makeTx({ kind: K.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(makeTx({ kind: K.Refund }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK é o inverso da referência', () => {
    const rollback = makeTx({ kind: K.Rollback });
    expect(rollback.ledgerDirectionFor(makeProcessed({ kind: K.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(makeProcessed({ kind: K.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(makeProcessed({ kind: K.Refund }))).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência é erro; LOSS não tem direção', () => {
    expect(() => makeTx({ kind: K.Rollback }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => makeTx({ kind: K.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe('referenceViolation (regras 2, 3 e 5 do README)', () => {
  const refund = () => makeTx({ id: 'rf', kind: K.Refund });
  const rollback = () => makeTx({ id: 'rb', kind: K.Rollback });
  const bet = (o = {}) => makeProcessed({ id: 'bet', kind: K.Bet, ...o });

  test('referência válida: nenhuma violação', () => {
    expect(refund().referenceViolation(bet())).toBeUndefined();
    expect(rollback().referenceViolation(bet())).toBeUndefined();
    expect(rollback().referenceViolation(makeProcessed({ id: 'w', kind: K.Win }))).toBeUndefined();
    expect(rollback().referenceViolation(makeProcessed({ id: 'r', kind: K.Refund }))).toBeUndefined();
  });

  test('REFUND só referencia BET', () => {
    for (const kind of [K.Win, K.Loss, K.Refund, K.Rollback] as const) {
      expect(refund().referenceViolation(makeProcessed({ id: 'x', kind, amount: '80.00' })))
        .toBe(FailureCode.InvalidReferenceKind);
    }
  });

  test('ROLLBACK não referencia LOSS nem outro ROLLBACK', () => {
    for (const kind of [K.Loss, K.Rollback] as const) {
      expect(rollback().referenceViolation(makeProcessed({ id: 'x', kind }))).toBe(FailureCode.InvalidReferenceKind);
    }
  });

  test('provider, player, wallet, moeda e rodada precisam ser os mesmos', () => {
    const cases: Record<string, object> = {
      provider: { providerId: 'outro' },
      player: { playerId: 'outro' },
      wallet: { walletId: 'outra' },
      round: { roundId: 'outra' },
      currency: { currency: 'USD' },
    };
    for (const [name, override] of Object.entries(cases)) {
      expect({ case: name, violation: refund().referenceViolation(bet(override)) })
        .toEqual({ case: name, violation: FailureCode.ReferenceMismatch });
    }
  });

  test('só se reverte transação PROCESSED', () => {
    const rejected = makeTx({ id: 'bet', kind: K.Bet });
    rejected.reject(FailureCode.InsufficientFunds);
    expect(refund().referenceViolation(rejected)).toBe(FailureCode.ReferenceNotProcessed);
    expect(refund().referenceViolation(makeTx({ id: 'bet', kind: K.Bet }))).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('o valor precisa ser IGUAL ao da referência', () => {
    expect(refund().referenceViolation(bet({ amount: '79.99' }))).toBe(FailureCode.AmountMismatch);
    expect(refund().referenceViolation(bet({ amount: '80.01' }))).toBe(FailureCode.AmountMismatch);
  });

  test('perguntar por referência a quem não tem é erro de programação', () => {
    expect(() => makeTx().referenceViolation(bet())).toThrow(InvalidTransactionError);
  });
});