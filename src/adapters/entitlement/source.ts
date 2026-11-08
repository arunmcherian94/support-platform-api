import type { Clock } from '../../clock.js';
import type { Logger } from '../../observability/logger.js';
import type {
  AccountEntitlement,
  EntitlementSnapshot,
  EntitlementSource,
  EntitlementSystem,
  FeedState,
  SnapshotState,
} from '../../ports/entitlement.js';
import { UpstreamError } from '../errors.js';
import type { UpstreamClient, UpstreamResponse } from '../types.js';
import { parseAccountsCsv, type CsvAccountRow } from './csv.js';
import { loadCrosswalk } from './ids.js';
import { buildSnapshot, type DataQualityEvent } from './snapshot.js';
import { parseEntitlementsXml, type XmlAccountRow } from './xml.js';

export const EXPORT_PATH = '/exports/accounts.csv';
export const FEED_PATH = '/feeds/entitlements.xml';
/** Older than this, measured from the CSV export time, the snapshot is unusable (ADR-0003). */
export const MAX_EXPORT_AGE_MS = 48 * 60 * 60 * 1000;

export interface EntitlementSourceOptions {
  client: UpstreamClient;
  clock: Clock;
  logger: Logger;
  refreshSeconds: number;
  /** Source ID → canonical ID; defaults to the fixture crosswalk (stands in for MDM). */
  crosswalk?: ReadonlyMap<string, string>;
}

/** One feed's last good data, its validators and its health. */
interface FeedCache<Rows> {
  system: EntitlementSystem;
  path: string;
  rows: Rows | null;
  asOf: string | null;
  status: FeedState['status'];
  etag: string | null;
  lastModified: string | null;
}

interface Parsed<Rows> {
  rows: Rows;
  /** The time the source says it produced the data, if it says. */
  producedAt: string | null;
  events: DataQualityEvent[];
}

const MESSAGES: Record<DataQualityEvent['kind'], string> = {
  duplicate_account: 'duplicate entitlement row resolved',
  unknown_id: 'entitlement row with an unrecognised account ID skipped',
  xml_only_account: 'feed account has no export row',
  source_disagreement: 'export and feed disagree; precedence applied',
  malformed_row: 'malformed entitlement row skipped',
};

/** RFC 3339 in UTC, without milliseconds when they are zero. */
function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function validTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function failureKind(error: unknown): string {
  if (error instanceof UpstreamError) return error.kind;
  return 'bad_response';
}

export function createEntitlementSource(options: EntitlementSourceOptions): EntitlementSource {
  const { client, clock, logger } = options;
  const crosswalk = options.crosswalk ?? loadCrosswalk();
  const intervalMs = Math.max(1, options.refreshSeconds) * 1000;

  const exportFeed: FeedCache<CsvAccountRow[]> = {
    system: 'entitlement_export',
    path: EXPORT_PATH,
    rows: null,
    asOf: null,
    status: 'unavailable',
    etag: null,
    lastModified: null,
  };
  const entitlementFeed: FeedCache<XmlAccountRow[]> = {
    system: 'entitlement_feed',
    path: FEED_PATH,
    rows: null,
    asOf: null,
    status: 'unavailable',
    etag: null,
    lastModified: null,
  };

  let accounts: ReadonlyMap<string, AccountEntitlement> | null = null;
  const reported = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let started: Promise<void> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const logEvents = (events: readonly DataQualityEvent[]): void => {
    for (const event of events) {
      logger.warn({ event: 'data_quality', ...event }, MESSAGES[event.kind]);
    }
  };

  /** Fetches one feed. Returns true when new data replaced the old. Never throws. */
  async function refreshFeed<Rows>(
    feed: FeedCache<Rows>,
    parse: (response: UpstreamResponse) => Parsed<Rows>,
  ): Promise<boolean> {
    const fetchedAt = clock.now().getTime();
    const headers: Record<string, string> = {};
    if (feed.rows !== null) {
      if (feed.etag !== null) headers['If-None-Match'] = feed.etag;
      if (feed.lastModified !== null) headers['If-Modified-Since'] = feed.lastModified;
    }
    try {
      const response: UpstreamResponse = await client.request({ path: feed.path, headers });
      if (response.status === 304) {
        if (feed.rows === null) throw new Error('304 Not Modified with no data loaded');
        feed.status = 'ok';
        return false;
      }
      const parsed = parse(response);
      logEvents(parsed.events);
      const lastModified = response.headers.get('Last-Modified');
      const producedAt = validTime(parsed.producedAt) ?? validTime(lastModified) ?? fetchedAt;
      feed.rows = parsed.rows;
      feed.asOf = rfc3339(producedAt);
      feed.etag = response.headers.get('ETag');
      feed.lastModified = lastModified;
      feed.status = 'ok';
      return true;
    } catch (error) {
      feed.status = feed.rows === null ? 'unavailable' : 'stale';
      logger.warn(
        {
          event: 'entitlement_refresh_failed',
          source: feed.system,
          failure: failureKind(error),
          status: feed.status,
          asOf: feed.asOf,
        },
        'entitlement refresh failed; keeping the last good data',
      );
      return false;
    }
  }

  function rebuild(): void {
    if (exportFeed.rows === null || exportFeed.asOf === null) return;
    const built = buildSnapshot({
      csv: { rows: exportFeed.rows, exportedAt: exportFeed.asOf },
      xml:
        entitlementFeed.rows === null || entitlementFeed.asOf === null
          ? null
          : { rows: entitlementFeed.rows, generatedAt: entitlementFeed.asOf },
      crosswalk,
    });
    logEvents(built.events);
    accounts = built.accounts;
  }

  async function refresh(): Promise<void> {
    const [exportChanged, feedChanged] = await Promise.all([
      // Export time: X-Export-Timestamp, else Last-Modified, else fetch time.
      refreshFeed(exportFeed, (response) => {
        const { rows, events } = parseAccountsCsv(response.text);
        return { rows, events, producedAt: response.headers.get('X-Export-Timestamp') };
      }),
      // Feed time: generatedAt, else Last-Modified, else fetch time.
      refreshFeed(entitlementFeed, (response) => {
        const { rows, events, generatedAt } = parseEntitlementsXml(response.text);
        return { rows, events, producedAt: generatedAt };
      }),
    ]);
    if (exportChanged || feedChanged) rebuild();
  }

  /** Runs one refresh unless one is already running (a slow upstream must not pile up polls). */
  function tick(): Promise<void> {
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function snapshot(): EntitlementSnapshot | null {
    if (accounts === null) return null;
    return {
      accounts,
      export: { status: exportFeed.status, asOf: exportFeed.asOf },
      feed: { status: entitlementFeed.status, asOf: entitlementFeed.asOf },
    };
  }

  return {
    current(): SnapshotState {
      const current = snapshot();
      if (current === null || exportFeed.asOf === null) {
        return { usable: false, reason: 'never_loaded' };
      }
      const age = clock.now().getTime() - Date.parse(exportFeed.asOf);
      if (age > MAX_EXPORT_AGE_MS) return { usable: false, reason: 'too_old', snapshot: current };
      return { usable: true, snapshot: current };
    },

    reportUnmatched(accountId: string): void {
      if (accounts?.has(accountId) === true || reported.has(accountId)) return;
      reported.add(accountId);
      logger.warn(
        { event: 'data_quality', kind: 'unmatched_account', accountId },
        'case account has no entitlement record',
      );
    },

    start(): Promise<void> {
      started ??= tick().then(() => {
        if (stopped) return;
        timer = setInterval(() => {
          void tick();
        }, intervalMs);
        timer.unref();
      });
      return started;
    },

    stop(): void {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
