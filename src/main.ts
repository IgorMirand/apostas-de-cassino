import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PENDING_REFERENCE_WORKER } from './app.tokens';
import type { PendingReferenceWorker } from './application/pending-reference-worker';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT => onApplicationShutdown (stop do worker + fecha o pool)
  app.get<PendingReferenceWorker>(PENDING_REFERENCE_WORKER).start();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
bootstrap();