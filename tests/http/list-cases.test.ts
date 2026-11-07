/**
 * `GET /v1/cases` through the real server against the mock upstreams
 * (S3-1, S3-5, S3-9, S3-10, S3-11, S3-12, S3-14). Every response passes the
 * server's strict response validation, so a contract drift fails here too.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import type { RunningServer } from '../../src/server.js';
import { createMockApp, type MockApp } from '../../mocks/server.js';
import { captureLogs, FIXTURE_NOW, startServerWithAuth, waitForReady } from './helpers.js';

/** S1 §4: the approved answer to the Copilot question, in `openedAt` order. */
const GROUND_TRUTH = ['CS-10231', 'CS-10236', 'CS-10239', 'CS-10240', 'CS-10233'];
const COPILOT_QUERY =
  'status=open&status=in_progress&priority=P1&accountTier=platinum&renewalWithinDays=90&openedBefore=2026-11-04T12:00:00Z';

interface Mocks {
  url: string;
  mock: MockApp;
  /** Path and query of every case-system request, as the upstream received it. */
  caseCalls: string[];
  close(): Promise<void>;
}

/**
 * Mock upstreams that record full case-system URLs. The shared recorder
 * keeps only the path, and this suite needs the query the upstream saw.
 */
async function startMocks(): Promise<Mocks> {
  const mock = createMockApp({ clock: fixedClock(FIXTURE_NOW) });
  const caseCalls: string[] = [];
  const app = express();
  app.use((req, _res, next) => {
    if (req.path.startsWith('/cases')) caseCalls.push(decodeURIComponent(req.originalUrl));
    next();
  });
  app.use(mock.app);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    mock,
    caseCalls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

let running: RunningServer | undefined;
let mocks: Mocks | undefined;
let auth = { authorization: '' };
afterEach(async () => {
  await running?.shutdown();
  await mocks?.close();
  running = undefined;
  mocks = undefined;
});

let clock = fixedClock(FIXTURE_NOW);

async function start(options: { entitlementDown?: boolean } = {}): Promise<void> {
  clock = fixedClock(FIXTURE_NOW);
  mocks = await startMocks();
  if (options.entitlementDown === true) {
    mocks.mock.faults.update('entitlement', { forceStatus: 503 });
  }
  ({ running, auth } = await startServerWithAuth(captureLogs().logger, {
    env: { MOCKS_URL: mocks.url },
    clock,
  }));
  if (options.entitlementDown !== true) await waitForReady(running.url);
}

interface CaseBody {
  id: string;
  accountId: string;
  account: { name: string; supportTier: string; renewalDate: string } | null;
  openedAt: string;
}
interface ListBody {
  data: CaseBody[];
  nextCursor: string | null;
  degraded: boolean;
  sources: { system: string; status: string; asOf: string | null }[];
}
interface Problem {
  type: string;
  status: number;
}

async function get(query: string): Promise<{ status: number; text: string }> {
  // The validator requires reserved characters in query values to be percent-encoded.
  const encoded = query.replaceAll(':', '%3A');
  const res = await fetch(`${running?.url ?? ''}/v1/cases?${encoded}`, { headers: auth });
  return { status: res.status, text: await res.text() };
}

async function list(query: string): Promise<ListBody> {
  const { status, text } = await get(query);
  expect(status, text).toBe(200);
  return JSON.parse(text) as ListBody;
}

async function problem(query: string): Promise<Problem> {
  const { text } = await get(query);
  return JSON.parse(text) as Problem;
}

const ids = (body: ListBody): string[] => body.data.map((c) => c.id);
const type = (name: string): string => `https://support-platform.example/problems/${name}`;

/** Follows `nextCursor` to the end, returning every page. */
async function allPages(query: string): Promise<ListBody[]> {
  const pages = [await list(query)];
  for (let cursor = pages[0]?.nextCursor; cursor; cursor = pages.at(-1)?.nextCursor) {
    pages.push(await list(`${query}&cursor=${cursor}`));
    if (pages.length > 10) throw new Error('paging did not end');
  }
  return pages;
}

describe('the Copilot question (S3-1)', () => {
  it('returns exactly the S1 ground truth on one page, joined with the snapshot', async () => {
    await start();
    const body = await list(COPILOT_QUERY);
    expect(new Set(ids(body))).toEqual(new Set(GROUND_TRUTH));
    expect(ids(body)).toEqual(GROUND_TRUTH);
    expect(body.nextCursor).toBeNull();
    expect(body.degraded).toBe(false);
    expect(body.data.find((c) => c.id === 'CS-10231')?.account).toEqual({
      name: 'Acme Corp',
      supportTier: 'platinum',
      renewalDate: '2027-01-15',
    });
    expect(body.sources.map((s) => [s.system, s.status])).toEqual([
      ['case_system', 'ok'],
      ['entitlement_export', 'ok'],
      ['entitlement_feed', 'ok'],
    ]);
    expect(body.sources[0]?.asOf).toBe(FIXTURE_NOW);
  });

  it('sends the entitlement filters to the case system as an account list', async () => {
    await start();
    await list(COPILOT_QUERY);
    expect(mocks?.caseCalls).toHaveLength(1);
    const call = new URL(mocks?.caseCalls[0] ?? '', 'http://x');
    expect(call.searchParams.get('accountId')).toBe('ACC-007,ACC-012,ACC-030,ACC-042');
    expect(call.searchParams.get('status')).toBe('open,in_progress');
    expect(call.searchParams.get('priority')).toBe('P1');
    expect(call.searchParams.get('openedBefore')).toBe('2026-11-04T12:00:00Z');
    expect(call.searchParams.get('sort')).toBe('openedAt');
  });
});

describe('cursor paging (S3-9)', () => {
  it('pages through the Copilot query two at a time, each case once, in order', async () => {
    await start();
    const pages = await allPages(`${COPILOT_QUERY}&limit=2`);
    expect(pages.map((p) => p.data.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap(ids)).toEqual(GROUND_TRUTH);
    expect(pages.at(-1)?.nextCursor).toBeNull();
  });

  it('accepts a cursor when only limit changes', async () => {
    await start();
    const first = await list(`${COPILOT_QUERY}&limit=2`);
    const rest = await list(`${COPILOT_QUERY}&limit=10&cursor=${first.nextCursor ?? ''}`);
    expect([...ids(first), ...ids(rest)]).toEqual(GROUND_TRUTH);
  });

  it('rejects a cursor reused with a changed filter or sort, or tampered', async () => {
    await start();
    const cursor = (await list(`${COPILOT_QUERY}&limit=2`)).nextCursor ?? '';
    expect(cursor).not.toBe('');
    const calls = mocks?.caseCalls.length;
    const changed = [
      COPILOT_QUERY.replace('&status=in_progress', ''),
      COPILOT_QUERY.replace('renewalWithinDays=90', 'renewalWithinDays=89'),
      COPILOT_QUERY.replace('accountTier=platinum', 'accountTier=gold'),
      `${COPILOT_QUERY}&sort=-openedAt`,
      `${COPILOT_QUERY}&accountId=ACC-007`,
    ];
    for (const query of changed) {
      expect(await problem(`${query}&limit=2&cursor=${cursor}`)).toMatchObject({
        type: type('invalid-cursor'),
        status: 400,
      });
    }
    const flipped = `${cursor.slice(0, -3)}${cursor.endsWith('AAA') ? 'BBB' : 'AAA'}`;
    for (const bad of [flipped, 'garbage', Buffer.from('{"v":1}').toString('base64url')]) {
      expect(await problem(`${COPILOT_QUERY}&cursor=${bad}`)).toMatchObject({
        type: type('invalid-cursor'),
      });
    }
    // A rejected cursor never reaches the case system.
    expect(mocks?.caseCalls.length).toBe(calls);
  });
});

describe('time boundaries and ties (S3-10)', () => {
  const at = '2026-11-01T09:00:00Z';

  it('openedBefore is exclusive and openedAfter inclusive at the exact instant', async () => {
    await start();
    const before = await list(`openedBefore=${at}&openedAfter=2026-10-31T00:00:00Z`);
    expect(ids(before)).toEqual([]);
    const after = await list(`openedAfter=${at}&openedBefore=2026-11-01T09:00:01Z`);
    expect(ids(after)).toEqual(['CS-10236', 'CS-10237', 'CS-10238', 'CS-10241']);
  });

  it('orders ties on openedAt by case ID, across a page boundary', async () => {
    await start();
    const pages = await allPages(`openedAfter=${at}&openedBefore=2026-11-01T09:00:01Z&limit=3`);
    expect(pages.flatMap(ids)).toEqual(['CS-10236', 'CS-10237', 'CS-10238', 'CS-10241']);
    // Descending reverses the openedAt order, but the ID tie-break stays ascending.
    const desc = await list(
      'sort=-openedAt&openedAfter=2026-11-01T00:00:00Z&openedBefore=2026-11-03T00:00:00Z',
    );
    expect(ids(desc)).toEqual(['CS-10239', 'CS-10236', 'CS-10237', 'CS-10238', 'CS-10241']);
  });
});

describe('cross-system edge cases', () => {
  it('returns an empty page without calling the case system when no account matches', async () => {
    await start();
    const body = await list('accountTier=silver');
    expect(body).toMatchObject({ data: [], nextCursor: null, degraded: false });
    const intersected = await list('accountTier=platinum&accountId=ACC-021');
    expect(intersected.data).toEqual([]);
    expect(mocks?.caseCalls).toEqual([]);
    // Not read, so not listed as a source.
    expect(body.sources.map((x) => x.system)).toEqual(['entitlement_export', 'entitlement_feed']);
  });

  it('shows a case with no entitlement record with account null and reports it as unmatched', async () => {
    await start();
    const body = await list('accountId=ACC-099');
    expect(body.data).toEqual([expect.objectContaining({ id: 'CS-10241', account: null })]);
    expect(body.degraded).toBe(false);
    const ready = (await (await fetch(`${running?.url ?? ''}/readyz`)).json()) as {
      unmatchedAccountIds: string[];
    };
    expect(ready.unmatchedAccountIds).toContain('ACC-099');
  });

  it('never returns upstream field names or concurrency tokens (S3-11)', async () => {
    await start();
    for (const query of [COPILOT_QUERY, 'limit=100', `${COPILOT_QUERY}&limit=1`]) {
      const { text } = await get(query);
      for (const name of ['"Status"', '"Comments"', '"IsEscalated"', '"version"', '"etag"']) {
        expect(text).not.toContain(name);
      }
    }
  });
});

describe('entitlement unavailable (S3-5, list part)', () => {
  it('degrades without entitlement filters and refuses to filter on them', async () => {
    await start({ entitlementDown: true });
    const body = await list('priority=P1');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((c) => c.account === null)).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.sources.slice(1)).toEqual([
      { system: 'entitlement_export', status: 'unavailable', asOf: null },
      { system: 'entitlement_feed', status: 'unavailable', asOf: null },
    ]);
    // Unusable data is not evidence of an unmatched account.
    const ready = (await (await fetch(`${running?.url ?? ''}/readyz`)).json()) as {
      unmatchedAccountIds: string[];
    };
    expect(ready.unmatchedAccountIds).toEqual([]);

    for (const query of ['accountTier=platinum', 'renewalWithinDays=90']) {
      const res = await get(query);
      expect(res.status).toBe(503);
      expect(JSON.parse(res.text)).toMatchObject({ type: type('entitlement-stale') });
    }
  });
});

describe('case system failure', () => {
  it('maps exhausted 5xx from the case system to 502 upstream-error', async () => {
    await start();
    mocks?.mock.faults.update('cases', { forceStatus: 503 });
    const res = await get('priority=P1');
    expect(res.status).toBe(502);
    expect(JSON.parse(res.text)).toMatchObject({ type: type('upstream-error') });
    expect(res.text).not.toContain('errorCode');
  });
});

describe('entitlement too old (S3-5, list part)', () => {
  it('past 48 hours: refuses entitlement filters, degrades without them, both feeds stale', async () => {
    await start();
    // The export is from 2026-11-06T02:00Z; one minute past the limit.
    clock.set('2026-11-08T02:01:00Z');
    const token = await running?.issuer?.mint({
      sub: 'jdoe',
      clientId: 'support-console',
      scopes: ['cases:read'],
    });
    auth = { authorization: `Bearer ${token ?? ''}` };
    expect((await problem('accountTier=platinum')).type).toBe(type('entitlement-stale'));
    const body = await list('priority=P1');
    expect(body.degraded).toBe(true);
    expect(body.data.every((c) => c.account === null)).toBe(true);
    expect(body.sources.slice(1).map((x) => x.status)).toEqual(['stale', 'stale']);
  });
});
