import { DatabaseSync } from 'node:sqlite';

/** Opens the store with the pragmas every connection needs. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL lets readers proceed during a write; it does not apply to in-memory databases.
  // Before WAL: switching journal mode can itself wait on another connection's lock.
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
