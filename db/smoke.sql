\set ON_ERROR_STOP off
\pset pager off
\echo '--- setup'
INSERT INTO wallets (id, player_id, currency, balance) VALUES
 ('00000000-0000-0000-0000-000000000001','p1','BRL',100.00);
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at)
VALUES ('00000000-0000-0000-0000-0000000000a1','prov','bet-1','k1','h1','00000000-0000-0000-0000-000000000001','p1','r1','g1','BET',80.00,'BRL','PROCESSED',now());

\echo '1) saldo negativo deve FALHAR (check wallets_balance_non_negative)'
UPDATE wallets SET balance = -1 WHERE id='00000000-0000-0000-0000-000000000001';

\echo '2) segunda wallet do mesmo player+moeda deve FALHAR (unique)'
INSERT INTO wallets (id, player_id, currency, balance) VALUES ('00000000-0000-0000-0000-000000000002','p1','BRL',0);

\echo '3) mesmo external id deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
VALUES (gen_random_uuid(),'prov','bet-1','k-outra','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','BET',1,'BRL','PENDING');

\echo '4) mesma idempotency key deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
VALUES (gen_random_uuid(),'prov','bet-9','k1','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','BET',1,'BRL','PENDING');

\echo '5) REFUND sem referencia deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
VALUES (gen_random_uuid(),'prov','rf-x','k-rf-x','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','REFUND',80,'BRL','PENDING');

\echo '6) REJECTED sem failure_code deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
VALUES (gen_random_uuid(),'prov','bet-r','k-r','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','BET',500,'BRL','REJECTED');

\echo '7) OK: REJECTED com failure_code e sem ledger'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code)
VALUES (gen_random_uuid(),'prov','bet-r2','k-r2','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','BET',500,'BRL','REJECTED','INSUFFICIENT_FUNDS');

\echo '8) OK: ledger valido (100 -> 20)'
INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','DEBIT',80,'BRL',100,20);

\echo '9) ledger com aritmetica errada deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at)
VALUES ('00000000-0000-0000-0000-0000000000a2','prov','bet-2','k2','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','BET',10,'BRL','PROCESSED',now());
INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a2','DEBIT',10,'BRL',20,15);

\echo '10) segundo lancamento da mesma wallet+transacao deve FALHAR'
INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','DEBIT',5,'BRL',20,15);

\echo '11) UPDATE no ledger deve FALHAR'
UPDATE wallet_ledger_entries SET amount = 1;
\echo '12) DELETE no ledger deve FALHAR'
DELETE FROM wallet_ledger_entries;
\echo '13) TRUNCATE no ledger deve FALHAR'
TRUNCATE wallet_ledger_entries;

\echo '14) OK: primeiro REFUND processado da BET'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, processed_at)
VALUES (gen_random_uuid(),'prov','rf-1','k-rf-1','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','REFUND',80,'BRL','bet-1','00000000-0000-0000-0000-0000000000a1','PROCESSED',now());
\echo '15) segundo REFUND processado da MESMA BET deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, processed_at)
VALUES (gen_random_uuid(),'prov','rf-2','k-rf-2','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','REFUND',80,'BRL','bet-1','00000000-0000-0000-0000-0000000000a1','PROCESSED',now());
\echo '16) ROLLBACK processado da MESMA BET (ja reembolsada) tambem deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, processed_at)
VALUES (gen_random_uuid(),'prov','rb-1','k-rb-1','h','00000000-0000-0000-0000-000000000001','p1','r1','g1','ROLLBACK',80,'BRL','bet-1','00000000-0000-0000-0000-0000000000a1','PROCESSED',now());

\echo '17) inbox duplicada deve FALHAR'
INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c','m1','h');
INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c','m1','h');