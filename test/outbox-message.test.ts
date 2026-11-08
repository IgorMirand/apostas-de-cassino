import { describe, expect, test } from 'bun:test';
import { OutboxMessage, outboxBackoffMs } from '../src/domain/outbox-message';
import { WalletBalanceChanged } from '../src/domain/events/wallet-balance-changed';
import { Wallet } from '../src/domain/wallet';
import { InvalidTransactionStateError } from '../src/domain/errors';
import { brl, T0, T1 } from './support/builders';

function message(): OutboxMessage {
  const wallet = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('100.00'), at: T0 });
  const entry = wallet.debit({ entryId: 'e-1', transactionId: 'tx-1', money: brl('30.00'), at: T1 });
  return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { eventId: 'evt-1', correlationId: 'c', occurredAt: T1 }));
}
const at = (ms: number) => new Date(T1.getTime() + ms);

describe('OutboxMessage.enqueue', () => {
  test('o id da mensagem É o eventId, e o payload é o envelope serializado', () => {
    const m = message();
    expect(m.id).toBe('evt-1');
    expect(m.aggregateId).toBe('w-1');
    expect(m.eventType).toBe('WalletBalanceChanged');
    expect(m.payload).toMatchObject({ eventId: 'evt-1', eventType: 'WalletBalanceChanged', version: 1 });
    expect(m.occurredAt).toBe(T1);
  });

  test('nasce pendente, sem tentativas e já elegível para publicação', () => {
    const m = message();
    expect(m.isPending()).toBe(true);
    expect(m.attempts).toBe(0);
    expect(m.publishedAt).toBeUndefined();
    expect(m.isDue(T1)).toBe(true);
  });
});

describe('isDue', () => {
  test('só quando a hora da próxima tentativa chegou', () => {
    const m = message();
    m.scheduleRetry(T1); // próxima tentativa em T1 + 1s
    expect(m.isDue(at(999))).toBe(false);
    expect(m.isDue(at(1000))).toBe(true);
    expect(m.isDue(at(5000))).toBe(true);
  });

  test('uma mensagem publicada nunca está elegível', () => {
    const m = message();
    m.markPublished(at(10));
    expect(m.isPending()).toBe(false);
    expect(m.isDue(at(999_999))).toBe(false);
    expect(m.publishedAt).toEqual(at(10));
  });
});

describe('scheduleRetry e backoff exponencial', () => {
  test('cada falha conta uma tentativa e dobra a espera (1s, 2s, 4s, 8s)', () => {
    const m = message();
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      m.scheduleRetry(T1);
      waits.push(m.nextAttemptAt!.getTime() - T1.getTime());
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
    expect(m.attempts).toBe(4);
  });

  test('a espera tem teto de 5 minutos', () => {
    expect(outboxBackoffMs(1)).toBe(1_000);
    expect(outboxBackoffMs(9)).toBe(256_000);
    expect(outboxBackoffMs(10)).toBe(300_000);
    expect(outboxBackoffMs(500)).toBe(300_000);
  });

  test('a espera parte do instante da FALHA, não do instante de criação', () => {
    const m = message();
    m.scheduleRetry(at(60_000));
    expect(m.nextAttemptAt).toEqual(at(61_000));
  });
});

describe('estados', () => {
  test('uma mensagem publicada não aceita mais transições', () => {
    const m = message();
    m.markPublished(at(1));
    expect(() => m.markPublished(at(2))).toThrow(InvalidTransactionStateError);
    expect(() => m.scheduleRetry(at(2))).toThrow(InvalidTransactionStateError);
    expect(m.publishedAt).toEqual(at(1)); // a tentativa inválida não corrompe
  });

  test('rehydrate reconstrói o estado como veio do banco', () => {
    const m = OutboxMessage.rehydrate({
      id: 'e', aggregateId: 'a', eventType: 'T', payload: { x: 1 }, occurredAt: T0, attempts: 3, nextAttemptAt: T1, publishedAt: undefined as never,
    });
    expect(m.attempts).toBe(3);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(at(-1))).toBe(false);
  });
});