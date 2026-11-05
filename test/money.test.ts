import { describe, expect, test } from 'bun:test';
import { Money, type MoneyProps } from '../src/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  test('normaliza para escala 2', () => {
    expect(brl('25').toJSON().amount).toBe('25.00');
    expect(brl('25.5').toJSON().amount).toBe('25.50');
    expect(brl('25.00').toJSON().amount).toBe('25.00');
  });

  test.each([
    ['vazia', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['notação científica', '1e3'],
    ['3 casas decimais', '1.234'],
    ['negativo', '-5.00'],
    ['com sinal positivo', '+5.00'],
    ['vírgula', '1,00'],
    ['sem parte inteira', '.50'],
    ['ponto sem decimais', '5.'],
    ['com espaços', ' 5.00 '],
  ])('rejeita amount inválido: %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(['', 'brl', 'BR', 'BRLL', '123'])('rejeita moeda inválida: "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('aritmética', () => {
  test('é exata, sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('0.30').subtract(brl('0.10')).toJSON().amount).toBe('0.20');
  });

  test('valores grandes mantêm precisão', () => {
    const big = brl('999999999999999.99').add(brl('0.01'));
    expect(big.toJSON().amount).toBe('1000000000000000.00');
  });

  test('subtract pode ficar negativo e negate inverte o sinal', () => {
    const result = brl('10.00').subtract(brl('25.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-15.00');
    expect(result.negate().toJSON().amount).toBe('15.00');
  });

  test('é imutável', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    a.subtract(brl('1.00'));
    a.negate();
    expect(a.toJSON().amount).toBe('10.00');
  });
});

describe('consultas', () => {
  test('isZero, isPositive, isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  test('isLessThan e equals', () => {
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('2.00').isLessThan(brl('2.00'))).toBe(false);
    expect(brl('2').equals(brl('2.00'))).toBe(true);
  });
});

describe('conflito de moeda', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('add, subtract e isLessThan lançam erro de domínio', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('equals devolve false em vez de lançar', () => {
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});

describe('serialização', () => {
  test('toJSON devolve MoneyProps e toString é legível', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(JSON.stringify({ m: brl('25') })).toBe('{"m":{"amount":"25.00","currency":"BRL"}}');
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});

describe('validações adicionais', () => {
  test('rejeita Money nulo', () => {
    expect(() =>
      Money.from(null as unknown as MoneyProps),
    ).toThrow(InvalidMoneyError);
  });

  test('rejeita moeda que não é string', () => {
    expect(() =>
      Money.from({
        amount: '10.00',
        currency: 123 as unknown as string,
      }),
    ).toThrow(InvalidMoneyError);
  });

  test('mantém precisão em valores muito grandes', () => {
    const result = brl('999999999999999999999999.99')
      .add(brl('0.01'));

    expect(result.toJSON().amount)
      .toBe('1000000000000000000000000.00');
  });

  test('zero continua zero após negação', () => {
    expect(Money.zero('BRL').negate().isZero()).toBe(true);
  });
});