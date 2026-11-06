import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.js';
import { migrate, migrateFrom } from '../../src/store/migrate.js';

const INIT_SQL = readFileSync(
  new URL('../../src/store/migrations/0001_init.sql', import.meta.url),
  'utf8',
);

function names(db: DatabaseSync, type: 'table' | 'index'): string[] {
  return db
    .prepare('SELECT name FROM sqlite_master WHERE type = ?')
    .all(type)
    .map((row) => String(row['name']));
}

function insertAudit(db: DatabaseSync): void {
  db.exec(
    `INSERT INTO audit_log (at, correlation_id, actor_sub, actor_client, action, resource_type, resource_id, outcome)
     VALUES ('2026-11-06T00:00:00Z', 'c1', 'u1', 'cl1', 'read', 'case', 'CS-1', 'ok')`,
  );
}

describe('migrate', () => {
  it('applies 0001 once and is idempotent', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual(['0001_init']);
    expect(migrate(db)).toEqual([]);
    const row = db.prepare('SELECT applied_at FROM schema_migrations').get();
    expect(String(row?.['applied_at'])).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('creates the tables and indexes', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(names(db, 'table')).toEqual(
      expect.arrayContaining([
        'idempotency_keys',
        'audit_log',
        'webhook_subscriptions',
        'webhook_deliveries',
        'schema_migrations',
      ]),
    );
    expect(names(db, 'table')).not.toContain('pending_actions');
    expect(names(db, 'index')).toEqual(
      expect.arrayContaining([
        'idx_idempotency_expires_at',
        'idx_audit_resource',
        'idx_audit_actor_sub',
        'idx_audit_actor_agent',
        'idx_deliveries_status_next',
      ]),
    );
  });

  it('makes audit_log append-only', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    insertAudit(db);
    expect(() => {
      db.exec(`UPDATE audit_log SET outcome = 'x'`);
    }).toThrow('audit_log is append-only');
    expect(() => {
      db.exec('DELETE FROM audit_log');
    }).toThrow('audit_log is append-only');
  });

  it('enforces foreign keys on deliveries', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    expect(() => {
      db.exec(
        `INSERT INTO webhook_deliveries (id, subscription_id, event_type, payload, status, created_at)
         VALUES ('d1', 'missing', 'e', '{}', 'pending', '2026-11-06T00:00:00Z')`,
      );
    }).toThrow();
  });

  it('rolls back a failing migration, names it, and keeps earlier ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    writeFileSync(join(dir, '0001_init.sql'), INIT_SQL);
    writeFileSync(
      join(dir, '0002_broken.sql'),
      'CREATE TABLE half_done (id INTEGER) STRICT;\nINSERT INTO no_such_table VALUES (1);',
    );
    const db = openDatabase(':memory:');
    expect(() => migrateFrom(db, pathToFileURL(dir + '/'))).toThrow(/0002_broken/);
    expect(names(db, 'table')).not.toContain('half_done');
    const applied = db.prepare('SELECT name FROM schema_migrations').all();
    expect(applied.map((r) => String(r['name']))).toEqual(['0001_init']);
    // No dangling transaction is left behind.
    expect(() => {
      db.exec('BEGIN IMMEDIATE; COMMIT;');
    }).not.toThrow();
  });

  it('sets WAL and foreign keys for a file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-'));
    const db = openDatabase(join(dir, 'store.db'));
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    db.close();
  });
});
