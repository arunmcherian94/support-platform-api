import { describe, expect, it } from 'vitest';
import { toAppError, UpstreamError, type FailureKind } from '../../src/adapters/errors.js';

describe('upstream failure → problem mapping (S3-8)', () => {
  it.each<[FailureKind, string, number]>([
    ['circuit_open', 'upstream-unavailable', 503],
    ['unavailable', 'upstream-unavailable', 503],
    ['throttled', 'upstream-unavailable', 503],
    ['timeout', 'upstream-timeout', 504],
    ['budget_exhausted', 'upstream-timeout', 504],
    ['server_error', 'upstream-error', 502],
    ['client_error', 'upstream-error', 502],
    ['bad_response', 'upstream-error', 502],
  ])('%s → %s', (kind, problem, status) => {
    const error = toAppError(new UpstreamError('case_system', kind));
    expect(error.problem).toBe(problem);
    expect(error.status).toBe(status);
  });

  it('passes Retry-After on 503s, defaulting when there is no hint', () => {
    const throttled = toAppError(
      new UpstreamError('case_system', 'throttled', { retryAfterSec: 30 }),
    );
    expect(throttled.options.headers).toEqual({ 'Retry-After': '30' });
    const down = toAppError(new UpstreamError('case_system', 'unavailable'));
    expect(down.options.headers?.['Retry-After']).toBe('5');
    expect(toAppError(new UpstreamError('case_system', 'timeout')).options.headers).toBeUndefined();
  });

  it('names the upstream, never the upstream body', () => {
    const error = toAppError(
      new UpstreamError('case_system', 'server_error', { status: 500, cause: new Error('secret') }),
    );
    expect(error.detail).toBe('The case system returned an error.');
  });
});
