import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { UpstreamError } from '../../src/adapters/errors.js';
import {
  backoffDelayMs,
  countsTowardBreaker,
  parseRetryAfterSec,
  POLICIES,
} from '../../src/adapters/resilience.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('policy constants (S3 §2.3)', () => {
  it('match the spec table', () => {
    expect(POLICIES).toEqual({
      case_system: { attemptTimeoutMs: 3000, maxRetries: 2, breaker: true },
      usage_warehouse: { attemptTimeoutMs: 1500, maxRetries: 1, breaker: true },
      entitlement: { attemptTimeoutMs: 5000, maxRetries: 2, breaker: false },
    });
  });
});

describe('breaker classification (S3-7)', () => {
  it.each([
    ['timeout', true],
    ['unavailable', true],
    ['server_error', true],
    ['throttled', true],
    ['not_found', false],
    ['client_error', false],
    ['budget_exhausted', false],
    ['circuit_open', false],
    ['bad_response', false],
  ] as const)('%s counts: %s', (kind, counts) => {
    expect(countsTowardBreaker(new UpstreamError('case_system', kind))).toBe(counts);
  });

  it('does not count errors that are not UpstreamErrors', () => {
    expect(countsTowardBreaker(new Error('boom'))).toBe(false);
  });
});

describe('backoff: exponential from 100 ms, full jitter, capped at 1 s (S3-6)', () => {
  it('stays below the exponential ceiling for each retry', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(backoffDelayMs(0)).toBe(99);
    expect(backoffDelayMs(1)).toBe(199);
    expect(backoffDelayMs(3)).toBe(799);
    expect(backoffDelayMs(4)).toBe(999);
    expect(backoffDelayMs(10)).toBe(999);
  });

  it('is jittered down to zero', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelayMs(3)).toBe(0);
  });
});

describe('Retry-After parsing', () => {
  const clock = fixedClock('2026-11-06T12:00:00Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfterSec('7', clock)).toBe(7);
    expect(parseRetryAfterSec(' 0 ', clock)).toBe(0);
  });

  it('reads an HTTP-date against the injected clock', () => {
    expect(parseRetryAfterSec('Fri, 06 Nov 2026 12:00:03 GMT', clock)).toBe(3);
    expect(parseRetryAfterSec('Fri, 06 Nov 2026 11:59:00 GMT', clock)).toBe(0);
  });

  it('gives undefined when absent or unparseable', () => {
    expect(parseRetryAfterSec(null, clock)).toBeUndefined();
    expect(parseRetryAfterSec('soon', clock)).toBeUndefined();
    expect(parseRetryAfterSec('-5', clock)).toBeUndefined();
    expect(parseRetryAfterSec('2026-11-06T12:00:03Z', clock)).toBeUndefined();
  });
});
