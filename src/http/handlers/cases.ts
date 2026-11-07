/**
 * `GET /v1/cases` (S3 §2.5). Entitlement filters become an account list,
 * every filter goes to the case system in one query, and the page that comes
 * back is joined with the entitlement snapshot. Nothing is scanned in memory.
 */
import type { Request, RequestHandler } from 'express';
import { accountSummary, entitlementSources, type AccountSummary } from '../../domain/account.js';
import { resolveAccounts, utcDate } from '../../domain/case-search.js';
import {
  decodeCursor,
  encodeCursor,
  fingerprint,
  InvalidCursorError,
  type CursorFilters,
  type CursorPosition,
} from '../../domain/cursor.js';
import type {
  CaseEscalation,
  CaseQuery,
  CaseRecord,
  CaseSortField,
  CaseStatus,
  Priority,
} from '../../ports/cases.js';
import type { SupportTier } from '../../ports/entitlement.js';
import { AppError } from '../problems.js';
import { entitlementStale, queryList, queryString, upstreamProblem } from './shared.js';
import type { ReadDeps } from './shared.js';

const DEFAULT_LIMIT = 25;

/** The contract's `Case`: no upstream version or ETag, nothing beyond `CaseFields`. */
interface CaseView {
  id: string;
  accountId: string;
  account: AccountSummary | null;
  subject: string;
  status: CaseStatus;
  priority: Priority;
  openedAt: string;
  escalation: CaseEscalation | null;
}

const rfc3339Seconds = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

function parseSort(raw: string | undefined): { field: CaseSortField; descending: boolean } {
  const value = raw ?? 'openedAt';
  const descending = value.startsWith('-');
  // The contract's enum already limited the value to these two fields.
  const field: CaseSortField = (descending ? value.slice(1) : value) as CaseSortField;
  return { field, descending };
}

/**
 * An integer query parameter. The validator coerces integer parameters to
 * numbers (and fills in defaults), so `req.query` holds a number here, not
 * the raw string `queryInt` expects; a filter read as absent would silently
 * widen the search. Accepts either form and fails loudly on anything else.
 */
function intParam(req: Request, name: string): number | undefined {
  const value: unknown = (req.query as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new Error(`query parameter ${name} is not an integer after validation`);
  }
  return parsed;
}

function sortValue(record: CaseRecord, field: CaseSortField): string {
  return field === 'priority' ? record.priority : record.openedAt;
}

export function listCasesHandler(deps: ReadDeps): RequestHandler {
  return async (req, res, next) => {
    // Query values already passed the contract's schema (enums, formats, ranges).
    const status = queryList(req, 'status') as CaseStatus[] | undefined;
    const priority = queryList(req, 'priority') as Priority[] | undefined;
    const accountTier = queryList(req, 'accountTier') as SupportTier[] | undefined;
    const accountId = queryString(req, 'accountId');
    const renewalWithinDays = intParam(req, 'renewalWithinDays');
    const openedAfter = queryString(req, 'openedAfter');
    const openedBefore = queryString(req, 'openedBefore');
    const sort = parseSort(queryString(req, 'sort'));
    const limit = intParam(req, 'limit') ?? DEFAULT_LIMIT;
    const cursorText = queryString(req, 'cursor');

    const now = deps.clock.now();
    const today = utcDate(now);
    const state = deps.upstreams.entitlement.current();

    const filters: CursorFilters = {
      ...(status === undefined ? {} : { status }),
      ...(priority === undefined ? {} : { priority }),
      ...(accountTier === undefined ? {} : { accountTier }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(renewalWithinDays === undefined ? {} : { renewalWithinDays, renewalResolvedOn: today }),
      ...(openedAfter === undefined ? {} : { openedAfter }),
      ...(openedBefore === undefined ? {} : { openedBefore }),
      sort,
    };
    const fp = fingerprint(filters);

    let after: CursorPosition | undefined;
    if (cursorText !== undefined) {
      try {
        after = decodeCursor(cursorText, fp, sort.field);
      } catch (error) {
        if (!(error instanceof InvalidCursorError)) throw error;
        next(
          new AppError(
            'invalid-cursor',
            'The cursor was issued for different filters or sort, or is not a valid cursor. Restart without a cursor.',
          ),
        );
        return;
      }
    }

    const sources = [
      { system: 'case_system' as const, status: 'ok' as const, asOf: rfc3339Seconds(now) },
      ...entitlementSources(state),
    ];

    let accountIds: string[] | undefined = accountId === undefined ? undefined : [accountId];
    if (accountTier !== undefined || renewalWithinDays !== undefined) {
      // Filtering without entitlement data would silently drop matches.
      if (!state.usable) {
        next(entitlementStale());
        return;
      }
      const resolved = resolveAccounts({
        accounts: state.snapshot.accounts,
        ...(accountTier === undefined ? {} : { accountTier }),
        ...(renewalWithinDays === undefined ? {} : { renewalWithinDays }),
        ...(accountId === undefined ? {} : { accountId }),
        today,
      });
      if (resolved.kind === 'too_many') {
        next(
          new AppError(
            'validation-failed',
            'The entitlement filters match more than 500 accounts. Narrow them with accountTier, renewalWithinDays or accountId.',
          ),
        );
        return;
      }
      if (resolved.accountIds.length === 0) {
        res.json({ data: [], nextCursor: null, degraded: false, sources });
        return;
      }
      accountIds = resolved.accountIds;
    }

    const query: CaseQuery = {
      ...(status === undefined ? {} : { status }),
      ...(priority === undefined ? {} : { priority }),
      ...(accountIds === undefined ? {} : { accountIds }),
      ...(openedAfter === undefined ? {} : { openedAfter }),
      ...(openedBefore === undefined ? {} : { openedBefore }),
      sort,
      ...(after === undefined ? {} : { after }),
      limit,
    };

    let page;
    try {
      page = await deps.upstreams.cases.search(query);
    } catch (error) {
      next(upstreamProblem(error));
      return;
    }

    const data: CaseView[] = page.records.map((record) => {
      const account = accountSummary(state, record.accountId);
      if (account === null && state.usable) {
        deps.upstreams.entitlement.reportUnmatched(record.accountId);
      }
      return {
        id: record.id,
        accountId: record.accountId,
        account,
        subject: record.subject,
        status: record.status,
        priority: record.priority,
        openedAt: record.openedAt,
        escalation: record.escalation,
      };
    });

    const last = page.records.at(-1);
    const nextCursor =
      page.hasMore && last !== undefined
        ? encodeCursor({ value: sortValue(last, sort.field), id: last.id }, fp)
        : null;

    res.json({ data, nextCursor, degraded: !state.usable, sources });
  };
}
