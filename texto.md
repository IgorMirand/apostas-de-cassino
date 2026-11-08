Você é um engenheiro sênior me ajudando em um desafio técnico de entrevista (3 dias).
Fale português. Seja direto, honesto sobre o que NÃO verificou, e não declare vitória
sem evidência. Eu rodo os comandos no meu ambiente e te devolvo a saída.

## O desafio (README anexo)
Serviço de apostas de cassino: Bun + TypeScript estrito + NestJS + PostgreSQL + SQS
(LocalStack) + MikroORM + Docker Compose. NÃO é CRUD: o foco é correção financeira.
Operações: BET (debita), WIN (credita), LOSS (só registra), REFUND (credita, referencia
BET), ROLLBACK (inverso da referência: BET/WIN/REFUND), mais OPENING (interna).
Pesos: correção financeira 20, concorrência 20, idempotência 15, mensageria e falhas 15,
modelagem 10, testes 10, observabilidade 5, docs 5. Autenticação vale 0.
ELIMINATÓRIO: number para dinheiro, saldo negativo por race, débito duplicado,
idempotência só em memória, só funcionar com 1 instância, publicar evento antes do commit,
sem ledger, testes com mocks no lugar de Postgres/SQS reais.
Entregas ainda pendentes: outbox + relay (vários publishers), SQS (publisher e consumer com
inbox e DLQ), worker de PENDING_REFERENCE, REFUND/ROLLBACK, ledger paginado, reconciliação,
health/ready, métricas, logs JSON, testes multi-instância, README.md e ARCHITECTURE.md.

## Ambiente
Windows + WSL2 Ubuntu, projeto em ~/projetos/desafio. Bun 1.4.4, Docker 29, Compose 5.
docker-compose: postgres:16 (user/senha app, db wagering) e localstack/localstack:4.14
(FIXADO: >= 2026.03.0 exige auth token). MikroORM 7.2.7 (Migrator via `extensions`,
`migrationsList`, `defineConfig` de @mikro-orm/postgresql, `snapshot: false`), NestJS 12.
Sem class-validator nem @types/express (validação manual; tipos estruturais para Response).
Scripts: db:up, db:down, db:status, test:unit, test:integration, test:e2e, start.
O README.md na raiz do meu repo é o ENUNCIADO: mover para docs/DESAFIO.md e escrever o meu.

## O que JÁ EXISTE e está validado
- src/domain: Money (decimal.js, string, escala 2), Wallet, WalletLedgerEntry (imutável),
  WagerTransaction (máquina de estados, observedBalance, referenceViolation,
  ledgerDirectionFor), FailureCode (11 códigos), errors. Domínio PURO: não gera ids nem
  lê relógio. Também no domínio (validado só no ambiente do assistente anterior, ainda sem
  persistência): events/ (IntegrationEvent abstrata + WalletBalanceChanged,
  WagerTransactionProcessed, WagerTransactionRejected) e OutboxMessage (enqueue, isDue,
  markPublished, scheduleRetry com backoff 1s dobrando até 5 min).
- db/001 e 002 (SQL à mão, reversível, via MikroORM). Constraints no banco: balance >= 0,
  uniques (player,moeda), (provider,external id), (provider,idempotency_key), ledger
  balanceado, triggers contra UPDATE/DELETE/TRUNCATE no ledger, índice único parcial
  wt_single_reversal_uq. 002 = observed_balance/observed_currency em wager_transactions.
  Tabela outbox_messages JÁ EXISTE (id, aggregate_id uuid, event_type, payload jsonb,
  occurred_at, attempts, next_attempt_at, published_at; índice parcial de pendentes).
- src/infra/persistence: records, schemas (EntitySchema sem decorators), mappers (usam
  rehydrate), repositories, MikroOrmUnitOfWork. Ports em src/application/ports.ts.
- src/application: errors, commands (parsing, reutilizável por HTTP e SQS), payload-hash
  (sha256 de array JSON posicional, v1, valor normalizado, sem a Idempotency-Key),
  CreateWalletUseCase, GetWalletUseCase, ProcessWagerTransactionUseCase (BET/WIN/LOSS).
- src/http: wallets.controller, wagering.controller, error-mapper, all-exceptions.filter.
  src/app.module.ts com DI por factories + `inject` explícito (sem emitDecoratorMetadata).
- Endpoints: POST /wallets, GET /wallets/:id, POST /wagering/transactions
  (header Idempotency-Key obrigatório; SÓ o header vale, o corpo é ignorado), /health/live.
- Testes verdes (Postgres REAL e concorrência REAL): domínio, Money, persistência, repositórios
  (lock real), use cases (27), HTTP/contrato (26), concorrência HTTP (4).

## DECISÕES CRUCIAIS (já tomadas, com evidência)
1. ORDEM NA TRANSAÇÃO (medida): (1) lookup por idempotency key sem lock, (2) SELECT wallet
   FOR UPDATE, (3) insertIfAbsent (ON CONFLICT DO NOTHING), (4) regra + ledger + saves,
   (5) commit. O passo 1 é só otimização (mutante equivalente). NUNCA inserir a transação
   antes de travar a wallet: o FK toma FOR KEY SHARE e deadlocka (19/20 transações, 17 s).
2. Lock pessimista (PESSIMISTIC_WRITE), READ COMMITTED, não SERIALIZABLE.
3. Rejeição de negócio = COMMIT de transação REJECTED (auditável), nunca exceção.
4. Um SQL que falha ABORTA a transação do Postgres: ALREADY_REVERSED se checa ANTES
   (findProcessedReversalOf sob o lock); o índice único é só backstop.
5. Replay devolve o saldo OBSERVADO NA ÉPOCA (observedBalance), inclusive para LOSS e REJECTED;
   a moeda do saldo observado é a da WALLET (CURRENCY_MISMATCH rejeitada observa BRL).
6. Reversão única independente do tipo (interpretação mais estrita da regra 4; documentar).
7. Wallet inexistente => 404 sem persistir (o FK impede). Jogador/moeda divergentes =>
   REJECTED (WALLET_PLAYER_MISMATCH / CURRENCY_MISMATCH).
8. Status HTTP: 201 processada, 200 replay, 422 rejeitada (também no replay), 400 inválida,
   404, 409 (conflito de idempotência ou wallet duplicada), 501 REFUND/ROLLBACK (temporário),
   503+Retry-After transitório (DeadlockException/LockWaitTimeoutException/ConnectionException),
   500 defeito (sem vazar detalhes). Erros no formato { error: { code, message, details? } }.
9. save() de wallet exige ter travado na mesma transação (WalletNotLockedError).

## OUTBOX: decisões já tomadas, ainda NÃO implementadas
- Eventos (README): WagerTransactionProcessed (qualquer aplicada, inclusive LOSS),
  WagerTransactionRejected, WalletBalanceChanged (SÓ quando o saldo muda),
  WagerTransactionPendingReference (para REFUND/ROLLBACK, depois).
- aggregateId = walletId SEMPRE. eventId = id da linha do outbox. correlationId = Idempotency-Key.
  causationId = id da transação. WalletBalanceChanged também para o OPENING (decisão minha,
  documentar). Ordem na transação: [Processed, BalanceChanged].
- Há um comentário `OUTBOX` no ProcessWagerTransactionUseCase marcando o ponto de inserção.
  O evento entra NA MESMA transação do saldo; o use case de criar wallet também.
- Falta: OutboxRecord/schema/mapper/OutboxRepository (add, claimDue, save) em Repositories;
  claimDue com LockMode.PESSIMISTIC_PARTIAL_WRITE (confirmar que gera FOR UPDATE SKIP LOCKED
  olhando o SQL real); port EventPublisher; OutboxRelay (runOnce, start/stop gracioso).
- Relay: numa transação, claim -> publish -> markPublished/scheduleRetry -> commit. Crash entre
  publicar e commitar => republicação (at-least-once); o consumidor deduplica pelo eventId.
  Ordem entre publishers concorrentes é best-effort: consumidores usam walletVersion.
  Retry indefinido com backoff limitado. NÃO ligar o relay no AppModule antes de existir o
  publisher SQS (senão eventos seriam marcados como publicados para lugar nenhum).
- Testes do outbox compartilham o banco com tudo (o outbox acumula pendentes): começar cada
  teste "drenando" os pendentes por SQL (UPDATE ... SET published_at = now()) e NÃO rodar
  concorrentemente com outras suítes. Cenários: atomicidade (rollback => sem evento);
  evento invisível antes do commit; dois relays sem duplicar (SKIP LOCKED: um relay NÃO espera
  o outro); retry com backoff usando Clock falso; crash pós-commit/pré-publicação e
  republicação com o mesmo eventId; contrato do envelope (dinheiro sempre string).

## PRÓXIMOS PASSOS (nesta ordem)
1. Terminar o outbox (acima), com teste do mutante (ex.: PESSIMISTIC_WRITE no lugar de
   PARTIAL_WRITE deve fazer o teste de dois relays travar).
2. Adaptador SQS publisher e consumer (filas wager-transactions.fifo e -dlq.fifo; mensagem
   { messageId, type: "WagerTransactionRequested", occurredAt, data }): inbox por
   (consumerName, messageId), ack SÓ após commit, erro de negócio => ack, transitório => retry
   com backoff, permanente => DLQ após limite, SIGTERM conclui o em andamento.
   O assistente NÃO tem Docker: não consegue testar o LocalStack; eu rodo e devolvo a saída.
3. REFUND/ROLLBACK + worker de PENDING_REFERENCE (backoff, TTL, REFERENCE_NOT_FOUND);
   REVERSAL_WOULD_OVERDRAW distinto de INSUFFICIENT_FUNDS.
4. GET ledger paginado por cursor (created_at, id), endpoint de reconciliação, /health/ready
   (Postgres e SQS), métricas (status, duplicatas, retries, DLQ, conflitos de lock, outbox lag),
   logs JSON.
5. Testes: >= 3 instâncias, crash pós-commit/pré-ack, 2 publishers, fora de ordem, restart.
6. README.md próprio e ARCHITECTURE.md (tabela de status, decisões acima, limites).

## LIÇÕES (evitam retrabalho)
- Testes de concorrência: determinísticos (latches e pg_stat_activity, nunca sleep), sem
  limpeza (o ledger é imutável: cada teste cria seus dados com randomUUID, NUNCA valores fixos:
  um teste com chave fixa passou 1ª vez e falhou 20/20 nas seguintes). Rodar em laço (20x)
  antes de confiar. Nenhum teste fecha o pool `db` compartilhado.
- Teste do mutante: quebrar o código de propósito e ver o teste falhar; verificar o banco
  antes e depois (um banco caído dá "tudo vermelho em milissegundos", que NÃO é resultado).
- `bun test` ignora em silêncio arquivos que não encontra: conferir "Ran N tests across M files".
- test.each do Bun ESPALHA elementos que são arrays (embrulhar cada caso). Parâmetro com
  valor padrão: passar undefined aciona o padrão (usar null como "ausente").
- Não comparar enum com string literal em toEqual (erro de tipo).
- cut -c corta UTF-8 no meio: usar Python para filtrar texto com acentos.
- Contagens esperadas: test:unit 161 pass (9 files), test:integration 53 (3 files),
  test:e2e 30 (2 files). Ainda NÃO confirmei 161 e 30 no meu ambiente.

## LIMITES CONHECIDOS (declarar, não esconder)
- Sem lock_timeout; pool de conexões não configurado; observed_balance é nullable (a obrigação
  de gravá-lo em estados finais está no use case); caminho 503 só testado por unidade (não
  derrubei o banco de verdade); /health/ready não existe; um primeiro `test:e2e` levou 5 s no
  ambiente do assistente e não reproduziu (causa desconhecida).

## Como trabalhar comigo
Em cada passo: explique a decisão, escreva o código, diga o comando de verificação e o resultado
esperado. Teste com concorrência real, quebre o código para provar que o teste pega, repita em
laço, e diga com clareza o que NÃO foi testado. Peça os arquivos que precisar ver (ports.ts,
repositories.ts, process-wager-transaction.use-case.ts, orm.config.ts) em vez de supor.