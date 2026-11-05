import { SQL } from 'bun';

/**
 * Conexão direta ao banco, só para ASSERTIVAS independentes da API.
 * O teste não confia na aplicação para dizer se a aplicação está certa.
 */
export const db = new SQL(
  process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/wagering',
);

export interface LedgerRow {
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  balance_before: string;
  balance_after: string;
  transaction_id: string;
}

export async function ledgerOf(walletId: string): Promise<LedgerRow[]> {
  return db`
    SELECT direction, amount::text AS amount, balance_before::text AS balance_before,
           balance_after::text AS balance_after, transaction_id
    FROM wallet_ledger_entries
    WHERE wallet_id = ${walletId}
    ORDER BY created_at, id`;
}

export async function countTransactions(
  walletId: string,
  where: { kind?: string; status?: string },
): Promise<number> {
  const rows = await db`
    SELECT count(*)::int AS n FROM wager_transactions
    WHERE wallet_id = ${walletId}
      AND (${where.kind ?? null}::text IS NULL OR kind = ${where.kind ?? null})
      AND (${where.status ?? null}::text IS NULL OR status = ${where.status ?? null})`;
  return rows[0].n;
}

/**
 * Invariante central do desafio, verificada direto no banco:
 * saldo armazenado == soma dos lançamentos do ledger.
 */
export async function assertBalanceMatchesLedger(walletId: string): Promise<void> {
  // A comparação é feita pelo Postgres em NUMERIC: nenhum float no caminho.
  const rows = await db`
    SELECT w.balance::text AS stored,
           coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS calculated,
           (w.balance = coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)) AS consistent
    FROM wallets w
    LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
    WHERE w.id = ${walletId}
    GROUP BY w.id, w.balance`;
  const row = rows[0];
  if (!row) throw new Error(`wallet ${walletId} not found in database`);
  if (!row.consistent) {
    throw new Error(
      `INVARIANT BROKEN wallet=${walletId}: stored=${row.stored} ledger=${row.calculated}`,
    );
  }
}