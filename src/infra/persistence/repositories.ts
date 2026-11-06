import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  LedgerRepository, Repositories, UnitOfWork, WagerTransactionRepository, WalletRepository,
} from '../../application/ports';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WalletNotLockedError } from './errors';
import {
  applyTransactionToRecord, applyWalletToRecord, ledgerEntryToNewRecord, transactionToDomain,
  transactionToNewRecord, walletToDomain, walletToNewRecord,
} from './mappers';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from './records';

/**
 * Convenção de escrita desta camada:
 *  - INSERTs e leituras/locks executam IMEDIATAMENTE na transação corrente;
 *  - UPDATEs de registros gerenciados (wallet, transição de transação) ficam no
 *    Unit of Work do MikroORM e são descarregados juntos no COMMIT.
 * Tudo roda no EntityManager transacional recebido: um único commit ou nada.
 */

export class MikroOrmWalletRepository implements WalletRepository {
  /** Wallets travadas NESTA transação: só elas podem ser salvas. */
  private readonly locked = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, { ...walletToNewRecord(wallet) });
  }

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? walletToDomain(record) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!record) return null;
    this.locked.set(id, record);
    return walletToDomain(record);
  }

  save(wallet: Wallet): void {
    const record = this.locked.get(wallet.id);
    if (!record) throw new WalletNotLockedError(wallet.id);
    applyWalletToRecord(wallet, record);
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly loaded = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    // ON CONFLICT sem alvo: cobre as DUAS unicidades (idempotency_key e external_transaction_id)
    const result = await this.em
      .createQueryBuilder(WagerTransactionRecord)
      .insert({ ...transactionToNewRecord(tx) })
      .onConflict()
      .ignore()
      .execute();
    return result.affectedRows === 1;
  }

  findById(id: string) {
    return this.find({ id });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string) {
    return this.find({ providerId, idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.find({ providerId, externalTransactionId });
  }

  findProcessedReversalOf(referenceTransactionId: string) {
    return this.find({
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
  }

  async save(tx: WagerTransaction): Promise<void> {
    const record =
      this.loaded.get(tx.id) ?? (await this.em.findOneOrFail(WagerTransactionRecord, { id: tx.id }));
    this.loaded.set(tx.id, record);
    applyTransactionToRecord(tx, record);
  }

  private async find(where: Parameters<EntityManager['findOne']>[1] & object): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, where as never);
    if (!record) return null;
    this.loaded.set(record.id, record);
    return transactionToDomain(record);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntryRecord, { ...ledgerEntryToNewRecord(entry) });
  }
}

export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
  };
}

/**
 * Uma transação por `run`, nível de isolamento READ COMMITTED (padrão do Postgres).
 * A correção NÃO depende de SERIALIZABLE: quem serializa é o FOR UPDATE na wallet.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.orm.em.transactional((em) => work(createRepositories(em)));
  }
}