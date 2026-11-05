-- =====================================================================
-- 001_init (DOWN)
-- =====================================================================
DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TRIGGER IF EXISTS wle_no_truncate ON wallet_ledger_entries;
DROP TRIGGER IF EXISTS wle_no_update_delete ON wallet_ledger_entries;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP FUNCTION IF EXISTS wallet_ledger_entries_immutable();
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;