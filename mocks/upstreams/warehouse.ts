import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { UpstreamDeps, UpstreamModule } from '../server.js';

const SEED_SQL = readFileSync(new URL('../fixtures/warehouse/seed.sql', import.meta.url), 'utf8');

/**
 * The only statements this role may run. Anything else is rejected before it
 * reaches the database, so statement text is never executed unless listed here.
 */
const ALLOWED_STATEMENTS = new Set([
  'SELECT account_id, month, protected_tb, api_calls, active_users FROM monthly_usage WHERE account_id = ? ORDER BY month DESC LIMIT ?',
]);

const ROW_TYPE = [
  { name: 'ACCOUNT_ID', type: 'text' },
  { name: 'MONTH', type: 'text' },
  { name: 'PROTECTED_TB', type: 'real' },
  { name: 'API_CALLS', type: 'fixed' },
  { name: 'ACTIVE_USERS', type: 'fixed' },
];
const COLUMNS = ['account_id', 'month', 'protected_tb', 'api_calls', 'active_users'] as const;

type ParsedBindings = { ok: true; values: SQLInputValue[] } | { ok: false; message: string };

function parseBindings(raw: unknown, placeholders: number): ParsedBindings {
  const bindings = raw ?? {};
  if (typeof bindings !== 'object' || Array.isArray(bindings)) {
    return { ok: false, message: 'Bind variables must be an object.' };
  }
  const entries = bindings as Record<string, unknown>;
  if (Object.keys(entries).length !== placeholders) {
    return {
      ok: false,
      message: `Bind variable count mismatch: expected ${String(placeholders)}, got ${String(Object.keys(entries).length)}.`,
    };
  }
  const values: SQLInputValue[] = [];
  for (let i = 1; i <= placeholders; i++) {
    const binding = Object.hasOwn(entries, String(i)) ? entries[String(i)] : undefined;
    if (typeof binding !== 'object' || binding === null) {
      return { ok: false, message: `Bind variable ${String(i)} is missing or malformed.` };
    }
    const { type, value } = binding as Record<string, unknown>;
    if (typeof value !== 'string') {
      return { ok: false, message: `Bind variable ${String(i)} value must be a string.` };
    }
    if (type === 'TEXT') {
      values.push(value);
    } else if (type === 'FIXED') {
      if (!/^-?\d+$/.test(value)) {
        return { ok: false, message: `Bind variable ${String(i)} is not a valid FIXED integer.` };
      }
      values.push(Number(value));
    } else {
      return { ok: false, message: `Bind variable ${String(i)} has unsupported type.` };
    }
  }
  return { ok: true, values };
}

/** Mock usage warehouse with the shape of the Snowflake SQL API. */
export function warehouseRouter(deps: UpstreamDeps): UpstreamModule {
  const open = (): DatabaseSync => {
    const db = new DatabaseSync(':memory:');
    db.exec(SEED_SQL);
    return db;
  };
  let db = open();

  const router = Router();
  router.post('/api/v2/statements', (req, res) => {
    const body: unknown = req.body;
    const { statement, bindings } =
      typeof body === 'object' && body !== null
        ? (body as { statement?: unknown; bindings?: unknown })
        : {};
    if (typeof statement !== 'string' || statement.trim() === '') {
      res.status(400).json({
        code: '390142',
        message: 'Incoming request does not contain a valid statement.',
      });
      return;
    }

    const statementHandle = randomUUID();
    const normalized = statement.replace(/\s+/g, ' ').trim();
    if (!ALLOWED_STATEMENTS.has(normalized)) {
      res.status(422).json({
        code: '002003',
        message: 'SQL compilation error: statement is not permitted for this role.',
        sqlState: '42000',
        statementHandle,
      });
      return;
    }

    const placeholders = normalized.split('?').length - 1;
    const parsed = parseBindings(bindings, placeholders);
    if (!parsed.ok) {
      res.status(422).json({
        code: '002049',
        message: parsed.message,
        sqlState: '42000',
        statementHandle,
      });
      return;
    }

    const rows = db.prepare(normalized).all(...parsed.values);
    const data = rows.map((row) => COLUMNS.map((column) => String(row[column])));
    res.json({
      resultSetMetaData: { numRows: data.length, format: 'jsonv2', rowType: ROW_TYPE },
      data,
      code: '090001',
      statementStatusUrl: `/api/v2/statements/${statementHandle}`,
      requestId: randomUUID(),
      sqlState: '00000',
      statementHandle,
      message: 'Statement executed successfully.',
      createdOn: deps.clock.now().getTime(),
    });
  });

  return {
    router,
    reset: () => {
      db.close();
      db = open();
    },
  };
}
