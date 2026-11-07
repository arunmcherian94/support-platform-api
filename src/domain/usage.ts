/**
 * The customer summary's usage block (S3 §2.4). Pure: turns warehouse months
 * into the contract's `UsageSummary`, with no I/O and no clock.
 */
import type { UsageMonth } from '../ports/usage.js';

export interface UsageChange {
  protectedTb: number;
  apiCalls: number;
  activeUsers: number;
}

/** The contract's `UsageSummary`. */
export interface UsageSummary {
  latestMonth: string;
  protectedTb: number;
  apiCalls: number;
  activeUsers: number;
  changeFromPreviousMonthPct: UsageChange | null;
}

/**
 * Rounds a percentage to one decimal, half away from zero. The value is first
 * cut to 12 significant digits so subtraction noise (8.02 - 8 is
 * 0.0199999…) can't push a true .x5 below the rounding boundary.
 */
export function roundPct(value: number): number {
  const cleaned = Number(value.toPrecision(12));
  const rounded = (Math.sign(cleaned) * Math.round(Math.abs(cleaned) * 10)) / 10;
  return rounded === 0 ? 0 : rounded; // no -0
}

function pctChange(current: number, previous: number): number {
  return roundPct(((current - previous) / previous) * 100);
}

/**
 * Latest month plus the change from the month before. `months` is newest
 * first. Null when there are no months; the change is null with no previous
 * month or when any previous value is 0 (a percentage of zero is undefined).
 */
export function summariseUsage(months: readonly UsageMonth[]): UsageSummary | null {
  const [latest, previous] = months;
  if (latest === undefined) return null;
  const comparable =
    previous !== undefined &&
    previous.protectedTb !== 0 &&
    previous.apiCalls !== 0 &&
    previous.activeUsers !== 0;
  return {
    latestMonth: latest.month,
    protectedTb: latest.protectedTb,
    apiCalls: latest.apiCalls,
    activeUsers: latest.activeUsers,
    changeFromPreviousMonthPct: comparable
      ? {
          protectedTb: pctChange(latest.protectedTb, previous.protectedTb),
          apiCalls: pctChange(latest.apiCalls, previous.apiCalls),
          activeUsers: pctChange(latest.activeUsers, previous.activeUsers),
        }
      : null,
  };
}

/**
 * When a `YYYY-MM` month closed: the first instant of the next month, UTC.
 * That is the usage source's `asOf`.
 */
export function monthClosedAt(month: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) throw new Error(`not a YYYY-MM month: ${month}`);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01T00:00:00Z`;
}
