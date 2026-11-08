import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction';
import { InvariantViolationError } from './errors';
import { DEFAULT_PENDING_REFERENCE_POLICY, type PendingReferencePolicy } from './pending-reference-policy';
import { PollingLoop } from './polling-loop';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { WagerTransactionApplier } from './wager-transaction-applier';

export interface PendingReferenceWorkerOptions {
  batchSize: number;
  pollIntervalMs: number;
  policy: PendingReferencePolicy;
  onError?: ((error: unknown, transactionId?: string) => void) | undefined;
}

export type ResolveOutcome = 'processed' | 'rejected' | 'stillPending' | 'skipped';

export interface PendingRunResult {
  due: number;
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
  failed: number;
}

const DEFAULTS: PendingReferenceWorkerOptions = {
  batchSize: 50,
  pollIntervalMs: 1_000,
  policy: DEFAULT_PENDING_REFERENCE_POLICY,
};

/**
 * Reprocessa REFUND/ROLLBACK em PENDING_REFERENCE. Cada item roda na SUA transação SQL: trava a wallet
 * (mesma ordem do caminho HTTP), relê a transação SOB o lock e só então decide. Vários workers podem
 * selecionar o mesmo item: o lock da wallet serializa e o segundo descobre que o primeiro já decidiu.
 */
export class PendingReferenceWorker {
  private readonly options: PendingReferenceWorkerOptions;
  private readonly applier: WagerTransactionApplier;
  private readonly loop: PollingLoop;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    ids: IdGenerator,
    options: Partial<PendingReferenceWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.applier = new WagerTransactionApplier(ids, this.options.policy);
    this.loop = new PollingLoop(async () => (await this.runOnce()).due, {
      batchSize: this.options.batchSize,
      pollIntervalMs: this.options.pollIntervalMs,
      onError: (error) => this.options.onError?.(error),
    });
  }

  start(): void { this.loop.start(); }
  stop(): Promise<void> { return this.loop.stop(); }

  async runOnce(): Promise<PendingRunResult> {
    const due = await this.uow.run((repos) =>
      repos.transactions.findDuePendingReference(this.clock.now(), this.options.batchSize),
    );
    const result: PendingRunResult = { due: due.length, processed: 0, rejected: 0, stillPending: 0, skipped: 0, failed: 0 };
    for (const { id, walletId } of due) {
      try {
        result[await this.resolve(id, walletId)] += 1;
      } catch (error) {
        result.failed += 1; // um item ruim não trava os outros
        this.options.onError?.(error, id);
      }
    }
    return result;
  }

  async resolve(transactionId: string, walletId: string): Promise<ResolveOutcome> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      if (!wallet) {
        throw new InvariantViolationError(`wallet ${walletId} of pending transaction ${transactionId} not found`);
      }
      // reler SOB o lock é o que impede o duplo processamento entre workers
      const tx = await repos.transactions.findById(transactionId);
      const now = this.clock.now();
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return 'skipped';
      if (tx.pendingNextAttemptAt !== undefined && tx.pendingNextAttemptAt.getTime() > now.getTime()) return 'skipped';

      await this.applier.apply(repos, wallet, tx, now);
      return this.outcomeOf(tx);
    });
  }

  private outcomeOf(tx: WagerTransaction): ResolveOutcome {
    switch (tx.status) {
      case WagerTransactionStatus.Processed: return 'processed';
      case WagerTransactionStatus.Rejected: return 'rejected';
      case WagerTransactionStatus.PendingReference: return 'stillPending';
      default: throw new InvariantViolationError(`transaction ${tx.id} ended in unexpected status ${tx.status}`);
    }
  }
}