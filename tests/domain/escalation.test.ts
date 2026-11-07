/** The eligibility matrix on `escalateCase` (S5 §2.1), every cell. */
import { describe, expect, it } from 'vitest';
import { escalationVerdict, type TierLookup } from '../../src/domain/escalation.js';
import type { CaseRecord } from '../../src/ports/cases.js';

const base: Pick<CaseRecord, 'id' | 'accountId' | 'status' | 'priority' | 'escalation'> = {
  id: 'CS-1',
  accountId: 'ACC-1',
  status: 'open',
  priority: 'P1',
  escalation: null,
};

const problemOf = (priority: CaseRecord['priority'], tier: TierLookup): string =>
  ((v) => (v.allowed ? 'allowed' : v.problem))(
    escalationVerdict({ ...base, priority }, () => tier),
  );

describe('escalation matrix', () => {
  it.each([
    ['P1', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed'],
    ['P2', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed'],
    [
      'P3',
      'allowed',
      'escalation-not-allowed',
      'escalation-not-allowed',
      'escalation-not-allowed',
      'entitlement-stale',
    ],
    [
      'P4',
      'allowed',
      'escalation-not-allowed',
      'escalation-not-allowed',
      'escalation-not-allowed',
      'entitlement-stale',
    ],
  ] as const)('%s: platinum, gold, silver, no record, stale', (priority, ...expected) => {
    const tiers: TierLookup[] = ['platinum', 'gold', 'silver', null, 'stale'];
    expect(tiers.map((t) => problemOf(priority, t))).toEqual(expected);
  });

  it.each(['P1', 'P2'] as const)('%s never looks up the tier', (priority) => {
    let looked = false;
    escalationVerdict({ ...base, priority }, () => {
      looked = true;
      return 'stale';
    });
    expect(looked).toBe(false);
  });

  it('state is checked before priority: closed or already escalated is invalid-state', () => {
    const closed = escalationVerdict({ ...base, status: 'closed', priority: 'P3' }, () => 'gold');
    expect(closed).toMatchObject({ allowed: false, problem: 'invalid-state' });
    const escalated = escalationVerdict(
      {
        ...base,
        escalation: {
          reason: 'sla_risk',
          escalatedAt: '2026-11-06T12:00:00Z',
          escalatedBy: { user: 'u' },
        },
      },
      () => 'platinum',
    );
    expect(escalated).toMatchObject({ allowed: false, problem: 'invalid-state' });
  });

  it('in_progress cases can be escalated', () => {
    expect(escalationVerdict({ ...base, status: 'in_progress' }, () => null).allowed).toBe(true);
  });
});
