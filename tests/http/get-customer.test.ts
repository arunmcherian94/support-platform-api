/**
 * `GET /v1/customers/{customerId}` through the real server against the mock
 * upstreams (S3-2, S3-3, S3-4, S3-5, S3-14). Responses are validated against
 * the contract by the server itself, so every 200 here is also schema-checked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock, type TestClock } from '../../src/clock.js';
import type { RunningServer } from '../../src/server.js';
import {
  captureLogs,
  FIXTURE_NOW,
  startRecordingMocks,
  startServerWithAuth,
  waitForReady,
} from './helpers.js';

let running: RunningServer | undefined;
let mocks: Awaited<ReturnType<typeof startRecordingMocks>> | undefined;
afterEach(async () => {
  await running?.shutdown();
  await mocks?.close();
  running = undefined;
  mocks = undefined;
});

interface Source {
  system: string;
  status: string;
  asOf: string | null;
  fields?: string[];
}
interface CustomerBody {
  id: string;
  name: string;
  supportTier: string;
  renewalDate: string;
  arr?: { amount: string; currency: string };
  usage: Record<string, unknown> | null;
  degraded: boolean;
  sources: Source[];
}

const BASE_SCOPES = ['customers:read', 'cases:read'];

/** Starts mocks and the real server; returns callers with and without `finance:read`. */
async function start(
  options: {
    setup?: (m: NonNullable<typeof mocks>) => void;
    clock?: TestClock;
    ready?: boolean;
  } = {},
): Promise<{
  get: (id: string, finance: boolean) => Promise<Response>;
  logs: ReturnType<typeof captureLogs>;
}> {
  mocks = await startRecordingMocks();
  options.setup?.(mocks);
  const logs = captureLogs();
  ({ running } = await startServerWithAuth(logs.logger, {
    env: { MOCKS_URL: mocks.url },
    clock: options.clock ?? fixedClock(FIXTURE_NOW),
  }));
  const server = running;
  // Tokens are minted per call: the issuer reads the injected clock, so a token
  // minted before a clock jump would be expired after it.
  const tokenFor = (withFinance: boolean): Promise<string> | undefined =>
    server.issuer?.mint(
      withFinance
        ? {
            sub: 'fin-analyst',
            clientId: 'finance-console',
            scopes: [...BASE_SCOPES, 'finance:read'],
          }
        : { sub: 'jdoe', clientId: 'support-console', scopes: BASE_SCOPES },
    );
  if (options.ready !== false) await waitForReady(server.url);
  return {
    logs,
    get: async (id, withFinance) =>
      fetch(`${server.url}/v1/customers/${id}`, {
        headers: { authorization: `Bearer ${String(await tokenFor(withFinance))}` },
      }),
  };
}

const sourceOf = (body: CustomerBody, system: string): Source | undefined =>
  body.sources.find((s) => s.system === system);

describe('ARR by scope (S3-3)', () => {
  it('includes ARR, and lists it as an export field, with finance:read', async () => {
    const { get } = await start();
    const res = await get('ACC-007', true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomerBody;
    expect(body.arr).toEqual({ amount: '480000.00', currency: 'USD' });
    expect(sourceOf(body, 'entitlement_export')?.fields).toContain('arr');
  });

  it('omits the ARR key entirely without finance:read, leaving no trace of the amount', async () => {
    const { get } = await start();
    const res = await get('ACC-007', false);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('480000');
    const body = JSON.parse(text) as CustomerBody;
    expect(Object.keys(body)).not.toContain('arr');
    expect(sourceOf(body, 'entitlement_export')?.fields).not.toContain('arr');
  });
});

describe('the full summary', () => {
  it('matches the contract shape, key order and provenance for ACC-007', async () => {
    const { get } = await start();
    const body = (await (await get('ACC-007', true)).json()) as CustomerBody;
    expect(Object.keys(body)).toEqual([
      'id',
      'name',
      'supportTier',
      'renewalDate',
      'arr',
      'usage',
      'degraded',
      'sources',
    ]);
    expect(body).toEqual({
      id: 'ACC-007',
      name: 'Acme Corp',
      supportTier: 'platinum',
      renewalDate: '2027-01-15',
      arr: { amount: '480000.00', currency: 'USD' },
      usage: {
        latestMonth: '2026-10',
        protectedTb: 426,
        apiCalls: 1251900,
        activeUsers: 89,
        changeFromPreviousMonthPct: { protectedTb: 3.3, apiCalls: 4.0, activeUsers: 2.3 },
      },
      degraded: false,
      sources: [
        {
          system: 'entitlement_export',
          status: 'ok',
          asOf: '2026-11-06T02:00:00Z',
          fields: ['name', 'arr'],
        },
        {
          system: 'entitlement_feed',
          status: 'ok',
          asOf: '2026-11-06T11:00:00Z',
          fields: ['supportTier', 'renewalDate'],
        },
        {
          system: 'usage_warehouse',
          status: 'ok',
          asOf: '2026-11-01T00:00:00Z',
          fields: ['usage'],
        },
      ],
    });
  });
});

describe('entitlement precedence and IDs in the response (S3-2)', () => {
  it('takes ACC-030 renewal from the feed and says so', async () => {
    const { get } = await start();
    const body = (await (await get('ACC-030', false)).json()) as CustomerBody;
    expect(body.renewalDate).toBe('2027-01-31');
    expect(sourceOf(body, 'entitlement_feed')?.fields).toContain('renewalDate');
    expect(sourceOf(body, 'entitlement_export')?.fields).not.toContain('renewalDate');
  });

  it('takes ACC-042 tier from the feed', async () => {
    const { get } = await start();
    const body = (await (await get('ACC-042', false)).json()) as CustomerBody;
    expect(body.supportTier).toBe('platinum');
    expect(sourceOf(body, 'entitlement_feed')?.fields).toContain('supportTier');
  });

  it('serves the CSV row ACC-77 as ACC-007', async () => {
    const { get } = await start();
    const res = await get('ACC-007', false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomerBody;
    expect(body.id).toBe('ACC-007');
    expect(body.name).toBe('Acme Corp');
  });

  it('uses the latest ACC-012 contract, with its renewal and ARR from the export', async () => {
    const { get } = await start();
    const body = (await (await get('ACC-012', true)).json()) as CustomerBody;
    expect(body.renewalDate).toBe('2027-02-03');
    expect(body.supportTier).toBe('platinum');
    expect(body.arr).toEqual({ amount: '350000.00', currency: 'USD' });
    expect(sourceOf(body, 'entitlement_export')?.fields).toEqual([
      'name',
      'supportTier',
      'renewalDate',
      'arr',
    ]);
  });

  it('reports the feed as no_data for an account it has no row for (ACC-015)', async () => {
    const { get } = await start();
    const body = (await (await get('ACC-015', false)).json()) as CustomerBody;
    expect(sourceOf(body, 'entitlement_feed')).toMatchObject({ status: 'no_data', fields: [] });
  });
});

describe('usage is optional (S3-4)', () => {
  it('serves 200 degraded with the warehouse unavailable when it is down', async () => {
    const { get, logs } = await start({
      setup: (m) => m.mock.faults.update('warehouse', { forceStatus: 503 }),
    });
    const res = await get('ACC-007', false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomerBody;
    expect(body.usage).toBeNull();
    expect(body.degraded).toBe(true);
    expect(body.name).toBe('Acme Corp');
    expect(sourceOf(body, 'usage_warehouse')).toEqual({
      system: 'usage_warehouse',
      status: 'unavailable',
      asOf: null,
      fields: [],
    });
    const warning = logs
      .lines()
      .find((l) => l.upstream === 'usage_warehouse' && l.kind === 'server_error');
    expect(warning?.level).toBe('warn');
  });

  it('serves 200 degraded when the warehouse drops the connection', async () => {
    const { get } = await start({
      setup: (m) => m.mock.faults.update('warehouse', { down: true }),
    });
    const res = await get('ACC-007', false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomerBody;
    expect(body.degraded).toBe(true);
    expect(sourceOf(body, 'usage_warehouse')?.status).toBe('unavailable');
  });

  it('reports no_data, not degraded, for a customer with no usage rows (ACC-015)', async () => {
    const { get } = await start();
    const res = await get('ACC-015', false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CustomerBody;
    expect(body.usage).toBeNull();
    expect(body.degraded).toBe(false);
    expect(sourceOf(body, 'usage_warehouse')).toEqual({
      system: 'usage_warehouse',
      status: 'no_data',
      asOf: null,
      fields: [],
    });
  });

  it('does not involve the case system', async () => {
    const { get } = await start({
      setup: (m) => m.mock.faults.update('cases', { forceStatus: 503 }),
    });
    expect((await get('ACC-007', false)).status).toBe(200);
    expect(mocks?.seen.some((s) => s.path.startsWith('/cases'))).toBe(false);
  });
});

describe('entitlement is required (S3-5)', () => {
  it('gives 503 entitlement-stale when the snapshot never loaded', async () => {
    const { get } = await start({
      setup: (m) => m.mock.faults.update('entitlement', { forceStatus: 503 }),
      ready: false,
    });
    const res = await get('ACC-007', true);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { type: string };
    expect(body.type).toMatch(/\/entitlement-stale$/);
  });

  it('gives 503 entitlement-stale once the export is older than 48 hours', async () => {
    const clock = fixedClock(FIXTURE_NOW);
    const { get } = await start({ clock });
    expect((await get('ACC-007', false)).status).toBe(200);
    // The export is from 2026-11-06T02:00Z; one minute past 48 hours later.
    clock.set('2026-11-08T02:01:00Z');
    const res = await get('ACC-007', false);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { type: string }).type).toMatch(/\/entitlement-stale$/);
  });
});

describe('unknown customer', () => {
  it('gives 404 not-found', async () => {
    const { get } = await start();
    const res = await get('ACC-999', true);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { type: string }).type).toMatch(/\/not-found$/);
  });
});
