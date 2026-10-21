/**
 * Migration runner. Reads every .sql file in packages/db/sql/ in filename order
 * and executes them against the ADMIN pool. All SQL files are written to be
 * idempotent (IF NOT EXISTS / DO $$ blocks), so this is safe to run repeatedly.
 *
 * Also works as a CLI entrypoint:  tsx packages/db/src/migrate.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withAdmin } from './tenant.js';
import { closePools } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, '..', 'sql');

export async function migrate(): Promise<void> {
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await withAdmin(async (c) => {
    for (const f of files) {
      const sql = readFileSync(join(SQL_DIR, f), 'utf8');
      await c.query(sql);
    }
  });
}

// CLI entrypoint
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrate()
    .then(() => {
      console.log('Migrations complete.');
      return closePools();
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
