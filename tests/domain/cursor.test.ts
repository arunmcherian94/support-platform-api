/** Keyset cursors bound to the search that issued them (S3 §2.5, S3-9). */
import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  fingerprint,
  InvalidCursorError,
  type CursorFilters,
} from '../../src/domain/cursor.js';

const BASE: CursorFilters = {
  status: ['open', 'in_progress'],
  priority: ['P1'],
  accountTier: ['platinum'],
  renewalWithinDays: 90,
  renewalResolvedOn: '2026-11-06',
  openedBefore: '2026-11-04T12:00:00Z',
  sort: { field: 'openedAt', descending: false },
};
const FP = fingerprint(BASE);
const POSITION = { value: '2026-11-01T09:00:00Z', id: 'CS-10236' };

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** The rejection reason, or `accepted`. */
function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidCursorError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('cursor encoding', () => {
  it('round-trips a position', () => {
    const text = encodeCursor(POSITION, FP);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      k: ['2026-11-01T09:00:00Z', 'CS-10236'],
      f: FP,
    });
    expect(decodeCursor(text, FP, 'openedAt')).toEqual(POSITION);
    const byPriority = encodeCursor({ value: 'P2', id: 'CS-1' }, FP);
    expect(decodeCursor(byPriority, FP, 'priority')).toEqual({ value: 'P2', id: 'CS-1' });
  });

  it('rejects garbage and the wrong shape as malformed', () => {
    expect(reason(() => decodeCursor('not a cursor!', FP, 'openedAt'))).toBe('malformed');
    expect(reason(() => decodeCursor(b64('text'), FP, 'openedAt'))).toBe('malformed');
    const brokenJson = Buffer.from('{').toString('base64url');
    expect(reason(() => decodeCursor(brokenJson, FP, 'openedAt'))).toBe('malformed');
    const oneKey = b64({ v: 1, k: ['2026-11-01T09:00:00Z'], f: FP });
    expect(reason(() => decodeCursor(oneKey, FP, 'openedAt'))).toBe('malformed');
  });

  it('rejects a wrong version and a mismatched fingerprint', () => {
    const v2 = b64({ v: 2, k: [POSITION.value, POSITION.id], f: FP });
    expect(reason(() => decodeCursor(v2, FP, 'openedAt'))).toBe('version');
    const otherSearch = encodeCursor(POSITION, 'other');
    expect(reason(() => decodeCursor(otherSearch, FP, 'openedAt'))).toBe('fingerprint');
  });

  it('rejects edited positions that keep the fingerprint', () => {
    const edited = (value: string, id: string): string => encodeCursor({ value, id }, FP);
    expect(reason(() => decodeCursor(edited('yesterday', 'CS-1'), FP, 'openedAt'))).toBe(
      'malformed',
    );
    expect(reason(() => decodeCursor(edited('P9', 'CS-1'), FP, 'priority'))).toBe('malformed');
    expect(reason(() => decodeCursor(edited(POSITION.value, "x' OR 1=1"), FP, 'openedAt'))).toBe(
      'malformed',
    );
  });

  it('rejects a cursor with changed characters', () => {
    const text = encodeCursor(POSITION, FP);
    const tampered = `${text.slice(0, 10)}${text[10] === 'A' ? 'B' : 'A'}${text.slice(11)}`;
    expect(reason(() => decodeCursor(tampered, FP, 'openedAt'))).not.toBe('accepted');
  });
});

describe('fingerprint', () => {
  const changes: [string, Partial<CursorFilters>][] = [
    ['status', { status: ['open'] }],
    ['priority', { priority: ['P1', 'P2'] }],
    ['accountTier', { accountTier: ['gold'] }],
    ['accountId', { accountId: 'ACC-007' }],
    ['renewalWithinDays', { renewalWithinDays: 89 }],
    ['openedAfter', { openedAfter: '2026-10-01T00:00:00Z' }],
    ['openedBefore', { openedBefore: '2026-11-04T12:00:01Z' }],
    ['sort field', { sort: { field: 'priority', descending: false } }],
    ['sort direction', { sort: { field: 'openedAt', descending: true } }],
    ['resolved date', { renewalResolvedOn: '2026-11-07' }],
  ];
  it.each(changes)('changes with %s', (_name, change) => {
    expect(fingerprint({ ...BASE, ...change })).not.toBe(FP);
  });

  it('changes when a filter is removed', () => {
    const withoutStatus: CursorFilters = { ...BASE };
    delete withoutStatus.status;
    expect(fingerprint(withoutStatus)).not.toBe(FP);
  });

  it('ignores spelling: value order, duplicates and timestamp offset', () => {
    const respelled = fingerprint({
      ...BASE,
      status: ['in_progress', 'open', 'open'],
      openedBefore: '2026-11-04T14:00:00+02:00',
    });
    expect(respelled).toBe(FP);
  });

  it('binds the resolved date only when renewalWithinDays is present', () => {
    const noRenewal: CursorFilters = { ...BASE };
    delete noRenewal.renewalWithinDays;
    delete noRenewal.renewalResolvedOn;
    expect(fingerprint({ ...noRenewal, renewalResolvedOn: '2026-11-07' })).toBe(
      fingerprint(noRenewal),
    );
  });
});
