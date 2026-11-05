import { randomUUID } from 'node:crypto';

export interface MoneyJson { amount: string; currency: string }

export interface ApiResult<T = any> {
  http: number;
  body: T;
}

export interface BetInput {
  walletId: string;
  playerId: string;
  amount: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  roundId?: string;
  kind?: 'BET' | 'WIN' | 'LOSS';
  currency?: string;
}

export const PROVIDER_ID = 'provider-test';

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { http: res.status, body: parsed };
  }

  /** Cada chamada cria um jogador novo: os testes nunca compartilham dados nem precisam de limpeza. */
  async createWallet(initialBalance: string, currency = 'BRL') {
    const playerId = randomUUID();
    const res = await this.call('POST', '/wallets', {
      playerId,
      initialBalance: { amount: initialBalance, currency },
    });
    if (res.http >= 300) {
      throw new Error(`POST /wallets -> ${res.http} ${JSON.stringify(res.body)}`);
    }
    return { walletId: res.body.id as string, playerId };
  }

  getWallet(walletId: string) {
    return this.call('GET', `/wallets/${walletId}`);
  }

  submit(input: BetInput): Promise<ApiResult> {
    const externalTransactionId = input.externalTransactionId ?? `txn-${randomUUID()}`;
    const key = input.idempotencyKey ?? `${PROVIDER_ID}:${externalTransactionId}`;
    return this.call(
      'POST',
      '/wagering/transactions',
      {
        providerId: PROVIDER_ID,
        externalTransactionId,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId ?? 'round-1',
        gameId: 'game-test',
        kind: input.kind ?? 'BET',
        money: { amount: input.amount, currency: input.currency ?? 'BRL' },
      },
      { 'Idempotency-Key': key },
    );
  }
}