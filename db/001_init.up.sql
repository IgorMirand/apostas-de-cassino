-- =====================================================================
-- 001_init (UP)
-- =====================================================================

-- ---------------------------------------------------------------- wallets
CREATE TABLE wallets (
  id          uuid PRIMARY KEY,
  player_id   text           NOT NULL,
  currency    char(3)        NOT NULL,
  balance     numeric(19,2)  NOT NULL,
  version     integer        NOT NULL DEFAULT 1,
  created_at  timestamptz    NOT NULL DEFAULT now(),
  updated_at  timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive     CHECK (version >= 1),
  CONSTRAINT wallets_currency_format      CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency)
);

-- ------------------------------------------------------ wager_transactions
CREATE TABLE wager_transactions (
  id                                uuid PRIMARY KEY,
  provider_id                       text          NOT NULL,
  external_transaction_id           text          NOT NULL,
  idempotency_key                   text          NOT NULL,
  payload_hash                      text          NOT NULL,
  wallet_id                         uuid          NOT NULL REFERENCES wallets(id),
  player_id                         text          NOT NULL,
  round_id                          text,
  game_id                           text,
  kind                              text          NOT NULL,
  amount                            numeric(19,2) NOT NULL,
  currency                          char(3)       NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id          uuid          REFERENCES wager_transactions(id),
  status                            text          NOT NULL,
  failure_code                      text,
  created_at                        timestamptz   NOT NULL DEFAULT now(),
  processed_at                      timestamptz,
  -- reprocessamento de PENDING_REFERENCE
  pending_attempts                  integer       NOT NULL DEFAULT 0,
  pending_next_attempt_at           timestamptz,

  CONSTRAINT wt_kind_valid CHECK (kind IN ('BET','WIN','LOSS','REFUND','ROLLBACK','OPENING')),
  CONSTRAINT wt_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT wt_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT wt_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  -- REFUND/ROLLBACK exigem referência; os demais não podem ter
  CONSTRAINT wt_reference_by_kind CHECK (
    (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
    OR (kind NOT IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NULL)
  ),
  -- operações de jogo exigem rodada e jogo; OPENING (interna) não
  CONSTRAINT wt_round_game_by_kind CHECK (
    kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)
  ),
  -- failure_code presente se e somente se REJECTED/FAILED
  CONSTRAINT wt_failure_code_by_status CHECK (
    (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
  ),
  -- PROCESSED sempre carrega processed_at
  CONSTRAINT wt_processed_at_by_status CHECK (
    (status = 'PROCESSED') = (processed_at IS NOT NULL)
  ),
  -- PROCESSED de REFUND/ROLLBACK sempre tem a referência resolvida
  CONSTRAINT wt_processed_reference_resolved CHECK (
    NOT (status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NULL)
  ),
  CONSTRAINT wt_provider_external_uq    UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wt_provider_idempotency_uq UNIQUE (provider_id, idempotency_key)
);

-- uma referência só pode ser revertida UMA vez (ver decisão no ARCHITECTURE.md)
CREATE UNIQUE INDEX wt_single_reversal_uq
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED'
    AND kind IN ('REFUND','ROLLBACK')
    AND reference_transaction_id IS NOT NULL;

-- worker de PENDING_REFERENCE: busca só o que está pendente
CREATE INDEX wt_pending_reference_due_idx
  ON wager_transactions (pending_next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';

-- resolver referência por (provider, external id) usa o UNIQUE acima;
-- listagens por wallet
CREATE INDEX wt_wallet_created_idx ON wager_transactions (wallet_id, created_at DESC);

-- ---------------------------------------------------- wallet_ledger_entries
CREATE TABLE wallet_ledger_entries (
  id              uuid PRIMARY KEY,
  wallet_id       uuid          NOT NULL REFERENCES wallets(id),
  transaction_id  uuid          NOT NULL REFERENCES wager_transactions(id),
  direction       text          NOT NULL,
  amount          numeric(19,2) NOT NULL,
  currency        char(3)       NOT NULL,
  balance_before  numeric(19,2) NOT NULL,
  balance_after   numeric(19,2) NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT wle_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT wle_amount_positive CHECK (amount > 0),
  CONSTRAINT wle_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
  -- a aritmética do lançamento fecha, no banco
  CONSTRAINT wle_balanced CHECK (
    (direction = 'DEBIT'  AND balance_after = balance_before - amount) OR
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
  ),
  -- no máximo um lançamento por wallet por transação
  CONSTRAINT wle_wallet_transaction_uq UNIQUE (wallet_id, transaction_id)
);

-- paginação por cursor estável: (created_at, id) por wallet
CREATE INDEX wle_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, created_at, id);

-- imutabilidade: nenhum UPDATE, DELETE ou TRUNCATE, nem por engano
CREATE FUNCTION wallet_ledger_entries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wle_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_immutable();

CREATE TRIGGER wle_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_immutable();

-- ------------------------------------------------------------ inbox_messages
CREATE TABLE inbox_messages (
  consumer_name  text         NOT NULL,
  message_id     text         NOT NULL,
  payload_hash   text         NOT NULL,
  received_at    timestamptz  NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

-- ------------------------------------------------------------ outbox_messages
CREATE TABLE outbox_messages (
  id               uuid PRIMARY KEY,
  aggregate_id     uuid         NOT NULL,
  event_type       text         NOT NULL,
  payload          jsonb        NOT NULL,
  occurred_at      timestamptz  NOT NULL DEFAULT now(),
  attempts         integer      NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz  NOT NULL DEFAULT now(),
  published_at     timestamptz,
  CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
);

-- publishers só enxergam o que está pendente (índice parcial pequeno)
CREATE INDEX outbox_pending_idx
  ON outbox_messages (next_attempt_at, occurred_at)
  WHERE published_at IS NULL;