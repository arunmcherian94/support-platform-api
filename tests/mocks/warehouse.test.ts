import { describe, expect, it } from 'vitest';
import { useMockServer } from './helpers.js';

const h = useMockServer();

const USAGE_SQL =
  'SELECT account_id, month, protected_tb, api_calls, active_users FROM monthly_usage WHERE account_id = ? ORDER BY month DESC LIMIT ?';

interface Result {
  resultSetMetaData: { numRows: number; format: string; rowType: { name: string }[] };
  data: string[][];
  code: string;
  createdOn: number;
  statementHandle: string;
  message: string;
}

function run(statement: unknown, bindings?: unknown): Promise<Response> {
  return fetch(`${h.url}/api/v2/statements`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ statement, bindings }),
  });
}

const bind = (account: string, limit = '3'): Record<string, { type: string; value: string }> => ({
  '1': { type: 'TEXT', value: account },
  '2': { type: 'FIXED', value: limit },
});

describe('usage warehouse mock (S1-4)', () => {
  it('returns the newest months first as strings', async () => {
    const res = await run(USAGE_SQL, bind('ACC-007'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Result;
    expect(body.code).toBe('090001');
    expect(body.resultSetMetaData.numRows).toBe(3);
    expect(body.resultSetMetaData.format).toBe('jsonv2');
    expect(body.resultSetMetaData.rowType.map((c) => c.name)).toEqual([
      'ACCOUNT_ID',
      'MONTH',
      'PROTECTED_TB',
      'API_CALLS',
      'ACTIVE_USERS',
    ]);
    expect(body.data.map((r) => r[1])).toEqual(['2026-09', '2026-08', '2026-07']);
    expect(body.data[0]).toEqual(['ACC-007', '2026-09', '412.5', '1203331', '87']);
    expect(body.createdOn).toBe(Date.parse('2026-11-06T12:00:00Z'));
  });

  it('honours LIMIT', async () => {
    const body = (await (await run(USAGE_SQL, bind('ACC-007', '1'))).json()) as Result;
    expect(body.data).toHaveLength(1);
  });

  it('runs the allow-listed statement despite extra whitespace', async () => {
    const spaced = `  ${USAGE_SQL.replaceAll(' ', '\n  ')}\n`;
    const res = await run(spaced, bind('ACC-007'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Result).data).toHaveLength(3);
  });

  it('returns 200 with no rows for an account without usage', async () => {
    const res = await run(USAGE_SQL, bind('ACC-015'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Result;
    expect(body.resultSetMetaData.numRows).toBe(0);
    expect(body.data).toEqual([]);
  });

  it('rejects statements outside the allow-list', async () => {
    const res = await run('SELECT * FROM monthly_usage');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: '002003', sqlState: '42000' });
  });

  it('rejects DROP TABLE and keeps serving data', async () => {
    const res = await run('DROP TABLE monthly_usage');
    expect(res.status).toBe(422);
    const after = await run(USAGE_SQL, bind('ACC-007'));
    expect(((await after.json()) as Result).data).toHaveLength(3);
  });

  it('treats a SQL injection attempt in a binding as plain data', async () => {
    const res = await run(USAGE_SQL, bind("ACC-007' OR '1'='1"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Result).data).toHaveLength(0);
  });

  it('rejects a wrong binding count', async () => {
    const res = await run(USAGE_SQL, { '1': { type: 'TEXT', value: 'ACC-007' } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: '002049' });
  });

  it('rejects a non-integer FIXED binding', async () => {
    const res = await run(USAGE_SQL, bind('ACC-007', '3.5'));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: '002049' });
  });

  it('rejects wrong keys and non-string values', async () => {
    expect((await run(USAGE_SQL, { '1': bind('A')['1'], '3': bind('A')['2'] })).status).toBe(422);
    expect(
      (await run(USAGE_SQL, { '1': { type: 'TEXT', value: 7 }, '2': bind('A')['2'] })).status,
    ).toBe(422);
  });

  it('returns 400 when the statement is missing or not a string', async () => {
    for (const statement of [undefined, 42]) {
      const res = await run(statement);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: '390142' });
    }
  });

  it('reset restores the seeded database', async () => {
    h.mock.reset();
    const body = (await (await run(USAGE_SQL, bind('ACC-007'))).json()) as Result;
    expect(body.data).toHaveLength(3);
  });
});
