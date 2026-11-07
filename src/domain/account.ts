/**
 * Joining entitlement data onto cases, and reporting where it came from.
 * Pure: reads a snapshot state, does no I/O (S3 §2.5, §2.6).
 */
import type {
  EntitlementSystem,
  FeedState,
  SnapshotState,
  SupportTier,
} from '../ports/entitlement.js';

/** The account fields a case carries. Never ARR (contract `AccountSummary`). */
export interface AccountSummary {
  name: string;
  supportTier: SupportTier;
  renewalDate: string;
}

export interface SourceStatus {
  system: 'case_system' | EntitlementSystem | 'usage_warehouse';
  status: 'ok' | 'stale' | 'no_data' | 'unavailable';
  asOf: string | null;
  fields?: string[];
}

/** The account summary for a case, or null when the snapshot is unusable or has no record. */
export function accountSummary(state: SnapshotState, accountId: string): AccountSummary | null {
  if (!state.usable) return null;
  const account = state.snapshot.accounts.get(accountId);
  if (account === undefined) return null;
  return {
    name: account.name,
    supportTier: account.supportTier,
    renewalDate: account.renewalDate,
  };
}

function feedSource(
  system: EntitlementSystem,
  feed: FeedState | undefined,
  tooOld: boolean,
): SourceStatus {
  if (feed === undefined || feed.asOf === null)
    return { system, status: 'unavailable', asOf: null };
  // A snapshot past the 48-hour limit is reported stale, whatever its last refresh did.
  const status = tooOld && system === 'entitlement_export' ? 'stale' : feed.status;
  return { system, status, asOf: feed.asOf };
}

/** Provenance of the two entitlement feeds, for list and case responses (no `fields`). */
export function entitlementSources(state: SnapshotState): SourceStatus[] {
  const snapshot = state.snapshot;
  const tooOld = !state.usable && state.reason === 'too_old';
  return [
    feedSource('entitlement_export', snapshot?.export, tooOld),
    feedSource('entitlement_feed', snapshot?.feed, tooOld),
  ];
}
