import { Migration } from '@mikro-orm/migrations';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = (file: string) =>
  readFileSync(join(import.meta.dir, '../../../db', file), 'utf8');

export class Migration20261105000001_init extends Migration {
  override async up(): Promise<void> {
    this.addSql(sql('001_init.up.sql'));
  }

  override async down(): Promise<void> {
    this.addSql(sql('001_init.down.sql'));
  }
}