import { createHash } from 'node:crypto';
import type { Money } from '../domain/money';

export interface PayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * Hash do payload de uma transação, usado para distinguir REPLAY de CONFLITO de idempotência.
 *
 *  - SHA-256 de um array JSON de posições FIXAS (sem depender da ordem das chaves do objeto);
 *  - o valor entra NORMALIZADO (escala 2): "25" e "25.00" geram o mesmo hash;
 *  - a Idempotency-Key NÃO entra: ela identifica a requisição, não o seu conteúdo;
 *  - o prefixo de versão permite evoluir o algoritmo sem confundir hashes antigos.
 */
export function computePayloadHash(f: PayloadFields): string {
  const { amount, currency } = f.money.toJSON();
  const canonical = JSON.stringify([
    'v1',
    f.providerId,
    f.externalTransactionId,
    f.playerId,
    f.walletId,
    f.roundId,
    f.gameId,
    f.kind,
    amount,
    currency,
    f.referenceExternalTransactionId ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}