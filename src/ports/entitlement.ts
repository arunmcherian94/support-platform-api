/**
 * Entitlement port (ADR-0003). Requests read an in-memory snapshot built from
 * the ERP's CSV export and XML feed; they never fetch the feeds themselves.
 */
export type SupportTier = 'platinum' | 'gold' | 'silver';
export type EntitlementSystem = 'entitlement_export' | 'entitlement_feed';

export interface AccountEntitlement {
  /** Canonical ID (`ACC-NNN`), after the crosswalk. */
  id: string;
  name: string;
  supportTier: SupportTier;
  /** `YYYY-MM-DD`. */
  renewalDate: string;
  /**
   * ARR from the CSV export, the system of record. Kept here and filtered at
   * the response boundary by `finance:read`; the snapshot never decides visibility.
   */
  arr: { amount: string; currency: string };
  tierSource: EntitlementSystem;
  renewalSource: EntitlementSystem;
  /** Whether the XML feed has a row for this account. */
  inFeed: boolean;
}

/** Health of one feed: `stale` means the last refresh failed and older data is in use. */
export interface FeedState {
  status: 'ok' | 'stale' | 'unavailable';
  /** When the source produced the data in use (export or feed time); null if never loaded. */
  asOf: string | null;
}

export interface EntitlementSnapshot {
  accounts: ReadonlyMap<string, AccountEntitlement>;
  export: FeedState;
  feed: FeedState;
}

/**
 * Usable: loaded, and the CSV export is at most 48 hours old.
 * Not usable: never loaded, or too old (S3 §2.2). The last snapshot, if any,
 * is still returned so responses can report its age.
 */
export type SnapshotState =
  | { usable: true; snapshot: EntitlementSnapshot }
  | { usable: false; reason: 'never_loaded' | 'too_old'; snapshot?: EntitlementSnapshot };

export interface EntitlementSource {
  /** The current snapshot and whether it may be used, judged at the injected clock's now. */
  current(): SnapshotState;
  /** Account IDs seen in one system that match nothing in the others, sorted. */
  unmatchedAccountIds(): string[];
  /** Records a case account ID with no entitlement record (seen during reads). */
  reportUnmatched(accountId: string): void;
  /**
   * Loads once and starts polling. Resolves after the first attempt, success or
   * not, and never rejects. The server doesn't await it (start-up doesn't block
   * on the ERP); tests may.
   */
  start(): Promise<void>;
  stop(): void;
}
