import { AppError } from '../http/problems.js';

export type Upstream = 'case_system' | 'entitlement' | 'usage_warehouse';

/**
 * Failure classes for upstream calls (S3 §2.3). Adapters and the resilient
 * client speak only these; the HTTP layer maps them to problem types.
 */
export type FailureKind =
  /** Per-attempt timeout, after retries. */
  | 'timeout'
  /** The request budget ran out before an attempt could finish or start. */
  | 'budget_exhausted'
  /** Connection refused, reset or DNS failure, after retries. */
  | 'unavailable'
  /** The circuit breaker is open; the call was not attempted. */
  | 'circuit_open'
  /** 429 whose Retry-After doesn't fit the remaining budget, or retries exhausted. */
  | 'throttled'
  /** 5xx after retries. */
  | 'server_error'
  /** The upstream says the resource doesn't exist. An answer, not an outage. */
  | 'not_found'
  /** Any other 4xx: our request was wrong. Never retried, never counted. */
  | 'client_error'
  /** A 2xx we couldn't parse or that broke the expected shape. */
  | 'bad_response';

const NAMES: Record<Upstream, string> = {
  case_system: 'The case system',
  entitlement: 'The entitlement system',
  usage_warehouse: 'The usage warehouse',
};

export class UpstreamError extends Error {
  constructor(
    readonly upstream: Upstream,
    readonly kind: FailureKind,
    readonly info: {
      /** Upstream HTTP status, when there was one. */
      status?: number;
      /** Seconds the caller should wait (429 Retry-After, or time until half-open). */
      retryAfterSec?: number;
      /** Upstream error code (never the upstream body). */
      code?: string;
      cause?: unknown;
    } = {},
  ) {
    super(`${upstream} ${kind}${info.status === undefined ? '' : ` (${String(info.status)})`}`, {
      cause: info.cause,
    });
    this.name = 'UpstreamError';
  }
}

/** Seconds a client should wait when an upstream is unavailable and no better hint exists. */
export const DEFAULT_RETRY_AFTER_SEC = 5;

/**
 * Maps a failure of a **required** upstream to its problem (S3 §2.3). Optional
 * upstreams don't come here: their failure degrades the response instead.
 * `not_found` is the caller's to interpret (usually 404) and is not mapped.
 */
export function toAppError(error: UpstreamError): AppError {
  const name = NAMES[error.upstream];
  const retryAfter = String(error.info.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC);
  switch (error.kind) {
    case 'circuit_open':
    case 'unavailable':
    case 'throttled':
      return new AppError('upstream-unavailable', `${name} is unavailable.`, {
        headers: { 'Retry-After': retryAfter },
      });
    case 'timeout':
    case 'budget_exhausted':
      return new AppError('upstream-timeout', `${name} did not respond in time.`);
    case 'server_error':
    case 'client_error':
    case 'bad_response':
    case 'not_found':
      return new AppError('upstream-error', `${name} returned an error.`);
  }
}
