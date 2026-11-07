/**
 * Case system port (ADR-0002). Canonical shapes only: the adapter translates
 * the upstream's mixed casing at the boundary, so nothing here knows `Status`.
 */
export type CaseStatus = 'open' | 'in_progress' | 'closed';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type EscalationReason =
  'sla_risk' | 'customer_impact' | 'renewal_risk' | 'security' | 'other';

export interface CaseComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface CaseEscalation {
  reason: EscalationReason;
  note?: string;
  escalatedAt: string;
  escalatedBy: { user: string; agent?: string; approvedBy?: string };
}

export interface CaseRecord {
  id: string;
  accountId: string;
  subject: string;
  status: CaseStatus;
  priority: Priority;
  openedAt: string;
  escalation: CaseEscalation | null;
  /** Upstream concurrency token; the ETag is derived from it. */
  version: number;
  /** Strong entity tag: `"` + base64url(`caseId:version`) + `"`. */
  etag: string;
}

export interface CaseDetailRecord extends CaseRecord {
  /** Every comment, oldest first. Handlers choose how many to return. */
  comments: CaseComment[];
}

export type CaseSortField = 'openedAt' | 'priority';

/** One page request. Every filter runs in the case system (S3 §2.5). */
export interface CaseQuery {
  status?: CaseStatus[];
  priority?: Priority[];
  /** Canonical account IDs; absent means any account. Never empty (callers short-circuit). */
  accountIds?: string[];
  /** Inclusive lower bound, RFC 3339. */
  openedAfter?: string;
  /** Exclusive upper bound, RFC 3339. */
  openedBefore?: string;
  sort: { field: CaseSortField; descending: boolean };
  /** Keyset position: return records strictly after this (sort value, case ID). */
  after?: { value: string; id: string };
  limit: number;
}

export interface CasePage {
  records: CaseRecord[];
  /** True when at least one more record follows the page. */
  hasMore: boolean;
}

export interface CaseSystem {
  search(query: CaseQuery): Promise<CasePage>;
  /** Throws UpstreamError with kind `not_found` for an unknown case. */
  get(caseId: string): Promise<CaseDetailRecord>;
  /**
   * Adds a comment, written through to the case system. A single attempt,
   * never retried: the upstream create isn't idempotent (S4 §2.1).
   * Throws `not_found` for an unknown case.
   */
  addComment(caseId: string, comment: { author: string; body: string }): Promise<CaseComment>;
  /**
   * Sets the escalation if the case is still at `expectedVersion`. A single
   * attempt, never retried. Throws `client_error` with status 412 when the
   * case changed, `not_found` for an unknown case. Returns the new ETag.
   */
  escalate(
    caseId: string,
    escalation: CaseEscalation,
    expectedVersion: number,
  ): Promise<{ version: number; etag: string }>;
}
