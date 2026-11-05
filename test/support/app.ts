import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';

export interface TestApp {
  baseUrl: string;
  close(): Promise<void>;
}

/** Sobe a aplicação de verdade, em porta efêmera, contra o Postgres real. */
export async function startApp(): Promise<TestApp> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not resolve test server address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}