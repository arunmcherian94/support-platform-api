import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

/** Applies the bundled migrations; returns the names applied in this call. */
export function migrate(db: DatabaseSync): string[] {
  return migrateFrom(db, MIGRATIONS_DIR);
}

/**
 * Applies the `NNNN_name.sql` files in `dir` in filename order. Each runs in its own
 * transaction together with its bookkeeping row; a failure rolls back that migration
 * and throws, so start-up stops with the schema as it was.
 */
export function migrateFrom(db: DatabaseSync, dir: URL): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );
  const done = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((row) => String(row['name'])),
  );
  const files = readdirSync(dir)
    .filter((file) => FILE_PATTERN.test(file))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const name = file.slice(0, -'.sql'.length);
    if (done.has(name)) continue;
    const sql = readFileSync(new URL(file, dir), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare(
        `INSERT INTO schema_migrations (name, applied_at)
         VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      ).run(name);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    applied.push(name);
  }
  return applied;
}
