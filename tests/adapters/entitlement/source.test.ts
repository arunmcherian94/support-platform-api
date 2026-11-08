import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntitlementSource } from '../../../src/adapters/entitlement/source.js';
import { UpstreamError } from '../../../src/adapters/errors.js';
import type {
  UpstreamClient,
  UpstreamRequest,
  UpstreamResponse,
} from '../../../src/adapters/types.js';
import { fixedClock, type TestClock } from '../../../src/clock.js';
import { createLogger } from '../../../src/observability/logger.js';
import type { EntitlementSource, SnapshotState } from '../../../src/ports/entitlement.js';

const fixtures = new URL('../../../mocks/fixtures/entitlement/', import.meta.url);
const CSV = readFileSync(new URL('accounts.csv', fixtures), 'utf8');
const XML = readFileSync(new URL('entitlements.xml', fixtures), 'utf8');
const EXPORTED_AT = '2026-11-06T02:00:00Z';
const GENERATED_AT = '2026-11-06T11:00:00Z';
const NOW = '2026-11-06T12:00:00Z';
const REFRESH_SECONDS = 60;
const CSV_PATH = '/exports/accounts.csv';
const XML_PATH = '/feeds/entitlements.xml';

type Route = (request: UpstreamRequest) => UpstreamResponse;

function response(status: number, text: string, headers: Record<string, string>): UpstreamResponse {
  return { status, text, headers: new Headers(headers) };
}

/** A feed that answers 304 to a matching If-None-Match, like the mock ERP. */
function servedFeed(text: string, headers: Record<string, string>): Route {
  return (request) =>
    request.headers?.['If-None-Match'] !== undefined &&
    request.headers['If-None-Match'] === headers.ETag
      ? response(304, '', headers)
      : response(200, text, headers);
}

const csvRoute = (text = CSV, etag = '"csv-v1"'): Route =>
  servedFeed(text, {
    ETag: etag,
    'Last-Modified': new Date(EXPORTED_AT).toUTCString(),
    'X-Export-Timestamp': EXPORTED_AT,
  });

const xmlRoute = (text = XML, etag = '"xml-v1"'): Route =>
  servedFeed(text, { ETag: etag, 'Last-Modified': new Date(GENERATED_AT).toUTCString() });

const failing =
  (kind: 'server_error' | 'timeout' = 'server_error'): Route =>
  () => {
    throw new UpstreamError('entitlement', kind, { status: 503 });
  };

interface Harness {
  source: EntitlementSource;
  clock: TestClock;
  routes: Record<string, Route>;
  calls: UpstreamRequest[];
  logs: () => Record<string, unknown>[];
  logText: () => string;
}

const started: EntitlementSource[] = [];

function harness(routes: Record<string, Route> = {}): Harness {
  const table: Record<string, Route> = {
    [CSV_PATH]: csvRoute(),
    [XML_PATH]: xmlRoute(),
    ...routes,
  };
  const calls: UpstreamRequest[] = [];
  const client: UpstreamClient = {
    upstream: 'entitlement',
    request: (request) => {
      calls.push(request);
      const route = table[request.path];
      if (route === undefined) return Promise.reject(new Error(`no route ${request.path}`));
      try {
        return Promise.resolve(route(request));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    health: () => 'ok',
  };
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const clock = fixedClock(NOW);
  const source = createEntitlementSource({
    client,
    clock,
    logger: createLogger('info', stream),
    refreshSeconds: REFRESH_SECONDS,
  });
  started.push(source);
  const logText = (): string => chunks.join('');
  return {
    source,
    clock,
    routes: table,
    calls,
    logText,
    logs: () =>
      logText()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function usable(state: SnapshotState) {
  if (!state.usable) throw new Error(`snapshot not usable: ${state.reason}`);
  return state.snapshot;
}

const poll = () => vi.advanceTimersByTimeAsync(REFRESH_SECONDS * 1000);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const source of started.splice(0)) source.stop();
  vi.useRealTimers();
});

describe('createEntitlementSource: loading', () => {
  it('is never_loaded before start, and usable with both feeds after', async () => {
    const { source, calls } = harness();
    expect(source.current()).toEqual({ usable: false, reason: 'never_loaded' });

    await source.start();
    const snapshot = usable(source.current());
    expect(snapshot.export).toEqual({ status: 'ok', asOf: EXPORTED_AT });
    expect(snapshot.feed).toEqual({ status: 'ok', asOf: GENERATED_AT });
    expect(snapshot.accounts.get('ACC-007')?.name).toBe('Acme Corp');
    expect(snapshot.accounts.get('ACC-042')?.tierSource).toBe('entitlement_feed');
    expect(calls.map((call) => call.path).sort()).toEqual([CSV_PATH, XML_PATH]);
    expect(calls.every((call) => Object.keys(call.headers ?? {}).length === 0)).toBe(true);
  });

  it('start resolves (never rejects) when the export is down, and stays never_loaded', async () => {
    const { source, logs } = harness({ [CSV_PATH]: failing('timeout') });
    await expect(source.start()).resolves.toBeUndefined();
    expect(source.current()).toEqual({ usable: false, reason: 'never_loaded' });
    expect(logs()).toContainEqual(
      expect.objectContaining({
        event: 'entitlement_refresh_failed',
        source: 'entitlement_export',
        failure: 'timeout',
        status: 'unavailable',
      }),
    );
  });

  it('loads on a later poll after a failed first attempt', async () => {
    const h = harness({ [CSV_PATH]: failing() });
    await h.source.start();
    h.routes[CSV_PATH] = csvRoute();
    await poll();
    expect(usable(h.source.current()).export.status).toBe('ok');
  });

  it('rejects an export with a bad header as a failed refresh, not an empty snapshot', async () => {
    const { source } = harness({ [CSV_PATH]: csvRoute('id,name\nACC-1,x\n') });
    await source.start();
    expect(source.current()).toEqual({ usable: false, reason: 'never_loaded' });
  });
});

describe('createEntitlementSource: conditional polling', () => {
  it('sends validators on the next poll and keeps the data on 304', async () => {
    const h = harness();
    await h.source.start();
    const before = usable(h.source.current()).accounts;
    h.calls.length = 0;

    await poll();
    const csvCall = h.calls.find((call) => call.path === CSV_PATH);
    const xmlCall = h.calls.find((call) => call.path === XML_PATH);
    expect(csvCall?.headers).toEqual({
      'If-None-Match': '"csv-v1"',
      'If-Modified-Since': new Date(EXPORTED_AT).toUTCString(),
    });
    expect(xmlCall?.headers?.['If-None-Match']).toBe('"xml-v1"');

    const after = usable(h.source.current());
    expect(after.accounts).toBe(before); // 304: no re-parse, no rebuild
    expect(after.export).toEqual({ status: 'ok', asOf: EXPORTED_AT });
  });

  it('rebuilds when a feed changes', async () => {
    const h = harness();
    await h.source.start();
    h.routes[XML_PATH] = xmlRoute(
      XML.replace(
        '<tier>Platinum</tier>\n    <renewal>2027-01-10',
        '<tier>Silver</tier>\n    <renewal>2027-01-10',
      ),
      '"xml-v2"',
    );
    await poll();
    expect(usable(h.source.current()).accounts.get('ACC-042')?.supportTier).toBe('silver');
  });

  it('stops polling after stop()', async () => {
    const h = harness();
    await h.source.start();
    h.source.stop();
    h.calls.length = 0;
    await poll();
    await poll();
    expect(h.calls).toEqual([]);
  });
});

describe('createEntitlementSource: failures and staleness', () => {
  it('keeps the last good data and marks the export stale when a refresh fails', async () => {
    const h = harness();
    await h.source.start();
    h.routes[CSV_PATH] = failing();
    await poll();

    const snapshot = usable(h.source.current());
    expect(snapshot.export).toEqual({ status: 'stale', asOf: EXPORTED_AT });
    expect(snapshot.accounts.get('ACC-012')?.renewalDate).toBe('2027-02-03');

    // Recovery through a 304 counts as a successful refresh.
    h.routes[CSV_PATH] = csvRoute();
    await poll();
    expect(usable(h.source.current()).export.status).toBe('ok');
  });

  it('is too_old when the export is more than 48 hours old, still returning the snapshot', async () => {
    const h = harness();
    await h.source.start();

    h.clock.set('2026-11-08T02:00:00Z'); // exactly 48h: still usable
    expect(h.source.current().usable).toBe(true);

    h.clock.set('2026-11-08T03:00:00Z'); // 49h
    const state = h.source.current();
    expect(state).toMatchObject({ usable: false, reason: 'too_old' });
    expect(state.snapshot?.export.asOf).toBe(EXPORTED_AT);
  });

  it('stays usable when only the feed has never loaded; precedence falls back to the export', async () => {
    const { source } = harness({ [XML_PATH]: failing() });
    await source.start();
    const snapshot = usable(source.current());
    expect(snapshot.feed).toEqual({ status: 'unavailable', asOf: null });
    expect(snapshot.accounts.get('ACC-042')).toMatchObject({
      supportTier: 'gold',
      tierSource: 'entitlement_export',
      inFeed: false,
    });
  });

  it('marks the feed stale and keeps using its last good data when its refresh fails', async () => {
    const h = harness();
    await h.source.start();
    h.routes[XML_PATH] = failing();
    await poll();
    const snapshot = usable(h.source.current());
    expect(snapshot.feed).toEqual({ status: 'stale', asOf: GENERATED_AT });
    expect(snapshot.accounts.get('ACC-030')?.renewalDate).toBe('2027-01-31');
  });
});

describe('createEntitlementSource: timestamps', () => {
  it('falls back to Last-Modified, then the fetch time, for the export time', async () => {
    const lastModified = 'Thu, 05 Nov 2026 22:00:00 GMT';
    const a = harness({
      [CSV_PATH]: () => response(200, CSV, { ETag: '"a"', 'Last-Modified': lastModified }),
    });
    await a.source.start();
    expect(usable(a.source.current()).export.asOf).toBe('2026-11-05T22:00:00Z');

    const b = harness({ [CSV_PATH]: () => response(200, CSV, {}) });
    await b.source.start();
    expect(usable(b.source.current()).export.asOf).toBe(NOW);
  });

  it('falls back to Last-Modified when the feed has no generatedAt', async () => {
    const { source } = harness({
      [XML_PATH]: () =>
        response(200, XML.replace(` generatedAt="${GENERATED_AT}"`, ''), {
          'Last-Modified': 'Fri, 06 Nov 2026 01:00:00 GMT',
        }),
    });
    await source.start();
    const snapshot = usable(source.current());
    expect(snapshot.feed.asOf).toBe('2026-11-06T01:00:00Z');
    // Now older than the export: the export wins.
    expect(snapshot.accounts.get('ACC-042')?.tierSource).toBe('entitlement_export');
  });
});

describe('createEntitlementSource: unmatched IDs and data-quality logs', () => {
  it('logs each unmatched case account once, and never one that has a record', async () => {
    const { source, logs } = harness();
    await source.start();
    source.reportUnmatched('ACC-099');
    source.reportUnmatched('ACC-099');
    source.reportUnmatched('ACC-007'); // has a record: not unmatched
    const unmatched = logs().filter((line) => line.kind === 'unmatched_account');
    expect(unmatched.map((line) => line.accountId)).toEqual(['ACC-099']);
  });

  it('logs data-quality events with account IDs but never names or ARR', async () => {
    const { source, logs, logText } = harness();
    await source.start();
    const quality = logs().filter((line) => line.event === 'data_quality');
    expect(quality).toContainEqual(
      expect.objectContaining({ level: 'warn', kind: 'duplicate_account', accountId: 'ACC-012' }),
    );
    expect(quality).toContainEqual(
      expect.objectContaining({ kind: 'source_disagreement', accountId: 'ACC-042' }),
    );
    for (const secret of ['Acme Corp', 'Borealis', 'Fjord', '480000', '350000']) {
      expect(logText()).not.toContain(secret);
    }
  });
});
