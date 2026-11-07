import { describe, expect, it } from 'vitest';
import { accountSummary, entitlementSources } from '../../src/domain/account.js';
import type { AccountEntitlement, EntitlementSnapshot } from '../../src/ports/entitlement.js';

const acme: AccountEntitlement = {
  id: 'ACC-007',
  name: 'Acme Corp',
  supportTier: 'platinum',
  renewalDate: '2027-01-15',
  arr: { amount: '480000.00', currency: 'USD' },
  tierSource: 'entitlement_feed',
  renewalSource: 'entitlement_feed',
  inFeed: true,
};
const snapshot: EntitlementSnapshot = {
  accounts: new Map([['ACC-007', acme]]),
  export: { status: 'ok', asOf: '2026-11-06T02:00:00Z' },
  feed: { status: 'stale', asOf: '2026-11-06T11:00:00Z' },
};

describe('account join', () => {
  it('returns name, tier and renewal, never ARR', () => {
    const summary = accountSummary({ usable: true, snapshot }, 'ACC-007');
    expect(summary).toEqual({
      name: 'Acme Corp',
      supportTier: 'platinum',
      renewalDate: '2027-01-15',
    });
    expect(JSON.stringify(summary)).not.toContain('480000');
  });

  it('is null for an unknown account or an unusable snapshot', () => {
    expect(accountSummary({ usable: true, snapshot }, 'ACC-099')).toBeNull();
    expect(accountSummary({ usable: false, reason: 'too_old', snapshot }, 'ACC-007')).toBeNull();
    expect(accountSummary({ usable: false, reason: 'never_loaded' }, 'ACC-007')).toBeNull();
  });
});

describe('entitlement sources', () => {
  it('reports each feed with its status and age', () => {
    expect(entitlementSources({ usable: true, snapshot })).toEqual([
      { system: 'entitlement_export', status: 'ok', asOf: '2026-11-06T02:00:00Z' },
      { system: 'entitlement_feed', status: 'stale', asOf: '2026-11-06T11:00:00Z' },
    ]);
  });

  it('marks both feeds stale when the export is too old, and a never-loaded snapshot unavailable', () => {
    expect(
      entitlementSources({ usable: false, reason: 'too_old', snapshot }).map((x) => x.status),
    ).toEqual(['stale', 'stale']);
    expect(entitlementSources({ usable: false, reason: 'never_loaded' })).toEqual([
      { system: 'entitlement_export', status: 'unavailable', asOf: null },
      { system: 'entitlement_feed', status: 'unavailable', asOf: null },
    ]);
  });
});
