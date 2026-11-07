import type { AccountEntitlement, EntitlementSystem } from '../../ports/entitlement.js';
import type { CsvAccountRow } from './csv.js';
import { normalizeAccountId } from './ids.js';
import type { XmlAccountRow } from './xml.js';

/**
 * Pure snapshot construction (ADR-0003, S3 §2.2): no I/O, no clock. Data-quality
 * findings are returned as events for the caller to log, so the rules here can
 * be tested on their own.
 */

export type DataQualityKind =
  'duplicate_account' | 'unknown_id' | 'xml_only_account' | 'source_disagreement' | 'malformed_row';

/** A data-quality finding. Carries IDs, never account names or ARR. */
export interface DataQualityEvent {
  kind: DataQualityKind;
  source?: EntitlementSystem;
  /** Canonical ID when known; for malformed rows, the ID as exported. */
  accountId?: string;
  /** The ID as it appeared in the source, when it differs from or lacks a canonical form. */
  sourceId?: string;
  /** CSV line (1-based). */
  line?: number;
  /** Position among the XML `<account>` elements (1-based). */
  position?: number;
  reason?: string;
  /** For disagreements: which field, each system's value and which one was served. */
  field?: 'supportTier' | 'renewalDate';
  exportValue?: string;
  feedValue?: string;
  served?: EntitlementSystem;
}

export interface SnapshotInput {
  /** Valid export rows and the export's time (RFC 3339). */
  csv: { rows: readonly CsvAccountRow[]; exportedAt: string };
  /** Valid feed rows and the feed's time; null when the feed has never loaded. */
  xml: { rows: readonly XmlAccountRow[]; generatedAt: string } | null;
  crosswalk: ReadonlyMap<string, string>;
}

export interface SnapshotBuild {
  accounts: Map<string, AccountEntitlement>;
  /** Canonical IDs in the feed with no export row, sorted. */
  xmlOnlyIds: string[];
  events: DataQualityEvent[];
}

const EXPORT: EntitlementSystem = 'entitlement_export';
const FEED: EntitlementSystem = 'entitlement_feed';

function idEvent(sourceId: string, canonical: string): Pick<DataQualityEvent, 'sourceId'> {
  return sourceId === canonical ? {} : { sourceId };
}

/** One export row per canonical ID: the latest `contract_end` wins; ties keep the first row. */
function dedupeExport(
  rows: readonly CsvAccountRow[],
  crosswalk: ReadonlyMap<string, string>,
  events: DataQualityEvent[],
): Map<string, CsvAccountRow> {
  const byId = new Map<string, CsvAccountRow>();
  for (const row of rows) {
    const id = normalizeAccountId(row.sourceId, crosswalk);
    if (id === null) {
      events.push({
        kind: 'unknown_id',
        source: EXPORT,
        sourceId: row.sourceId,
        line: row.line,
        reason: 'fits neither the crosswalk nor the ACC-NNN format',
      });
      continue;
    }
    const kept = byId.get(id);
    if (kept === undefined) {
      byId.set(id, row);
      continue;
    }
    // ISO dates compare correctly as strings.
    const [winner, loser] = row.contractEnd > kept.contractEnd ? [row, kept] : [kept, row];
    byId.set(id, winner);
    events.push({
      kind: 'duplicate_account',
      source: EXPORT,
      accountId: id,
      line: loser.line,
      reason: `superseded by line ${winner.line} (latest contract_end wins)`,
    });
  }
  return byId;
}

/** One feed row per canonical ID: the latest renewal wins; ties keep the first. */
function dedupeFeed(
  rows: readonly XmlAccountRow[],
  crosswalk: ReadonlyMap<string, string>,
  events: DataQualityEvent[],
): Map<string, XmlAccountRow> {
  const byId = new Map<string, XmlAccountRow>();
  for (const row of rows) {
    const id = normalizeAccountId(row.sourceId, crosswalk);
    if (id === null) {
      events.push({
        kind: 'unknown_id',
        source: FEED,
        sourceId: row.sourceId,
        position: row.position,
        reason: 'fits neither the crosswalk nor the ACC-NNN format',
      });
      continue;
    }
    const kept = byId.get(id);
    if (kept === undefined) {
      byId.set(id, row);
      continue;
    }
    const [winner, loser] = row.renewal > kept.renewal ? [row, kept] : [kept, row];
    byId.set(id, winner);
    events.push({
      kind: 'duplicate_account',
      source: FEED,
      accountId: id,
      position: loser.position,
      reason: `superseded by account ${winner.position} (latest renewal wins)`,
    });
  }
  return byId;
}

/**
 * Builds the account map. Field precedence: tier and renewal from the feed when
 * the feed is newer than the export and has the account; otherwise the export.
 * Name and ARR only ever come from the export, so feed-only accounts are not
 * added: they are reported as unmatched instead.
 */
export function buildSnapshot(input: SnapshotInput): SnapshotBuild {
  const events: DataQualityEvent[] = [];
  const exportRows = dedupeExport(input.csv.rows, input.crosswalk, events);
  const feedRows =
    input.xml === null
      ? new Map<string, XmlAccountRow>()
      : dedupeFeed(input.xml.rows, input.crosswalk, events);
  const feedIsNewer =
    input.xml !== null && Date.parse(input.xml.generatedAt) > Date.parse(input.csv.exportedAt);
  const preferred = feedIsNewer ? FEED : EXPORT;

  const accounts = new Map<string, AccountEntitlement>();
  for (const [id, row] of [...exportRows].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const feed = feedRows.get(id);
    // Tier and renewal share one rule today; they carry separate sources in the model.
    const tierSource = feed === undefined ? EXPORT : preferred;
    const renewalSource = tierSource;

    if (feed !== undefined) {
      const disagree = (
        field: 'supportTier' | 'renewalDate',
        exportValue: string,
        feedValue: string,
      ): void => {
        if (exportValue === feedValue) return;
        events.push({
          kind: 'source_disagreement',
          accountId: id,
          ...idEvent(row.sourceId, id),
          field,
          exportValue,
          feedValue,
          served: preferred,
        });
      };
      disagree('supportTier', row.supportTier, feed.supportTier);
      disagree('renewalDate', row.contractEnd, feed.renewal);
    }

    accounts.set(id, {
      id,
      name: row.name,
      supportTier: feed !== undefined && feedIsNewer ? feed.supportTier : row.supportTier,
      renewalDate: feed !== undefined && feedIsNewer ? feed.renewal : row.contractEnd,
      arr: { amount: row.arr.amount, currency: row.arr.currency },
      tierSource,
      renewalSource,
      inFeed: feed !== undefined,
    });
  }

  const xmlOnlyIds = [...feedRows.keys()].filter((id) => !exportRows.has(id)).sort();
  for (const id of xmlOnlyIds) {
    events.push({
      kind: 'xml_only_account',
      source: FEED,
      accountId: id,
      reason: 'in the feed but not in the export; left out of the snapshot (no name or ARR)',
    });
  }
  return { accounts, xmlOnlyIds, events };
}
