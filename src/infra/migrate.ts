import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import config from './orm.config';

const cmd = process.argv[2] ?? 'up';
const orm = await MikroORM.init(config);
try {
  const migrator = orm.migrator;
  if (cmd === 'up') {
    const r = await migrator.up();
    console.log('applied:', r.map((m) => m.name));
  } else if (cmd === 'down') {
    const r = await migrator.down();
    console.log('reverted:', r.map((m) => m.name));
  } else if (cmd === 'status') {
    console.log('pending:', (await migrator.getPending()).map((m) => m.name));
    console.log('executed:', (await migrator.getExecuted()).map((m) => m.name));
  } else {
    throw new Error('usage: migrate.ts [up|down|status]');
  }
} finally {
  await orm.close();
}