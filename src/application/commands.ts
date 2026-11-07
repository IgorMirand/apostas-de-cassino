import { InvalidMoneyError } from '../domain/errors';
import { Money } from '../domain/money';
import { WagerTransactionKind, type SubmittableKind } from '../domain/wager-transaction';
import { InvalidRequestError } from './errors';

/**
 * Comandos de entrada dos use cases + o parsing de dados NÃO confiáveis (JSON da API ou da fila).
 * Fica na camada de aplicação para que HTTP e SQS validem EXATAMENTE as mesmas regras.
 */

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export interface SubmitTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMITTABLE_KINDS = Object.values(WagerTransactionKind).filter(
  (k): k is SubmittableKind => k !== WagerTransactionKind.Opening,
);

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

class Reader {
  readonly issues: string[] = [];
  constructor(private readonly obj: Record<string, unknown>) {}

  text(field: string, maxLength = 128): string {
    const v = this.obj[field];
    if (typeof v !== 'string' || v.trim() === '') {
      this.issues.push(`${field} must be a non-empty string`);
      return '';
    }
    if (v.length > maxLength) {
      this.issues.push(`${field} must have at most ${maxLength} characters`);
    }
    return v;
  }

  uuid(field: string): string {
    const v = this.obj[field];
    if (!isUuid(v)) {
      this.issues.push(`${field} must be a UUID`);
      return '';
    }
    return v;
  }

  optionalText(field: string, maxLength = 128): string | undefined {
    const v = this.obj[field];
    if (v === undefined || v === null) return undefined;
    return this.text(field, maxLength);
  }

  money(field: string): Money {
    try {
      return Money.from(this.obj[field] as { amount: string; currency: string });
    } catch (e) {
      if (!(e instanceof InvalidMoneyError)) throw e;
      this.issues.push(`${field}: ${e.message}`);
      return Money.zero('BRL'); // placeholder: a requisição será recusada logo abaixo
    }
  }

  kind(field: string): SubmittableKind {
    const v = this.obj[field];
    if (!SUBMITTABLE_KINDS.includes(v as SubmittableKind)) {
      this.issues.push(`${field} must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
      return WagerTransactionKind.Bet;
    }
    return v as SubmittableKind;
  }

  finish(): void {
    if (this.issues.length > 0) throw new InvalidRequestError(this.issues);
  }
}

function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidRequestError(['body must be a JSON object']);
  }
  return raw as Record<string, unknown>;
}

export function parseCreateWalletCommand(raw: unknown): CreateWalletCommand {
  const r = new Reader(asObject(raw));
  const command = { playerId: r.text('playerId'), initialBalance: r.money('initialBalance') };
  r.finish();
  return command;
}

/** `raw` deve conter tudo, inclusive `idempotencyKey` (o adaptador HTTP o copia do header). */
export function parseSubmitTransactionCommand(raw: unknown): SubmitTransactionCommand {
  const r = new Reader(asObject(raw));
  const referenceExternalTransactionId = r.optionalText('referenceExternalTransactionId');
  const command: SubmitTransactionCommand = {
    providerId: r.text('providerId'),
    externalTransactionId: r.text('externalTransactionId'),
    idempotencyKey: r.text('idempotencyKey', 255),
    playerId: r.text('playerId'),
    walletId: r.uuid('walletId'),
    roundId: r.text('roundId'),
    gameId: r.text('gameId'),
    kind: r.kind('kind'),
    money: r.money('money'),
    ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
  };
  r.finish();
  return command;
}