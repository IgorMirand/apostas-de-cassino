import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261105000001_init } from './migrations/Migration20261105000001_init';
import { Migration20261105000002_observed_balance } from './migrations/Migration20261105000002_observed_balance';
import { schemas } from './persistence/schemas';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'app',
  password: process.env.DB_PASSWORD ?? 'app',
  dbName: process.env.DB_NAME ?? 'wagering',
  entities: schemas,
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      { name: 'Migration20261105000001_init', class: Migration20261105000001_init },
      { name: 'Migration20261105000002_observed_balance', class: Migration20261105000002_observed_balance },
    ],
    snapshot: false,
    transactional: true,
    allOrNothing: true,
  },
});