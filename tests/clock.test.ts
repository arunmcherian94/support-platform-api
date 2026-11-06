import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock } from '../src/clock.js';

describe('clock', () => {
  it('fixedClock returns the set instant and moves only when told', () => {
    const clock = fixedClock('2026-11-06T12:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-11-06T12:00:00.000Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-11-06T12:01:00.000Z');
    clock.set('2027-01-01T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('systemClock with NOW starts at the anchor', () => {
    const now = systemClock({ NOW: '2026-11-06T12:00:00Z' }).now().getTime();
    const anchor = Date.parse('2026-11-06T12:00:00Z');
    expect(now - anchor).toBeGreaterThanOrEqual(0);
    expect(now - anchor).toBeLessThan(1_000);
  });

  it('systemClock rejects an invalid NOW', () => {
    expect(() => systemClock({ NOW: 'yesterday' })).toThrow(/NOW/);
  });
});
