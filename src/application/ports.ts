import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';

/**
 * Portas de saída da camada de aplicação. O use case depende SÓ destas interfaces;
 * a implementação com MikroORM vive em infra/ e o use case nunca a importa.
 *
 * REGRA DE ORDEM (medida, não teórica): dentro de uma transação, TRAVE A WALLET
 * (`findByIdForUpdate`) ANTES de inserir qualquer WagerTransaction. O INSERT da
 * transação toma `FOR KEY SHARE` na linha da wallet (FK) e isso conflita com o
 * `FOR UPDATE` de outra transação: inserir-primeiro causa deadlock sob concorrência
 * (19 de 20 transações em teste). Travar-primeiro serializa limpo.
 */
export interface WalletRepository {
  /** Insere imediatamente (dentro da transação corrente). */
  insert(wallet: Wallet): Promise<void>;

  /** Leitura sem lock, para consultas. Não use para alterar saldo. */
  findById(id: string): Promise<Wallet | null>;

  /**
   * SELECT ... FOR UPDATE. Só funciona dentro de uma transação.
   * Devolve null se a wallet não existe. Bloqueia até obter o lock.
   */
  findByIdForUpdate(id: string): Promise<Wallet | null>;

  /**
   * Registra a alteração de uma wallet que foi lida com `findByIdForUpdate`
   * NESTA transação. Lança WalletNotLockedError se não foi travada antes.
   * A escrita é descarregada no commit.
   */
  save(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  /**
   * INSERT ... ON CONFLICT DO NOTHING.
   * true  = inseriu; false = já existia alguma linha com a mesma
   *         (provider, idempotency_key) OU (provider, external_transaction_id).
   * Para saber qual foi, use findByIdempotencyKey / findByExternalId.
   */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;

  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;

  /** REFUND/ROLLBACK já PROCESSED que reverteu a transação indicada (id interno), se houver. */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | null>;

  /** Persiste as transições de uma transação (status, falha, processedAt, pendência). Descarregada no commit. */
  save(tx: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  /** Append-only. Insere imediatamente. */
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
}

/** Executa `work` numa única transação de banco: commit se resolver, rollback se lançar. */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}