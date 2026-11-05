import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261105000001_init } from './migrations/Migration20261105000001_init';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'app',
  password: process.env.DB_PASSWORD ?? 'app',
  dbName: process.env.DB_NAME ?? 'wagering',
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      { name: 'Migration20261105000001_init', class: Migration20261105000001_init },
    ],
    transactional: true,
    allOrNothing: true,
  },
});