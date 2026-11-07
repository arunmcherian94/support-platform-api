import type { UsageMonth, UsageWarehouse } from '../ports/usage.js';
import { UpstreamError } from './errors.js';
import type { UpstreamClient } from './types.js';

/** The one statement this service sends. A constant: never built from input. */
const MONTHLY_USAGE_STATEMENT =
  'SELECT account_id, month, protected_tb, api_calls, active_users FROM monthly_usage WHERE account_id = ? ORDER BY month DESC LIMIT ?';

function bad(cause?: unknown): UpstreamError {
  return new UpstreamError('usage_warehouse', 'bad_response', cause === undefined ? {} : { cause });
}

function parseNumber(value: unknown, integer: boolean, what: string): number {
  if (typeof value !== 'string' || value.trim() === '') {
    throw bad(`${what} is not a numeric string`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw bad(`${what} is out of range`);
  }
  return n;
}

// Column order is fixed by the statement: account_id, month, protected_tb, api_calls, active_users.
function parseRow(row: unknown): UsageMonth {
  if (!Array.isArray(row) || row.length !== 5) throw bad('row shape');
  const [, month, protectedTb, apiCalls, activeUsers] = row as unknown[];
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('month');
  return {
    month,
    protectedTb: parseNumber(protectedTb, false, 'protected_tb'),
    apiCalls: parseNumber(apiCalls, true, 'api_calls'),
    activeUsers: parseNumber(activeUsers, true, 'active_users'),
  };
}

export function createUsageWarehouse(client: UpstreamClient): UsageWarehouse {
  return {
    async monthlyUsage(accountId: string, months: number): Promise<UsageMonth[]> {
      // A read-only statement, so a retry cannot change anything.
      const response = await client.request({
        method: 'POST',
        path: '/api/v2/statements',
        retryable: true,
        body: {
          statement: MONTHLY_USAGE_STATEMENT,
          bindings: {
            '1': { type: 'TEXT', value: accountId },
            '2': { type: 'FIXED', value: String(months) },
          },
        },
      });
      let body: unknown;
      try {
        body = JSON.parse(response.text);
      } catch (error) {
        throw bad(error);
      }
      const data =
        typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
      if (!Array.isArray(data)) throw bad('data is not an array');
      return (data as unknown[]).map(parseRow);
    },
  };
}
