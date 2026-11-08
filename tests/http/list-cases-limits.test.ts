/** The 500-account guard, through the handler (S3 §2.5 step 1, S3-9). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Upstreams } from '../../src/adapters/index.js';
import { fixedClock } from '../../src/clock.js';
import { listCasesHandler } from '../../src/http/handlers/cases.js';
import type { AccountEntitlement, EntitlementSnapshot } from '../../src/ports/entitlement.js';
import { captureLogs, FIXTURE_NOW, startTestApp, type TestApp } from './helpers.js';

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function platinumAccounts(count: number): Map<string, AccountEntitlement> {
  const accounts = new Map<string, AccountEntitlement>();
  for (let i = 1; i <= count; i++) {
    const id = `ACC-${String(i).padStart(4, '0')}`;
    accounts.set(id, {
      id,
      name: `Account ${String(i)}`,
      supportTier: 'platinum',
      renewalDate: '2027-01-15',
      arr: { amount: '1.00', currency: 'USD' },
      tierSource: 'entitlement_export',
      renewalSource: 'entitlement_export',
      inFeed: false,
    });
  }
  return accounts;
}

async function startWith(count: number) {
  const snapshot: EntitlementSnapshot = {
    accounts: platinumAccounts(count),
    export: { status: 'ok', asOf: '2026-11-06T02:00:00Z' },
    feed: { status: 'unavailable', asOf: null },
  };
  const search = vi.fn(() => Promise.resolve({ records: [], hasMore: false }));
  const upstreams = {
    cases: { search, get: vi.fn() },
    entitlement: {
      current: () => ({ usable: true, snapshot }),
      reportUnmatched: vi.fn(),
    },
  } as unknown as Upstreams;
  const handler = listCasesHandler({
    upstreams,
    clock: fixedClock(FIXTURE_NOW),
    logger: captureLogs().logger,
  });
  app = await startTestApp({ handlers: { listCases: handler } });
  return { search };
}

describe('the account-list guard', () => {
  it('answers 400 validation-failed above 500 accounts, without calling the case system', async () => {
    const { search } = await startWith(501);
    const res = await fetch(`${app?.url ?? ''}/v1/cases?accountTier=platinum`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type: string }).type).toMatch(/validation-failed$/);
    expect(search).not.toHaveBeenCalled();
  });

  it('accepts exactly 500 accounts and sends them all upstream', async () => {
    const { search } = await startWith(500);
    const res = await fetch(`${app?.url ?? ''}/v1/cases?accountTier=platinum`);
    expect(res.status).toBe(200);
    expect(search).toHaveBeenCalledTimes(1);
    const query = (search.mock.calls[0] as unknown as [{ accountIds: string[] }])[0];
    expect(query.accountIds).toHaveLength(500);
  });
});
