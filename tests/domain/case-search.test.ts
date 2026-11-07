/**
 * Entitlement filters resolved to an account list (S3 §2.5 step 1, S3-10).
 * Accounts carry the effective tier and renewal from the S1 §4 ground truth.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  MAX_RESOLVED_ACCOUNTS,
  resolveAccounts,
  utcDate,
} from '../../src/domain/case-search.js';
import type { AccountEntitlement, SupportTier } from '../../src/ports/entitlement.js';

function account(id: string, supportTier: SupportTier, renewalDate: string): AccountEntitlement {
  return {
    id,
    name: id,
    supportTier,
    renewalDate,
    arr: { amount: '1.00', currency: 'USD' },
    tierSource: 'entitlement_export',
    renewalSource: 'entitlement_export',
    inFeed: false,
  };
}

const GROUND_TRUTH = new Map(
  [
    account('ACC-007', 'platinum', '2027-01-15'),
    account('ACC-012', 'platinum', '2027-02-03'),
    account('ACC-015', 'platinum', '2027-02-05'),
    account('ACC-021', 'gold', '2026-12-20'),
    account('ACC-030', 'platinum', '2027-01-31'),
    account('ACC-042', 'platinum', '2027-01-10'),
  ].map((a) => [a.id, a]),
);
const TODAY = '2026-11-06';

const ids = (result: ReturnType<typeof resolveAccounts>): string[] => {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  return result.accountIds;
};

describe('UTC date helpers', () => {
  it('takes the UTC date of an instant, whatever the offset', () => {
    expect(utcDate(new Date('2026-11-06T23:59:59Z'))).toBe('2026-11-06');
    expect(utcDate(new Date('2026-11-07T00:30:00+01:00'))).toBe('2026-11-06');
  });

  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays(TODAY, 90)).toBe('2027-02-04');
    expect(addDays(TODAY, 0)).toBe(TODAY);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(() => addDays('06/11/2026', 1)).toThrow();
  });
});

describe('resolveAccounts', () => {
  it('Platinum with a renewal in 90 days is the ground-truth account set', () => {
    const result = resolveAccounts({
      accounts: GROUND_TRUTH,
      accountTier: ['platinum'],
      renewalWithinDays: 90,
      today: TODAY,
    });
    expect(ids(result)).toEqual(['ACC-007', 'ACC-012', 'ACC-030', 'ACC-042']);
  });

  it('includes both ends of the window: 89 days keeps ACC-012 (89) and drops ACC-015 (91)', () => {
    const within = (days: number, today = TODAY): string[] =>
      ids(resolveAccounts({ accounts: GROUND_TRUTH, renewalWithinDays: days, today }));
    expect(within(89)).toContain('ACC-012');
    expect(within(89)).not.toContain('ACC-015');
    // ACC-012 renews on the last day of an 89-day window; 88 drops it.
    expect(within(88)).not.toContain('ACC-012');
    // A renewal today matches with N = 0.
    expect(within(0, '2027-01-15')).toEqual(['ACC-007']);
  });

  it('never matches a renewal already in the past', () => {
    // Today moved past ACC-021, ACC-042 (2027-01-10) and ACC-007 (2027-01-15).
    const result = resolveAccounts({
      accounts: GROUND_TRUTH,
      renewalWithinDays: 365,
      today: '2027-01-16',
    });
    expect(ids(result)).toEqual(['ACC-012', 'ACC-015', 'ACC-030']);
  });

  it('filters on tier alone, or any of several tiers', () => {
    expect(
      ids(resolveAccounts({ accounts: GROUND_TRUTH, accountTier: ['gold'], today: TODAY })),
    ).toEqual(['ACC-021']);
    const goldOrSilverSoon = resolveAccounts({
      accounts: GROUND_TRUTH,
      accountTier: ['gold', 'silver'],
      renewalWithinDays: 30,
      today: TODAY,
    });
    expect(ids(goldOrSilverSoon)).toEqual([]);
  });

  it('intersects with accountId', () => {
    const platinum = (accountId: string): string[] =>
      ids(
        resolveAccounts({
          accounts: GROUND_TRUTH,
          accountTier: ['platinum'],
          accountId,
          today: TODAY,
        }),
      );
    expect(platinum('ACC-030')).toEqual(['ACC-030']);
    expect(platinum('ACC-021')).toEqual([]);
    expect(platinum('ACC-999')).toEqual([]);
  });

  it('signals too many accounts above the limit, and allows exactly the limit', () => {
    const many = (n: number): Map<string, AccountEntitlement> =>
      new Map(
        Array.from({ length: n }, (_, i) => {
          const a = account(`ACC-${String(1000 + i)}`, 'gold', '2027-01-01');
          return [a.id, a] as const;
        }),
      );
    const over = resolveAccounts({
      accounts: many(MAX_RESOLVED_ACCOUNTS + 1),
      accountTier: ['gold'],
      today: TODAY,
    });
    expect(over).toEqual({ kind: 'too_many' });
    const atLimit = resolveAccounts({
      accounts: many(MAX_RESOLVED_ACCOUNTS),
      accountTier: ['gold'],
      today: TODAY,
    });
    expect(ids(atLimit)).toHaveLength(MAX_RESOLVED_ACCOUNTS);
  });
});
