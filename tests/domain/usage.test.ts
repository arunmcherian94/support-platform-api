import { describe, expect, it } from 'vitest';
import { monthClosedAt, roundPct, summariseUsage } from '../../src/domain/usage.js';
import type { UsageMonth } from '../../src/ports/usage.js';

// ACC-007 in the warehouse fixture, newest first.
const october: UsageMonth = {
  month: '2026-10',
  protectedTb: 426,
  apiCalls: 1251900,
  activeUsers: 89,
};
const september: UsageMonth = {
  month: '2026-09',
  protectedTb: 412.5,
  apiCalls: 1203331,
  activeUsers: 87,
};

describe('usage summary', () => {
  it('reports the latest month and the change from the previous one (ACC-007)', () => {
    // (426 - 412.5) / 412.5 = 3.27%; 48569 / 1203331 = 4.04%; 2 / 87 = 2.30%.
    expect(summariseUsage([october, september])).toEqual({
      latestMonth: '2026-10',
      protectedTb: 426,
      apiCalls: 1251900,
      activeUsers: 89,
      changeFromPreviousMonthPct: { protectedTb: 3.3, apiCalls: 4.0, activeUsers: 2.3 },
    });
  });

  it('reports negative changes', () => {
    const summary = summariseUsage([september, october]);
    // (412.5 - 426) / 426 = -3.17%; -48569 / 1251900 = -3.88%; -2 / 89 = -2.25%.
    expect(summary?.changeFromPreviousMonthPct).toEqual({
      protectedTb: -3.2,
      apiCalls: -3.9,
      activeUsers: -2.2,
    });
  });

  it('has no change with only one month', () => {
    expect(summariseUsage([october])?.changeFromPreviousMonthPct).toBeNull();
  });

  it.each(['protectedTb', 'apiCalls', 'activeUsers'] as const)(
    'has no change when the previous %s is 0',
    (field) => {
      const summary = summariseUsage([october, { ...september, [field]: 0 }]);
      expect(summary?.latestMonth).toBe('2026-10');
      expect(summary?.changeFromPreviousMonthPct).toBeNull();
    },
  );

  it('is null with no months at all', () => {
    expect(summariseUsage([])).toBeNull();
  });

  it('reports 0, not -0, when nothing changed', () => {
    const change = summariseUsage([october, october])?.changeFromPreviousMonthPct;
    expect(Object.is(change?.protectedTb, 0)).toBe(true);
  });
});

describe('percentage rounding', () => {
  it('rounds half away from zero at one decimal', () => {
    expect(roundPct(0.25)).toBe(0.3);
    expect(roundPct(-0.25)).toBe(-0.3);
    expect(roundPct(0.24)).toBe(0.2);
    expect(roundPct(-0.24)).toBe(-0.2);
  });

  it('is not pushed off a boundary by floating-point noise', () => {
    // 1.005 * 10 is 10.049999999999999; Math.round(x * 10) / 10 alone would give 10.
    expect(roundPct(1.005 * 10)).toBe(10.1);
    // 8.02 - 8 is 0.0199999…, so the naive percentage is 0.24999…; the true value is 0.25.
    const summary = summariseUsage([
      { month: '2026-10', protectedTb: 8.02, apiCalls: 400, activeUsers: 1000 },
      { month: '2026-09', protectedTb: 8, apiCalls: 400, activeUsers: 1000 },
    ]);
    expect(summary?.changeFromPreviousMonthPct?.protectedTb).toBe(0.3);
  });
});

describe('usage asOf', () => {
  it('is the first instant of the month after the latest month', () => {
    expect(monthClosedAt('2026-10')).toBe('2026-11-01T00:00:00Z');
    expect(monthClosedAt('2026-09')).toBe('2026-10-01T00:00:00Z');
  });

  it('rolls December into January of the next year', () => {
    expect(monthClosedAt('2026-12')).toBe('2027-01-01T00:00:00Z');
  });

  it('rejects a value that is not YYYY-MM', () => {
    expect(() => monthClosedAt('2026-13')).toThrow();
  });
});
