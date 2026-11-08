import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import type { Clock, IdGenerator, UnitOfWork } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { CLOCK, ID_GENERATOR, PENDING_REFERENCE_WORKER, UNIT_OF_WORK } from './app.tokens';
import { HealthController } from './health.controller';
import { AllExceptionsFilter } from './http/all-exceptions.filter';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import ormConfig from './infra/orm.config';
import { MikroOrmUnitOfWork } from './infra/persistence/repositories';
import { SystemClock, UuidV7Generator } from './infra/system';
import { PendingReferenceWorker } from './application/pending-reference-worker';

/**providers
 * Fiação explícita por factories + `inject`: nada depende de `emitDecoratorMetadata`
 * (que sob o Bun é a parte frágil da injeção do Nest).
 */
@Module({
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: MikroORM, useFactory: () => MikroORM.init(ormConfig) },
    { provide: UNIT_OF_WORK, useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm), inject: [MikroORM] },
    { provide: CLOCK, useFactory: () => new SystemClock() },
    { provide: ID_GENERATOR, useFactory: () => new UuidV7Generator() },
    {
      provide: CreateWalletUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWalletUseCase(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (uow: UnitOfWork) => new GetWalletUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new ProcessWagerTransactionUseCase(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new PendingReferenceWorker(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
  ],
})

export class AppModule implements OnApplicationShutdown {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(PENDING_REFERENCE_WORKER) private readonly pendingReferenceWorker: PendingReferenceWorker,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pendingReferenceWorker.stop(); // primeiro: espera o ciclo em andamento terminar
    await this.orm.close();                   // só depois fecha o pool
  }
}