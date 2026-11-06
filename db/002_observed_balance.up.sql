-- =====================================================================
-- 002_observed_balance (UP)
-- Saldo da wallet OBSERVADO quando a transação chegou a um estado final.
-- Serve para o replay idempotente devolver "o resultado original, incluindo
-- o saldo observado naquele momento" (README, regra 7), inclusive para
-- LOSS (sem lançamento) e REJECTED (sem lançamento).
-- A moeda é guardada porque pode diferir da moeda da transação
-- (rejeição CURRENCY_MISMATCH observa o saldo na moeda da WALLET).
-- =====================================================================
ALTER TABLE wager_transactions
  ADD COLUMN observed_balance  numeric(19,2),
  ADD COLUMN observed_currency char(3);

ALTER TABLE wager_transactions
  ADD CONSTRAINT wt_observed_balance_non_negative
    CHECK (observed_balance IS NULL OR observed_balance >= 0),
  ADD CONSTRAINT wt_observed_pair
    CHECK ((observed_balance IS NULL) = (observed_currency IS NULL)),
  ADD CONSTRAINT wt_observed_currency_format
    CHECK (observed_currency IS NULL OR observed_currency ~ '^[A-Z]{3}$');