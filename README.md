# Como rodar
docker compose up -d
bun install
bun run db:up
bun run start

# Testes
bun run test:unit && bun run test:integration && bun run test:e2e
bun test test/outbox-events.test.ts test/outbox-relay.test.ts test/reversals.test.ts

# Status
Implementado: BET/WIN/LOSS/REFUND/ROLLBACK, idempotência, outbox transacional,
relay, worker de PENDING_REFERENCE, concorrência real testada.
Não implementado (ver ARCHITECTURE.md): SQS real (publisher/consumer/inbox/DLQ),
ledger paginado, reconciliação, /health/ready, métricas, logs JSON,
2 GETs de consulta de transação, testes multi-instância.