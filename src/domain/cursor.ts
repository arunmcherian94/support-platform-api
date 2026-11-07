/**
 * Keyset cursors for `GET /v1/cases` (S3 §2.5). A cursor is base64url JSON
 * `{ v: 1, k: [sortValue, caseId], f: fingerprint }`. It is unsigned on
 * purpose (decision 17): it carries a position, not authority. Binding it to
 * a fingerprint of the request's filters and sort stops a cursor from one
 * search being replayed against another, where its position means nothing.
 */
import { createHash } from 'node:crypto';
import type { CaseSortField, CaseStatus, Priority } from '../ports/cases.js';
import type { SupportTier } from '../ports/entitlement.js';

const VERSION = 1;
const PRIORITIES: readonly string[] = ['P1', 'P2', 'P3', 'P4'];
const CASE_ID = /^CS-[0-9]+$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The position of the last record on a page: its sort value and case ID. */
export interface CursorPosition {
  value: string;
  id: string;
}

/** Everything that decides which records a search returns, and in what order. Not `limit`. */
export interface CursorFilters {
  status?: CaseStatus[];
  priority?: Priority[];
  accountTier?: SupportTier[];
  accountId?: string;
  renewalWithinDays?: number;
  openedAfter?: string;
  openedBefore?: string;
  sort: { field: CaseSortField; descending: boolean };
  /** The UTC date `renewalWithinDays` was resolved against; only bound when that filter is present. */
  renewalResolvedOn?: string;
}

export class InvalidCursorError extends Error {
  constructor(readonly reason: 'malformed' | 'version' | 'fingerprint') {
    super(`invalid cursor: ${reason}`);
    this.name = 'InvalidCursorError';
  }
}

const sorted = <T extends string>(values: T[] | undefined): T[] | null =>
  values === undefined ? null : [...new Set(values)].sort();

const instant = (value: string | undefined): string | null =>
  value === undefined ? null : new Date(value).toISOString();

/**
 * SHA-256 over a canonical JSON of the normalised filters. Arrays are
 * de-duplicated and sorted and timestamps become ISO instants, so the same
 * search spelled differently (repeated values in another order, `+00:00`
 * instead of `Z`) keeps its cursor valid. Absent filters are `null`, never
 * dropped, so the key order and the set of keys are fixed.
 */
export function fingerprint(filters: CursorFilters): string {
  const canonical = [
    sorted(filters.status),
    sorted(filters.priority),
    sorted(filters.accountTier),
    filters.accountId ?? null,
    filters.renewalWithinDays ?? null,
    filters.renewalWithinDays === undefined ? null : (filters.renewalResolvedOn ?? null),
    instant(filters.openedAfter),
    instant(filters.openedBefore),
    filters.sort.field,
    filters.sort.descending,
  ];
  // 128 bits is plenty to tell searches apart, and keeps the cursor short.
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

export function encodeCursor(position: CursorPosition, fp: string): string {
  const body = { v: VERSION, k: [position.value, position.id], f: fp };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

function validValue(value: string, field: CaseSortField): boolean {
  if (field === 'priority') return PRIORITIES.includes(value);
  return RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The position in a cursor issued for the same filters and sort. Throws
 * `InvalidCursorError` for anything else: not base64url JSON, the wrong
 * shape or version, a different fingerprint, or a sort value that doesn't
 * fit the sort field (an edited cursor would otherwise reach the upstream).
 */
export function decodeCursor(
  text: string,
  expectedFingerprint: string,
  sortField: CaseSortField,
): CursorPosition {
  let parsed: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('not base64url');
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidCursorError('malformed');
  }
  const { v, k, f } = parsed as Record<string, unknown>;
  if (v !== VERSION) throw new InvalidCursorError('version');
  if (typeof f !== 'string') throw new InvalidCursorError('malformed');
  if (f !== expectedFingerprint) throw new InvalidCursorError('fingerprint');
  if (!Array.isArray(k) || k.length !== 2) throw new InvalidCursorError('malformed');
  const [value, id] = k as unknown[];
  if (typeof value !== 'string' || typeof id !== 'string') {
    throw new InvalidCursorError('malformed');
  }
  if (!CASE_ID.test(id) || !validValue(value, sortField)) {
    throw new InvalidCursorError('malformed');
  }
  return { value, id };
}
