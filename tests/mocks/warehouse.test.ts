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
    expect(body.data.map((r) => r[1])).toEqual(['2026-10', '2026-09', '2026-08']);
    // The scenario's sample row is preserved.
    expect(body.data[1]).toEqual(['ACC-007', '2026-09', '412.5', '1203331', '87']);
    expect(body.createdOn).toBe(Date.parse('2026-11-06T12:00:00Z'));
  });

  it('rejects statements outside the allow-list', async () => {
    const res = await run('SELECT * FROM monthly_usage');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: '002003', sqlState: '42000' });
  });
});
