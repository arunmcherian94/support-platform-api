import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../../src/adapters/errors.js';
import type {
  UpstreamClient,
  UpstreamRequest,
  UpstreamResponse,
} from '../../src/adapters/types.js';
import { createUsageWarehouse } from '../../src/adapters/warehouse.js';
import { useMockServer } from '../mocks/helpers.js';

const h = useMockServer();

const realClient = (seen: UpstreamRequest[] = []): UpstreamClient => ({
  upstream: 'usage_warehouse',
  health: () => 'ok',
  async request(request: UpstreamRequest): Promise<UpstreamResponse> {
    seen.push(request);
    const res = await fetch(`${h.url}${request.path}`, {
      method: request.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new UpstreamError(
        'usage_warehouse',
        res.status >= 500 ? 'server_error' : 'client_error',
        {
          status: res.status,
        },
      );
    }
    return { status: res.status, headers: res.headers, text };
  },
});

const fakeClient = (text: string): UpstreamClient => ({
  upstream: 'usage_warehouse',
  health: () => 'ok',
  request: () => Promise.resolve({ status: 200, headers: new Headers(), text }),
});

describe('usage warehouse adapter', () => {
  it('returns ACC-007 months newest first as numbers', async () => {
    const months = await createUsageWarehouse(realClient()).monthlyUsage('ACC-007', 2);
    expect(months).toEqual([
      { month: '2026-10', protectedTb: 426, apiCalls: 1251900, activeUsers: 89 },
      { month: '2026-09', protectedTb: 412.5, apiCalls: 1203331, activeUsers: 87 },
    ]);
  });

  it('returns an empty array for an account with no usage data', async () => {
    expect(await createUsageWarehouse(realClient()).monthlyUsage('ACC-015', 2)).toEqual([]);
  });

  it('sends the constant statement as a retryable POST with bound values', async () => {
    const seen: UpstreamRequest[] = [];
    await createUsageWarehouse(realClient(seen)).monthlyUsage("ACC-007'; DROP TABLE x; --", 1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/api/v2/statements',
      retryable: true,
    });
    const body = seen[0]?.body as { statement: string; bindings: unknown };
    expect(body.statement).not.toContain('DROP');
    expect(body.bindings).toEqual({
      '1': { type: 'TEXT', value: "ACC-007'; DROP TABLE x; --" },
      '2': { type: 'FIXED', value: '1' },
    });
  });

  const row = (month: string, tb: string, calls: string, users: string): unknown[] => [
    'ACC-007',
    month,
    tb,
    calls,
    users,
  ];

  it.each([
    ['invalid JSON', 'nope'],
    ['no data array', '{"data":"x"}'],
    ['short row', JSON.stringify({ data: [['ACC-007', '2026-10']] })],
    ['bad month', JSON.stringify({ data: [row('2026-13', '1', '1', '1')] })],
    ['non-numeric tb', JSON.stringify({ data: [row('2026-10', 'abc', '1', '1')] })],
    ['negative tb', JSON.stringify({ data: [row('2026-10', '-1', '1', '1')] })],
    ['fractional calls', JSON.stringify({ data: [row('2026-10', '1', '1.5', '1')] })],
    ['fractional users', JSON.stringify({ data: [row('2026-10', '1', '1', '2.5')] })],
    ['infinite tb', JSON.stringify({ data: [row('2026-10', 'Infinity', '1', '1')] })],
    ['number instead of string', JSON.stringify({ data: [['ACC-007', '2026-10', 1, '1', '1']] })],
  ])('maps a malformed response (%s) to bad_response', async (_name, text) => {
    await expect(
      createUsageWarehouse(fakeClient(text)).monthlyUsage('ACC-007', 2),
    ).rejects.toMatchObject({ upstream: 'usage_warehouse', kind: 'bad_response' });
  });
});
