import { randomBytes } from 'node:crypto';
import type { Clock } from '../clock.js';
import { currentContext } from '../observability/context.js';
import type { Logger } from '../observability/logger.js';
import { DEFAULT_RETRY_AFTER_SEC, UpstreamError, type Upstream } from './errors.js';
import {
  createResilience,
  parseRetryAfterSec,
  POLICIES,
  type AttemptContext,
  type UpstreamPolicy,
} from './resilience.js';
import type { UpstreamClient, UpstreamRequest, UpstreamResponse } from './types.js';

export interface UpstreamClientOptions {
  upstream: Upstream;
  baseUrl: string;
  logger: Logger;
  clock: Clock;
  /** Defaults to POLICIES[upstream]. */
  policy?: UpstreamPolicy;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

/** Upstream error codes we pass on to logs: short identifiers only, never free text. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A child span of the request's trace: same trace ID and flags, new span ID. */
function childTraceparent(traceparent: string): string | undefined {
  const [version, traceId, , flags] = traceparent.split('-');
  if (version === undefined || traceId === undefined || flags === undefined) return undefined;
  let spanId = randomBytes(8).toString('hex');
  // All-zero span IDs are invalid (W3C Trace Context).
  while (/^0+$/.test(spanId)) spanId = randomBytes(8).toString('hex');
  return `${version}-${traceId}-${spanId}-${flags}`;
}

/** The upstream's error code from a JSON error body, if it has a short one. Never the body. */
function errorCode(text: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    // Salesforce-style errors are an array: [{ errorCode, message }].
    const parsed: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const code = record.code ?? record.errorCode ?? record.error;
    return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HTTP client for one upstream behind its resilience policy (S3 §2.3). Every
 * status other than 2xx/304 becomes an UpstreamError of the right kind;
 * retries, the breaker and the request budget are applied in resilience.ts.
 */
export function createUpstreamClient(options: UpstreamClientOptions): UpstreamClient {
  const { upstream, baseUrl, logger, clock } = options;
  const policy = options.policy ?? POLICIES[upstream];
  const doFetch = options.fetch ?? fetch;
  const resilience = createResilience({ upstream, policy, logger });
  const base = baseUrl.replace(/\/+$/, '');

  function buildHeaders(request: UpstreamRequest): Record<string, string> {
    const headers: Record<string, string> = { ...request.headers };
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    const context = currentContext();
    if (context !== undefined) {
      headers['x-request-id'] = context.correlationId;
      const traceparent = childTraceparent(context.traceparent);
      if (traceparent !== undefined) headers.traceparent = traceparent;
    }
    return headers;
  }

  async function attempt(
    request: UpstreamRequest,
    { signal }: AttemptContext,
  ): Promise<UpstreamResponse> {
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${base}${request.path}`, {
        method: request.method ?? 'GET',
        headers: buildHeaders(request),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal,
      });
      text = await response.text();
    } catch (error) {
      // An abort is the attempt timeout; the timeout policy reports it.
      if (signal.aborted) throw error;
      throw new UpstreamError(upstream, 'unavailable', { cause: error });
    }

    const { status } = response;
    if ((status >= 200 && status < 300) || status === 304) {
      return { status, headers: response.headers, text };
    }
    if (status === 429) {
      throw new UpstreamError(upstream, 'throttled', {
        status,
        retryAfterSec:
          parseRetryAfterSec(response.headers.get('retry-after'), clock) ?? DEFAULT_RETRY_AFTER_SEC,
      });
    }
    if (status >= 500) throw new UpstreamError(upstream, 'server_error', { status });
    if (status === 404) throw new UpstreamError(upstream, 'not_found', { status });
    const code = errorCode(text);
    // 1xx/3xx other than 304 aren't expected from these upstreams: treat as our error.
    throw new UpstreamError(upstream, 'client_error', {
      status,
      ...(code === undefined ? {} : { code }),
    });
  }

  return {
    upstream,
    request(request) {
      const retryable = request.retryable ?? (request.method ?? 'GET') === 'GET';
      // Log the path only: query strings can carry identifiers and filters.
      const path = request.path.split('?')[0] ?? request.path;
      return resilience.execute((context) => attempt(request, context), { retryable, path });
    },
    health: () => resilience.health(),
  };
}
