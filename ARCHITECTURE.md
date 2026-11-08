# ARCHITECTURE.md

## Visão geral

Serviço de apostas de cassino. O foco do desafio não é CRUD: é correção
financeira sob concorrência real, com múltiplas instâncias, mensageria
assíncrona e falhas parciais. Autenticação vale 0 pontos e não foi
implementada.

Arquitetura hexagonal (portas e adaptadores), domínio puro:

```
domain  ←  application  ←  infra / http
(puro)     (use cases, ports)   (adaptadores)
```

- **domain**: `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`,
  `OutboxMessage`, eventos de integração. Construtor privado + factories
  (`create`/`from`/`rehydrate`). Nunca gera ids nem lê o relógio — recebe
  de fora (`IdGenerator`, `Clock`). `rehydrate` não revalida transições.
- **application**: use cases, `WagerTransactionApplier` (regra de negócio
  compartilhada entre o caminho HTTP e o worker de reprocessamento),
  `OutboxRelay`, `PendingReferenceWorker`, portas (`ports.ts`), parsing
  de comandos (`commands.ts`, usado tanto por HTTP quanto, no futuro,
  por SQS).
- **infra**: MikroORM (records, schemas sem decorators, mappers,
  repositories, Unit of Work), migrations, `SystemClock`,
  `UuidV7Generator`.
- **http**: controllers, `error-mapper`, filtro de exceções.

## Modelo de dados e garantias no banco

O banco é a fonte final da verdade, não a aplicação:

- `wallets.balance >= 0` (constraint).
- Unicidade: `(player_id, currency)`, `(provider_id, external_transaction_id)`,
  `(provider_id, idempotency_key)`.
- `wallet_ledger_entries` é append-only: triggers bloqueiam
  `UPDATE`/`DELETE`/`TRUNCATE`.
- Índice único parcial `wt_single_reversal_uq`: impede duas reversões
  processadas para a mesma referência, no banco, não só na aplicação.
- `wager_transactions.observed_balance` / `observed_currency` (nullable):
  saldo observado no momento em que a transação foi decidida, usado pelo
  replay idempotente.
- `outbox_messages`: `id uuid PK, aggregate_id uuid NOT NULL, event_type,
  payload jsonb, occurred_at, attempts int CHECK >= 0,
  next_attempt_at NOT NULL DEFAULT now(), published_at`. Índice parcial
  `outbox_pending_idx (next_attempt_at, occurred_at) WHERE published_at
  IS NULL`. Sem FK para `wallets`, de propósito: não queríamos que o
  outbox tomasse lock adicional na wallet.

## Decisões arquiteturais (D1–D17)

| # | Decisão | Justificativa |
|---|---|---|
| D1 | **Ordem fixa dentro da transação**: (1) lookup por idempotency key sem lock, (2) `SELECT wallet ... FOR UPDATE`, (3) `INSERT` da transação com `ON CONFLICT DO NOTHING`, (4) regra de negócio, (5) commit. **Nunca inserir a transação antes de travar a wallet.** | Medido empiricamente: inserir primeiro causa deadlock sob concorrência (o INSERT toma `FOR KEY SHARE` na wallet via FK, que conflita com o `FOR UPDATE` de outra transação concorrente — 19 de 20 transações deadlockaram em teste, 17s). Travar primeiro serializa sem deadlock. |
| D2 | Lock pessimista (`PESSIMISTIC_WRITE`) em `READ COMMITTED`, não `SERIALIZABLE`. | O `FOR UPDATE` na wallet já serializa tudo que toca aquela wallet. `SERIALIZABLE` adicionaria retries por conflito de serialização sem ganho de correção aqui. |
| D3 | Rejeição de regra de negócio é **commit** de uma transação com status `REJECTED`, nunca uma exceção lançada. | Uma exceção desfaria a transação SQL inteira, perdendo o registro auditável da rejeição. |
| D4 | `ALREADY_REVERSED` é checado **antes** do INSERT, sob o lock da wallet (`findProcessedReversalOf`). O índice único parcial do banco é só o backstop. | Um `INSERT` que viola o índice único aborta a transação Postgres inteira; checar antes evita transformar uma regra de negócio em erro 500. |
| D5 | O replay de uma transação idempotente devolve o **saldo observado na época** em que ela foi decidida, não o saldo atual da wallet — inclusive para `LOSS` e `REJECTED`. A moeda do saldo observado é sempre a da wallet. | Requisito do enunciado (idempotência precisa ser perfeitamente replayable, incluindo o estado observado). |
| D6 | **Reversão única, independente do tipo de operação.** Uma vez que uma BET foi revertida (por REFUND ou ROLLBACK), nenhuma outra reversão sobre ela é aceita, seja REFUND ou ROLLBACK. | O enunciado diz literalmente "não pode ser revertida duas vezes pelo mesmo tipo", o que, lido ao pé da letra, permitiria um REFUND e um ROLLBACK sobre a mesma BET — creditando duas vezes e violando a invariante global de não duplicar crédito. Adotamos a leitura mais estrita. Consequência: depois de um `ROLLBACK` sobre um `REFUND`, a `BET` original permanece não revertível. |
| D7 | Wallet inexistente → `404` sem persistir nada (o FK impediria de qualquer forma). Jogador ou moeda divergentes da wallet → `REJECTED` (`WALLET_PLAYER_MISMATCH` / `CURRENCY_MISMATCH`), não erro HTTP. | Distingue erro de requisição (recurso não existe) de rejeição de regra de negócio (recurso existe, operação é inválida para ele). |
| D8 | Tabela de status HTTP fixa (ver abaixo). | Padroniza o contrato entre provedores e o serviço. |
| D9 | `save()` de uma wallet exige que ela tenha sido lida com `findByIdForUpdate` **nesta mesma transação** (`WalletNotLockedError` caso contrário). | Defesa em profundidade: impede escrever saldo de uma wallet que não foi travada, que seria a classe de bug mais perigosa possível aqui. |
| D10 | Mapeamento por `EntitySchema` sem decorators; injeção de dependência por `useFactory` + `inject` explícito, sem `emitDecoratorMetadata`. | O MikroORM é tratado como detalhe de infraestrutura, não vaza para o domínio. `emitDecoratorMetadata` é frágil sob o Bun. |
| D11 | Dinheiro é sempre `string` decimal (`decimal.js`), nunca `number`, do domínio ao banco (`NUMERIC(19,2)`, `runtimeType: 'string'` no schema). | Eliminatório do enunciado: `number` para dinheiro desclassifica. |
| D12 | Parsing e validação de comandos (`commands.ts`) ficam na camada de aplicação, compartilhados entre o adaptador HTTP e, futuramente, o consumidor SQS. | Garante que as duas entradas validam exatamente as mesmas regras. |
| D13 | **Outbox**: `aggregateId` é sempre o id da wallet. `eventId` é o id da própria linha do outbox. `correlationId` é a `Idempotency-Key`. `causationId` é o id da transação que originou o evento. Ordem de inserção na transação: `[Processed, BalanceChanged]`. `BalanceChanged` também é emitido para a transação interna `OPENING`. Uma wallet aberta com saldo zero **não** emite evento (não há `OPENING` nem lançamento). | A wallet é a fronteira de consistência; agrupar por ela permite a um consumidor (ou grupo FIFO do SQS) processar em ordem por wallet. Limite conhecido: um consumidor só descobre a existência de uma wallet aberta com saldo zero no seu primeiro movimento. |
| D14 | **Relay do outbox**: cada ciclo é uma única transação SQL: `claim` (`SELECT ... FOR UPDATE SKIP LOCKED`, confirmado no SQL real gerado) → publish → `markPublished`/`scheduleRetry` → commit. Entrega é at-least-once; o consumidor deve deduplicar por `eventId`. Ordem entre publishers concorrentes é best-effort (um consumidor usa `walletVersion` para descartar eventos antigos). Retry com backoff exponencial (1s dobrando até 5 min), sem limite de tentativas. Falha de publicação de uma mensagem não impede as demais do mesmo lote. | `SKIP LOCKED` permite múltiplos relays concorrentes sem um esperar o outro e sem duplicar trabalho — testado com dois relays reais disputando o mesmo lote. |
| D15 | **Worker de PENDING_REFERENCE**: cada item pendente é resolvido em sua própria transação SQL — trava a wallet primeiro (mesma ordem de D1), relê a transação sob o lock e só então decide. A seleção dos itens vencidos é feita **sem** lock. Política: 10 tentativas, backoff exponencial de 1s até um teto de 60s (~5 minutos de janela total). Esgotadas as tentativas, a transação é rejeitada com `REFERENCE_NOT_FOUND`. O evento `WagerTransactionPendingReference` é emitido uma única vez, na primeira espera, não a cada tentativa. | A releitura sob o lock é o que impede dois workers de processar o mesmo item duas vezes — testado com 4 workers concorrentes sobre o mesmo pendente: exatamente 1 aplica, os outros descartam. A seleção sem lock é um desperdício de trabalho aceito conscientemente (vários workers podem escanear os mesmos itens vencidos); não afeta a correção. |
| D16 | Uma transação em `PENDING_REFERENCE` responde HTTP `202`, sem o campo `balance` no corpo (a transação ainda não foi decidida, não há saldo observado). Uma reversão cuja própria referência ainda está `PENDING_REFERENCE` (cadeia fora de ordem — por exemplo, um `ROLLBACK` de um `REFUND` que ainda espera sua `BET`) também espera, em vez de ser rejeitada. | Suporta entrega fora de ordem sem forçar o provedor a reenviar. |
| D17 | O status `501` e o erro `UnsupportedTransactionKindError` foram **removidos**. `OPENING` submetido pela API, ou um `kind` desconhecido, é tratado como erro de validação (`400`) no parsing, não como "funcionalidade não implementada". | `501` significava "o servidor não implementa isto", mas `OPENING` nunca será aceito pela API por design — é erro do cliente, não ausência de feature. REFUND e ROLLBACK deixaram de ser "não suportados" assim que a implementação ficou pronta. |

## Taxonomia de falhas de negócio

| Código | Quando ocorre | O que o provedor deve fazer |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` sem saldo suficiente | Não reenviar sem alterar o payload |
| `REVERSAL_WOULD_OVERDRAW` | Débito de uma reversão (`ROLLBACK` de `WIN`/`REFUND`) estouraria o saldo | Situação operacional distinta de "sem saldo para apostar" — tratar separadamente |
| `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH` | Moeda ou jogador divergem da wallet | Corrigir o payload |
| `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH` | Violações das regras de referência (§7 do enunciado) | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | A referência existe, mas não está `PROCESSED` | Desistir |
| `ALREADY_REVERSED` | A referência já tem uma reversão processada (ver D6) | Desistir |
| `REFERENCE_NOT_FOUND` | A referência nunca apareceu dentro da janela de tentativas | Desistir, ou investigar manualmente |
| `INTERNAL_ERROR` | Falha permanente de infraestrutura (status `FAILED`) | Reservado — sem caminho de código que o produza ainda |

## Status HTTP

| Situação | Status |
|---|---|
| Transação processada pela primeira vez | `201` |
| Replay de uma transação já processada | `200` |
| Rejeição de regra de negócio (também no replay) | `422` |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | `202`, **sem** o campo `balance` |
| Payload inválido / `kind` desconhecido / `OPENING` pela API | `400` |
| Wallet inexistente | `404` (sem persistir nada) |
| Conflito de idempotência (mesma chave, payload diferente) ou wallet duplicada | `409` |
| Erro transitório (deadlock, timeout de lock, falha de conexão) | `503` + `Retry-After` |
| Defeito interno | `500`, sem vazar detalhes |

Formato de erro: `{ "error": { "code", "message", "details"? } }`.

## O que foi implementado e validado

- Domínio financeiro completo: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`,
  `OPENING` interno.
- Idempotência por `Idempotency-Key`, com hash do payload incluindo a
  referência (duas reversões com a mesma chave e referências diferentes
  geram conflito, não um replay silencioso incorreto).
- Ledger imutável, auditável, com invariante `balance == soma(ledger)`
  verificada diretamente no banco em todos os testes de integração/e2e.
- Outbox transacional: evento gravado na mesma transação SQL do saldo,
  nunca publicado antes do commit.
- Relay do outbox com `SKIP LOCKED`, retry com backoff, at-least-once.
- Worker de `PENDING_REFERENCE` com reprocessamento seguro sob
  concorrência.
- HTTP completo para `wallets` e `wagering/transactions`, incluindo
  `REFUND`/`ROLLBACK`.
- Testes de concorrência real contra PostgreSQL (não mocks): requisições
  simultâneas disputando o mesmo saldo, múltiplos relays, múltiplos
  workers.

## O que NÃO foi implementado (e por quê)

Por limite de tempo da janela de 3 dias, as seguintes entregas do
enunciado **não foram feitas**. Documentamos aqui em vez de escondê-las.

### SQS (publisher, consumer, inbox, DLQ) — não implementado

**Decisão de design registrada, sem código:** o relay publicaria em uma
fila de **eventos** separada da fila de **entrada**, por exemplo
`wager-events.fifo`, distinta de `wager-transactions.fifo` (fila de
comandos recebidos pelo consumer). Publicar na mesma fila de entrada
faria o próprio consumidor receber de volta os eventos que ele mesmo
gerou. Cada mensagem usaria `MessageGroupId = aggregateId` (a wallet, a
mesma fronteira de consistência do outbox) e
`MessageDeduplicationId = eventId`, para aproveitar a deduplicação
nativa do SQS FIFO como camada extra — nunca como única garantia de
idempotência, que continua sendo do banco.

O consumidor (não implementado) seguiria a mesma ordem de lock de D1: a
inbox (tabela não criada — precisaria de uma migration nova,
`(consumer_name, message_id)` como chave) seria verificada na mesma
transação SQL do processamento, e o `ack` ao SQS só ocorreria depois do
commit. Erro de regra de negócio faria `ack` normal (a rejeição já foi
persistida); erro transitório faria retry com backoff; erro permanente
levaria a mensagem à DLQ após um limite de tentativas.

### Outras entregas pendentes

- `GET /wagering/transactions/:transactionId` e
  `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
- Ledger paginado por cursor.
- Endpoint de reconciliação (`stored_balance` vs `calculated_balance`).
- `/health/ready` (checagem de Postgres e SQS).
- Métricas (contagem por status, duplicatas, retries, DLQ, conflitos de
  lock, lag do outbox).
- Logs estruturados em JSON.
- Testes com 3+ instâncias reais do serviço rodando simultaneamente
  (a concorrência foi testada dentro do processo, contra o mesmo
  Postgres, não com múltiplos processos do serviço).

## Limites conhecidos no que foi entregue

- Sem `lock_timeout` configurado no Postgres.
- Pool de conexões sem tuning explícito.
- `observed_balance` é nullable no schema; a obrigação de preenchê-lo em
  todo estado terminal é garantida pelo código da aplicação, não pelo
  banco.
- O caminho de erro `503` (deadlock/timeout de lock) foi testado só por
  unidade, não sob concorrência real derrubando o banco.
- Não há garantia de ordem entre os eventos `WagerTransactionProcessed`
  e `WalletBalanceChanged` do mesmo commit, quando ambos têm o mesmo
  `occurred_at` — o desempate depende da geração de UUIDv7, que não é
  garantidamente monotônica dentro do mesmo milissegundo.
- O relay publica dentro da mesma transação que mantém o lock das linhas
  reivindicadas; um publisher lento prende conexões do pool. Mitigação
  não implementada: timeout explícito na chamada de publish.
- Clock skew entre instâncias afeta o cálculo de `next_attempt_at` dos
  retries (o relógio é injetado, não lido globalmente, mas continua
  sendo o relógio local de cada instância).