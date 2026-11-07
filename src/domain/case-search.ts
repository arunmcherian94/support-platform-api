/**
 * Turning the cross-system filters on `GET /v1/cases` into an account list
 * the case system can filter on (S3 §2.5 step 1). Pure: the snapshot's
 * accounts and "today" are passed in; nothing here reads the clock.
 */
import type { AccountEntitlement, SupportTier } from '../ports/entitlement.js';

/** Above this, the upstream `IN` list gets too long; a joined read model is the fix (ADR-0002). */
export const MAX_RESOLVED_ACCOUNTS = 500;

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar date of an instant, `YYYY-MM-DD`. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * `date` plus `days`, as a UTC calendar date. Works on UTC midnight
 * milliseconds, so daylight-saving changes in the host's zone can't shift it.
 */
export function addDays(date: string, days: number): string {
  if (!DATE.test(date)) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(midnight)) throw new Error(`not a valid date: ${date}`);
  return utcDate(new Date(midnight + days * DAY_MS));
}

export interface AccountFilters {
  accounts: ReadonlyMap<string, AccountEntitlement>;
  accountTier?: SupportTier[];
  renewalWithinDays?: number;
  accountId?: string;
  /** The injected clock's UTC date, `YYYY-MM-DD`. */
  today: string;
}

export type ResolvedAccounts = { kind: 'ok'; accountIds: string[] } | { kind: 'too_many' };

/**
 * Canonical IDs of the accounts matching the entitlement filters, sorted,
 * intersected with `accountId` when given. The renewal window is
 * `today <= renewalDate <= today + N`, inclusive on both ends, so a renewal
 * already in the past never matches. `YYYY-MM-DD` strings compare correctly
 * as text.
 */
export function resolveAccounts(filters: AccountFilters): ResolvedAccounts {
  const { accountTier, renewalWithinDays, accountId, today } = filters;
  const windowEnd = renewalWithinDays === undefined ? undefined : addDays(today, renewalWithinDays);
  const ids: string[] = [];
  for (const account of filters.accounts.values()) {
    if (accountId !== undefined && account.id !== accountId) continue;
    if (accountTier !== undefined && !accountTier.includes(account.supportTier)) continue;
    if (windowEnd !== undefined) {
      if (account.renewalDate < today || account.renewalDate > windowEnd) continue;
    }
    ids.push(account.id);
  }
  if (ids.length > MAX_RESOLVED_ACCOUNTS) return { kind: 'too_many' };
  ids.sort();
  return { kind: 'ok', accountIds: ids };
}
