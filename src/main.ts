import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT => onApplicationShutdown (fecha o pool do banco)
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  const worker = app.get(PENDING_REFERENCE_WORKER); // token a criar em app.tokens.ts
  worker.start();
  app.enableShutdownHooks();
}
bootstrap();