import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startApp, type TestApp } from './support/app';
import { assertBalanceMatchesLedger, countTransactions, ledgerOf } from './support/db';
import { isUuid } from '../src/application/commands';

/**
 * Contrato HTTP: status, formato das respostas e erros, contra a aplicação REAL e o Postgres REAL.
 * Pré-requisito: `docker compose up -d` e `bun run db:up`.
 */
let app: TestApp;
const touched: string[] = [];
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });
afterEach(async () => { for (const id of touched.splice(0)) await assertBalanceMatchesLedger(id); });

interface Res { http: number; body: any; headers: Headers }

async function call(method: string, path: string, opts: { json?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await fetch(app.baseUrl + path, {
    method,
    headers: { ...(opts.json !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.raw ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json)),
  });
  const text = await res.text();
  return { http: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

async function newWallet(initial = '100.00') {
  const playerId = `player-${randomUUID()}`;
  const res = await call('POST', '/wallets', { json: { playerId, initialBalance: { amount: initial, currency: 'BRL' } } });
  expect(res.http).toBe(201);
  touched.push(res.body.id);
  return { id: res.body.id as string, playerId };
}

function tx(w: { id: string; playerId: string }, over: Record<string, unknown> = {}) {
  const externalTransactionId = `ext-${randomUUID()}`;
  return {
    providerId: 'prov-http', externalTransactionId, playerId: w.playerId, walletId: w.id, roundId: 'r-1', gameId: 'g-1',
    kind: 'BET', money: { amount: '10.00', currency: 'BRL' }, ...over,
  };
}
// key === null significa "sem o header" (undefined acionaria o valor padrão do parâmetro)
const submit = (body: unknown, key: string | null = `k-${randomUUID()}`) =>
  call('POST', '/wagering/transactions', { json: body, headers: key === null ? {} : { 'Idempotency-Key': key } });

describe('POST /wallets', () => {
  test('201 com {id, playerId, balance, version}', async () => {
    const playerId = `player-${randomUUID()}`;
    const res = await call('POST', '/wallets', { json: { playerId, initialBalance: { amount: '1000', currency: 'BRL' } } });
    touched.push(res.body.id);
    expect(res.http).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['balance', 'id', 'playerId', 'version']);
    expect(isUuid(res.body.id)).toBe(true);
    expect(res.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
  });

  test('saldo inicial zero é aceito e não gera lançamento', async () => {
    const w = await newWallet('0.00');
    expect(await ledgerOf(w.id)).toHaveLength(0);
  });

  test('409 WALLET_ALREADY_EXISTS para o mesmo jogador e moeda', async () => {
    const w = await newWallet('50.00');
    const dup = await call('POST', '/wallets', { json: { playerId: w.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } } });
    expect(dup.http).toBe(409);
    expect(dup.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    ['saldo como number JSON', { playerId: 'p', initialBalance: { amount: 100, currency: 'BRL' } }],
    ['sem playerId', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['saldo negativo', { playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    ['corpo vazio', {}],
  ])('400 INVALID_REQUEST: %s', async (_label, json) => {
    const res = await call('POST', '/wallets', { json });
    expect(res.http).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  test('400 INVALID_REQUEST para JSON malformado', async () => {
    const res = await call('POST', '/wallets', { raw: '{"playerId": ' });
    expect(res.http).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });
});

describe('GET /wallets/:id', () => {
  test('200 com o formato da wallet', async () => {
    const w = await newWallet('75.00');
    const res = await call('GET', `/wallets/${w.id}`);
    expect(res.http).toBe(200);
    expect(res.body).toEqual({ id: w.id, playerId: w.playerId, balance: { amount: '75.00', currency: 'BRL' }, version: 1 });
  });

  test('404 para UUID inexistente e para id que nem é UUID (sem 500 do Postgres)', async () => {
    for (const id of [randomUUID(), 'nao-e-uuid', '123']) {
      const res = await call('GET', `/wallets/${id}`);
      expect(res.http).toBe(404);
      expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
    }
  });

  test('rota inexistente: 404 NOT_FOUND no mesmo formato de erro', async () => {
    const res = await call('GET', '/nao-existe');
    expect(res.http).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'route not found' } });
  });
});

describe('POST /wagering/transactions: status HTTP', () => {
    test('REFUND de BET PROCESSED via HTTP: 201 e credita de volta', async () => {
    const w = await newWallet('100.00');
    const betExt = `ext-bet-${randomUUID()}`;
    const bet = await submit(tx(w, { externalTransactionId: betExt }));
    expect(bet.http).toBe(201);
    expect(bet.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const refund = await submit(tx(w, { kind: 'REFUND', externalTransactionId: `ext-ref-${randomUUID()}`, referenceExternalTransactionId: betExt }));
    expect(refund.http).toBe(201);
    expect(refund.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await ledgerOf(w.id)).toHaveLength(3); // OPENING, BET, REFUND
  });

  test('REFUND com referência inexistente: 202 e o corpo NÃO traz balance', async () => {
    const w = await newWallet('100.00');
    const res = await submit(tx(w, { kind: 'REFUND', referenceExternalTransactionId: `ext-${randomUUID()}` }));
    expect(res.http).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect('balance' in res.body).toBe(false);
  });

  test('ROLLBACK de WIN via HTTP: 201 e debita o inverso', async () => {
    const w = await newWallet('100.00');
    const winExt = `ext-win-${randomUUID()}`;
    const win = await submit(tx(w, { kind: 'WIN', externalTransactionId: winExt }));
    expect(win.http).toBe(201);
    expect(win.body.balance).toEqual({ amount: '110.00', currency: 'BRL' });

    const rollback = await submit(tx(w, { kind: 'ROLLBACK', externalTransactionId: `ext-rb-${randomUUID()}`, referenceExternalTransactionId: winExt }));
    expect(rollback.http).toBe(201);
    expect(rollback.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  test('reversão com referência de kind inválido: 422 com failureCode', async () => {
    const w = await newWallet('100.00');
    const winExt = `ext-win-${randomUUID()}`;
    await submit(tx(w, { kind: 'WIN', externalTransactionId: winExt }));
    const bad = await submit(tx(w, { kind: 'REFUND', externalTransactionId: `ext-ref-${randomUUID()}`, referenceExternalTransactionId: winExt }));
    expect(bad.http).toBe(422);
    expect(bad.body).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });
  });
});

describe('POST /wagering/transactions: validação e a Idempotency-Key', () => {
  test('400 se o header Idempotency-Key faltar ou estiver vazio', async () => {
    const w = await newWallet('100.00');
    for (const key of [null, '', '   ']) {
      const res = await submit(tx(w), key);
      expect(res.http).toBe(400);
      expect(res.body.error.details).toEqual(['Idempotency-Key header is required']);
    }
    expect(await countTransactions(w.id, { kind: 'BET' })).toBe(0);
  });

  test.each([
    ['valor como number JSON', { money: { amount: 10, currency: 'BRL' } }],
    ['valor com 3 casas', { money: { amount: '1.234', currency: 'BRL' } }],
    ['OPENING não pode ser submetido', { kind: 'OPENING' }],
    ['kind desconhecido', { kind: 'JACKPOT' }],
    ['walletId que não é UUID', { walletId: 'abc' }],
    ['BET com referência', { referenceExternalTransactionId: 'x' }],
  ])('400: %s', async (_label, over) => {
    const w = await newWallet('100.00');
    const res = await submit(tx(w, over));
    expect(res.http).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(await countTransactions(w.id, { kind: 'BET' })).toBe(0);
  });

  test('SEGURANÇA: um idempotencyKey no CORPO é ignorado; só vale o header', async () => {
    const w = await newWallet('100.00');
    const body = tx(w);
    const first = await submit({ ...body, idempotencyKey: 'SPOOF' }, `k-${randomUUID()}`);
    expect(first.http).toBe(201);
    // mesmo externalTransactionId, header DIFERENTE, mesmo "SPOOF" no corpo: se o corpo valesse, seria replay (200)
    const second = await submit({ ...body, idempotencyKey: 'SPOOF' }, `k-${randomUUID()}`);
    expect(second.http).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('o nome do header não diferencia maiúsculas de minúsculas', async () => {
    const w = await newWallet('100.00');
    const res = await call('POST', '/wagering/transactions', { json: tx(w), headers: { 'idempotency-key': `k-${randomUUID()}` } });
    expect(res.http).toBe(201);
  });
});