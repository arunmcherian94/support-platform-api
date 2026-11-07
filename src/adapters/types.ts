import type { Upstream } from './errors.js';

/** A request to one upstream, relative to its base URL. */
export interface UpstreamRequest {
  method?: 'GET' | 'POST' | 'PATCH';
  /** Path plus optional query string, e.g. `/cases?status=open`. */
  path: string;
  headers?: Record<string, string>;
  /** JSON-serialisable body. */
  body?: unknown;
  /**
   * Whether the call may be retried. Reads and idempotent writes only
   * (decision 24). Defaults to true for GET, false otherwise.
   */
  retryable?: boolean;
}

export interface UpstreamResponse {
  /** 2xx or 304. Every other status becomes an UpstreamError. */
  status: number;
  headers: Headers;
  text: string;
}

/**
 * HTTP to one upstream behind its resilience policy (timeout, retry, breaker).
 * Throws UpstreamError for anything other than 2xx/304; propagates
 * X-Request-Id and traceparent from the request context.
 */
export interface UpstreamClient {
  readonly upstream: Upstream;
  request(request: UpstreamRequest): Promise<UpstreamResponse>;
  /** Breaker state for readiness: closed = ok, half-open = degraded, open = unavailable. */
  health(): 'ok' | 'degraded' | 'unavailable';
}
