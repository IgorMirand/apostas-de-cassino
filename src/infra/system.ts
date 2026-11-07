import type { Clock, IdGenerator } from '../application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: ordenável no tempo, bom para índices (o banco guarda como `uuid`). */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}