/**
 * Escalation eligibility (S5 §2.1, the matrix on `escalateCase`). Pure: the
 * handler looks up the tier and passes it in; this decides.
 */
import type { CaseRecord } from '../ports/cases.js';
import type { SupportTier } from '../ports/entitlement.js';

/** The account's tier, `null` when it has no entitlement record, or `stale` when unknown. */
export type TierLookup = SupportTier | null | 'stale';

export type EscalationVerdict =
  | { allowed: true }
  | {
      allowed: false;
      problem: 'invalid-state' | 'escalation-not-allowed' | 'entitlement-stale';
      detail: string;
    };

type Candidate = Pick<CaseRecord, 'id' | 'accountId' | 'status' | 'priority' | 'escalation'>;

/**
 * State first (409), then priority and tier. P1 and P2 never need the tier, so
 * stale entitlement data blocks only P3 and P4.
 */
export function escalationVerdict(record: Candidate, tier: () => TierLookup): EscalationVerdict {
  if (record.escalation !== null) {
    return {
      allowed: false,
      problem: 'invalid-state',
      detail: `${record.id} is already escalated.`,
    };
  }
  if (record.status !== 'open' && record.status !== 'in_progress') {
    return {
      allowed: false,
      problem: 'invalid-state',
      detail: `${record.id} is ${record.status}; only open or in-progress cases can be escalated.`,
    };
  }
  if (record.priority === 'P1' || record.priority === 'P2') return { allowed: true };
  const found = tier();
  if (found === 'stale') {
    return {
      allowed: false,
      problem: 'entitlement-stale',
      detail: `Escalating a ${record.priority} case needs the account's tier, and entitlement data is unavailable.`,
    };
  }
  if (found !== 'platinum') {
    return {
      allowed: false,
      problem: 'escalation-not-allowed',
      detail: `P3 and P4 cases can be escalated only for platinum accounts; ${record.accountId} is ${found ?? 'without an entitlement record'}.`,
    };
  }
  return { allowed: true };
}
