-- =====================================================================
-- 002_observed_balance (DOWN)
-- =====================================================================
ALTER TABLE wager_transactions
  DROP CONSTRAINT IF EXISTS wt_observed_currency_format,
  DROP CONSTRAINT IF EXISTS wt_observed_pair,
  DROP CONSTRAINT IF EXISTS wt_observed_balance_non_negative;
ALTER TABLE wager_transactions
  DROP COLUMN IF EXISTS observed_currency,
  DROP COLUMN IF EXISTS observed_balance;