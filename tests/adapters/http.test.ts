import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import type { Deadline } from '../../src/adapters/deadline.js';
import { UpstreamError } from '../../src/adapters/errors.js';
import { createUpstreamClient } from '../../src/adapters/http.js';
import type { UpstreamPolicy } from '../../src/adapters/resilience.js';
import type { Upstream } from '../../src/adapters/errors.js';
import { runWithContext, type RequestContext } from '../../src/observability/context.js';
import { captureLogs } from '../http/helpers.js';

type Handler = (url: string, init: RequestInit) => Promise<Response>;

const reply =
  (status: number, body = '', headers: Record<string, string> = {}): Handler =>
  () =>
    Promise.resolve(new Response(body, { status, headers }));

/** Never answers; rejects when the attempt's signal aborts (the timeout). */
const hang: Handler = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });

const networkError: Handler = () => Promise.reject(new TypeError('fetch failed'));

/** A fake fetch that plays the handlers in order, repeating the last one. */
function fakeFetch(...handlers: Handler[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const request = init ?? {};
    calls.push({ url, init: request });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (handler === undefined) throw new Error('no handler');
    return handler(url, request);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function setup(
  handlers: Handler[],
  options: { upstream?: Upstream; policy?: UpstreamPolicy } = {},
) {
  const logs = captureLogs();
  const fake = fakeFetch(...handlers);
  const client = createUpstreamClient({
    upstream: options.upstream ?? 'case_system',
    baseUrl: 'http://cases.test/',
    logger: logs.logger,
    clock: fixedClock('2026-11-06T12:00:00Z'),
    fetch: fake.fetch,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  return { client, logs, calls: fake.calls };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: UpstreamError };

/** Runs a call to completion under fake timers. */
async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  const outcome = promise.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => {
      if (!(error instanceof UpstreamError)) throw error;
      return { ok: false, error };
    },
  );
  await vi.runAllTimersAsync();
  return outcome;
}

async function failure(promise: Promise<unknown>): Promise<UpstreamError> {
  const outcome = await settle(promise);
  if (outcome.ok) throw new Error('expected a failure');
  return outcome.error;
}

/** A request context whose budget the test controls. */
function contextWithBudget(remaining: () => number): RequestContext {
  const deadline: Deadline = { remainingMs: remaining };
  return {
    correlationId: 'req-123',
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    deadline,
  };
}

const FAST: UpstreamPolicy = { attemptTimeoutMs: 100, maxRetries: 0, breaker: true };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('successes', () => {
  it('returns 2xx with status, headers and text, joining base URL and path', async () => {
    const { client, calls } = setup([reply(200, '{"a":1}', { etag: '"v1"' })]);
    const outcome = await settle(client.request({ path: '/cases?status=open' }));
    expect(outcome.ok && outcome.value.text).toBe('{"a":1}');
    expect(outcome.ok && outcome.value.headers.get('etag')).toBe('"v1"');
    expect(calls[0]?.url).toBe('http://cases.test/cases?status=open');
  });
});

describe('retries (S3-6)', () => {
  it('waits the jittered backoff between attempts, not back to back', async () => {
    // Full jitter: the first retry waits up to 100 ms; pin the random draw near the top.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const { client, calls } = setup([reply(503), reply(200, 'ok')]);
    const pending = client.request({ path: '/cases' });
    await vi.advanceTimersByTimeAsync(98);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(2);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    random.mockRestore();
  });

  it.each([
    ['5xx', reply(503)],
    ['timeout', hang],
    ['network error', networkError],
  ])('retries after a %s, then succeeds', async (_name, first) => {
    const { client, calls } = setup([first, reply(200, 'ok')]);
    const outcome = await settle(client.request({ path: '/cases' }));
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['5xx', reply(500), 'server_error'],
    ['timeout', hang, 'timeout'],
    ['network error', networkError, 'unavailable'],
  ] as const)(
    'case system makes at most 3 attempts on %s, then fails as %s',
    async (_n, h, kind) => {
      const { client, calls } = setup([h]);
      const error = await failure(client.request({ path: '/cases' }));
      expect(error.kind).toBe(kind);
      expect(calls).toHaveLength(3);
    },
  );

  it('usage warehouse makes at most 2 attempts', async () => {
    const { client, calls } = setup([reply(502)], { upstream: 'usage_warehouse' });
    expect((await failure(client.request({ path: '/usage' }))).kind).toBe('server_error');
    expect(calls).toHaveLength(2);
  });

  it.each([404, 400, 422])('never retries a %i', async (status) => {
    const { client, calls } = setup([reply(status), reply(200)]);
    const error = await failure(client.request({ path: '/cases/X' }));
    expect(error.kind).toBe(status === 404 ? 'not_found' : 'client_error');
    expect(error.info.status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it('a non-retryable POST is attempted once', async () => {
    const { client, calls } = setup([reply(503), reply(200)]);
    const error = await failure(client.request({ method: 'POST', path: '/x', body: { a: 1 } }));
    expect(error.kind).toBe('server_error');
    expect(calls).toHaveLength(1);
  });

  it('a POST marked retryable is retried', async () => {
    const { client, calls } = setup([reply(503), reply(201)]);
    const outcome = await settle(
      client.request({ method: 'POST', path: '/x', body: {}, retryable: true }),
    );
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('429 and Retry-After (S3-6)', () => {
  it('waits for a short Retry-After, then retries', async () => {
    const { client, calls } = setup([reply(429, '', { 'retry-after': '2' }), reply(200)]);
    const promise = runWithContext(
      contextWithBudget(() => 10_000),
      () => client.request({ path: '/cases' }),
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect((await settle(promise)).ok).toBe(true);
  });

  it('honours an HTTP-date Retry-After read against the injected clock', async () => {
    const { client, calls } = setup([
      reply(429, '', { 'retry-after': 'Fri, 06 Nov 2026 12:00:03 GMT' }),
      reply(200),
    ]);
    const promise = runWithContext(
      contextWithBudget(() => 10_000),
      () => client.request({ path: '/cases' }),
    );
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect((await settle(promise)).ok).toBe(true);
  });

  it('gives up at once as throttled when Retry-After does not fit the budget', async () => {
    const { client, calls } = setup([reply(429, '', { 'retry-after': '30' }), reply(200)]);
    const error = await failure(
      runWithContext(
        contextWithBudget(() => 10_000),
        () => client.request({ path: '/cases' }),
      ),
    );
    expect(error.kind).toBe('throttled');
    expect(error.info.retryAfterSec).toBe(30);
    expect(calls).toHaveLength(1);
  });

  it('defaults Retry-After to 5 s when the upstream gives none', async () => {
    const { client } = setup([reply(429)]);
    const error = await failure(
      runWithContext(
        contextWithBudget(() => 6000),
        () => client.request({ path: '/cases' }),
      ),
    );
    expect(error.kind).toBe('throttled');
    expect(error.info.retryAfterSec).toBe(5);
  });
});

describe('request budget (S3-6)', () => {
  it('skips a retry when the time left is below one attempt timeout', async () => {
    const { client, calls } = setup([reply(503), reply(200)]);
    const error = await failure(
      runWithContext(
        contextWithBudget(() => 2999),
        () => client.request({ path: '/cases' }),
      ),
    );
    expect(error.kind).toBe('server_error');
    expect(calls).toHaveLength(1);
  });

  it('fails as budget_exhausted without calling when no time is left', async () => {
    const { client, calls } = setup([reply(200)]);
    const error = await failure(
      runWithContext(
        contextWithBudget(() => 0),
        () => client.request({ path: '/cases' }),
      ),
    );
    expect(error.kind).toBe('budget_exhausted');
    expect(calls).toHaveLength(0);
  });

  it('cuts the attempt timeout to the time left, and that is not an upstream timeout', async () => {
    const { client, calls } = setup([hang]);
    const promise = runWithContext(
      contextWithBudget(() => 500),
      () => client.request({ path: '/cases' }),
    );
    const outcome = settle(promise);
    await vi.advanceTimersByTimeAsync(500);
    const result = await outcome;
    expect(!result.ok && result.error.kind).toBe('budget_exhausted');
    expect(calls).toHaveLength(1);
  });
});

describe('circuit breaker (S3-7)', () => {
  it('opens after 5 consecutive failed attempts; the next call fails fast without fetch', async () => {
    const { client, calls, logs } = setup([reply(500)]);
    expect((await failure(client.request({ path: '/a' }))).kind).toBe('server_error');
    expect(calls).toHaveLength(3);
    // Attempts 4 and 5 open the breaker; the third attempt of this call is refused.
    const second = await failure(client.request({ path: '/a' }));
    expect(second.kind).toBe('circuit_open');
    expect(second.info.retryAfterSec).toBe(10);
    expect(calls).toHaveLength(5);
    expect((await failure(client.request({ path: '/a' }))).kind).toBe('circuit_open');
    expect(calls).toHaveLength(5);
    expect(client.health()).toBe('unavailable');
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({ upstream: 'case_system', breaker: 'open', level: 'warn' }),
    );
  });

  it('counts 429s: five in a row open it', async () => {
    const { client, calls } = setup([reply(429, '', { 'retry-after': '60' })], { policy: FAST });
    for (let i = 0; i < 5; i++) {
      expect((await failure(client.request({ path: '/a' }))).kind).toBe('throttled');
    }
    expect((await failure(client.request({ path: '/a' }))).kind).toBe('circuit_open');
    expect(calls).toHaveLength(5);
  });

  it('never opens on 404 or other 4xx, however many', async () => {
    const { client, calls } = setup(
      [...Array<Handler>(10).fill(reply(404)), ...Array<Handler>(10).fill(reply(400)), reply(200)],
      { policy: FAST },
    );
    for (let i = 0; i < 20; i++) await failure(client.request({ path: '/a' }));
    expect(client.health()).toBe('ok');
    expect((await settle(client.request({ path: '/a' }))).ok).toBe(true);
    expect(calls).toHaveLength(21);
  });

  it('goes open → half-open after 10 s → closed on a successful probe, logging each', async () => {
    let releaseProbe: () => void = () => undefined;
    const probe: Handler = () =>
      new Promise((resolve) => {
        releaseProbe = () => {
          resolve(new Response('ok', { status: 200 }));
        };
      });
    const { client, logs } = setup([...Array<Handler>(5).fill(reply(503)), probe], {
      policy: { ...FAST, attemptTimeoutMs: 60_000 },
    });
    for (let i = 0; i < 5; i++) await failure(client.request({ path: '/a' }));
    expect(client.health()).toBe('unavailable');

    await vi.advanceTimersByTimeAsync(9_999);
    expect((await failure(client.request({ path: '/a' }))).kind).toBe('circuit_open');
    await vi.advanceTimersByTimeAsync(1);

    const pending = client.request({ path: '/a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.health()).toBe('degraded');
    releaseProbe();
    expect((await settle(pending)).ok).toBe(true);
    expect(client.health()).toBe('ok');

    const transitions = logs
      .lines()
      .filter((line) => line.breaker !== undefined)
      .map((line) => [line.upstream, line.breaker, line.level]);
    expect(transitions).toEqual([
      ['case_system', 'open', 'warn'],
      ['case_system', 'half-open', 'info'],
      ['case_system', 'closed', 'info'],
    ]);
  });

  it('a failed half-open probe reopens it', async () => {
    const { client, logs } = setup([reply(503)], { policy: FAST });
    for (let i = 0; i < 5; i++) await failure(client.request({ path: '/a' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await failure(client.request({ path: '/a' }))).kind).toBe('server_error');
    expect(client.health()).toBe('unavailable');
    const states = logs
      .lines()
      .filter((line) => line.breaker !== undefined)
      .map((line) => line.breaker);
    expect(states).toEqual(['open', 'half-open', 'open']);
  });

  it('entitlement has no breaker and always reports ok', async () => {
    const { client, calls } = setup([reply(500)], {
      upstream: 'entitlement',
      policy: { attemptTimeoutMs: 100, maxRetries: 0, breaker: false },
    });
    for (let i = 0; i < 8; i++) await failure(client.request({ path: '/export.csv' }));
    expect(calls).toHaveLength(8);
    expect(client.health()).toBe('ok');
  });
});

describe('propagation and logging (S3-13, S3-8)', () => {
  it('sends X-Request-Id and a child traceparent: same trace ID and flags, new span ID', async () => {
    const { client, calls } = setup([reply(200)]);
    const context = contextWithBudget(() => 10_000);
    await settle(runWithContext(context, () => client.request({ path: '/cases' })));
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-request-id']).toBe('req-123');
    const [version, traceId, spanId, flags] = (headers.traceparent ?? '').split('-');
    expect(version).toBe('00');
    expect(traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(flags).toBe('01');
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanId).not.toBe('b7ad6b7169203331');
  });

  it('sends a JSON body with content-type application/json', async () => {
    const { client, calls } = setup([reply(201)]);
    await settle(client.request({ method: 'POST', path: '/x', body: { text: 'hi' } }));
    const init = calls[0]?.init;
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init?.body).toBe('{"text":"hi"}');
    expect(init?.method).toBe('POST');
  });

  it('logs failed attempts with status, kind and attempt, never the body or query', async () => {
    const { client, logs } = setup([
      reply(400, '{"code":"INVALID_FIELD","message":"jane@example.com SECRET-BODY"}'),
    ]);
    const error = await failure(client.request({ path: '/cases?accountId=ACC-007' }));
    expect(error.info.code).toBe('INVALID_FIELD');
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        upstream: 'case_system',
        kind: 'client_error',
        status: 400,
        code: 'INVALID_FIELD',
        attempt: 1,
        path: '/cases',
        level: 'warn',
      }),
    );
    expect(logs.text()).not.toContain('SECRET-BODY');
    expect(logs.text()).not.toContain('ACC-007');
  });

  it('never puts the upstream body in the error', async () => {
    const { client } = setup([reply(500, 'stack trace SECRET-BODY')]);
    const error = await failure(client.request({ path: '/a' }));
    expect(error.message).not.toContain('SECRET-BODY');
    expect(JSON.stringify(error.info)).not.toContain('SECRET-BODY');
  });
});

describe('upstream error codes', () => {
  it('reads the code from a Salesforce-style error array, never the message', async () => {
    const body = JSON.stringify([{ errorCode: 'MALFORMED_QUERY', message: 'secret detail' }]);
    const { client, logs } = setup([reply(400, body)]);
    const error = await failure(client.request({ path: '/cases?bad=1' }));
    expect(error.kind).toBe('client_error');
    const line = logs.lines().find((l) => l.kind === 'client_error');
    expect(line?.code).toBe('MALFORMED_QUERY');
    expect(logs.text()).not.toContain('secret detail');
  });
});
