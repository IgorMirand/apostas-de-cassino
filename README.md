# Serviço de Apostas de Cassino

Serviço financeiro de apostas: BET, WIN, LOSS, REFUND, ROLLBACK, com
idempotência, outbox transacional e concorrência real sobre PostgreSQL.

Decisões de arquitetura, trade-offs e limites conhecidos: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Como rodar

```bash
docker compose up -d
bun install
bun run db:up
bun run start
```

A API sobe em `http://localhost:3000` (porta configurável via `PORT`).

## Exemplo de uso

```bash
# criar wallet
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# apostar (Idempotency-Key é obrigatório)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: prov:ext-1' \
  -d '{"providerId":"prov","externalTransactionId":"ext-1","playerId":"player-1",
       "walletId":"<id da wallet>","roundId":"r-1","gameId":"g-1","kind":"BET",
       "money":{"amount":"10.00","currency":"BRL"}}'
```

## Testes

```bash
bun run test:unit && bun run test:integration && bun run test:e2e
bun test test/outbox-events.test.ts test/outbox-relay.test.ts test/reversals.test.ts
```

## Status

**Implementado e testado contra PostgreSQL real** (concorrência, idempotência,
mutantes): BET/WIN/LOSS/REFUND/ROLLBACK, outbox transacional, relay com
`SKIP LOCKED`, worker de `PENDING_REFERENCE` (ligado ao ciclo de vida da
aplicação, inicia e para junto com o processo).

**Não implementado** (decisões e limites documentados em [ARCHITECTURE.md](./ARCHITECTURE.md)):
SQS real (publisher/consumer/inbox/DLQ — o relay e o outbox estão prontos
para isso, mas o publisher não foi escrito), ledger paginado, endpoint de
reconciliação, `/health/ready`, métricas, logs estruturados em JSON, os
dois endpoints `GET` de consulta de transação, testes com múltiplas
instâncias do processo.