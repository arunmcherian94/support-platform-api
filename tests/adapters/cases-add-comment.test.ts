/**
 * Case adapter comment write (S4 §2.1): canonical comment from the mock case
 * system, a single attempt (never retried), and not_found propagated.
 */
import { describe, expect, it } from 'vitest';
import { createCaseSystem } from '../../src/adapters/cases.js';
import { UpstreamError } from '../../src/adapters/errors.js';
import { createUpstreamClient } from '../../src/adapters/http.js';
import { fixedClock } from '../../src/clock.js';
import { captureLogs } from '../http/helpers.js';
import type { UpstreamClient, UpstreamRequest } from '../../src/adapters/types.js';
import { FIXTURE_NOW, useMockServer } from '../mocks/helpers.js';

const h = useMockServer();

/** Records each request and answers with fixed text, standing in for the resilient client. */
function fakeClient(text: string): { client: UpstreamClient; seen: UpstreamRequest[] } {
  const seen: UpstreamRequest[] = [];
  return {
    seen,
    client: {
      upstream: 'case_system',
      health: () => 'ok',
      request: (request) => {
        seen.push(request);
        return Promise.resolve({ status: 201, headers: new Headers(), text });
      },
    },
  };
}

describe('case adapter addComment', () => {
  it('POSTs { body, author } once, marked not retryable, to the encoded case path', async () => {
    const { client, seen } = fakeClient(
      JSON.stringify({ id: 'CM-9', success: true, errors: [], at: '2026-11-06T12:00:00Z' }),
    );
    const comment = await createCaseSystem(client).addComment('CS 1/x', {
      author: 'jdoe',
      body: 'hello',
    });
    expect(comment).toEqual({
      id: 'CM-9',
      author: 'jdoe',
      body: 'hello',
      createdAt: '2026-11-06T12:00:00Z',
    });
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/cases/CS%201%2Fx/comments',
        body: { body: 'hello', author: 'jdoe' },
        retryable: false,
      },
    ]);
  });

  it.each([
    ['not JSON', '{"id": "CM-9", oops'],
    ['missing id', JSON.stringify({ success: true, errors: [], at: '2026-11-06T12:00:00Z' })],
    ['success false', JSON.stringify({ id: 'CM-9', success: false, errors: [], at: 'x' })],
    ['an array', '[]'],
  ])(
    'reports a body that is %s as bad_response, without the body in the cause',
    async (_, text) => {
      const { client } = fakeClient(text);
      const error = await createCaseSystem(client)
        .addComment('CS-1', { author: 'jdoe', body: 'hello' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).kind).toBe('bad_response');
      expect((error as UpstreamError).cause).not.toBeInstanceOf(SyntaxError);
      expect(String((error as UpstreamError).cause)).not.toContain('oops');
    },
  );
});

describe('case adapter addComment through the resilient client and the mock', () => {
  /** The real resilient client against the mock, with fetch wrapped to count attempts. */
  function system(): { cases: ReturnType<typeof createCaseSystem>; attempts: string[] } {
    const attempts: string[] = [];
    const counting = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      attempts.push(`${init?.method ?? 'GET'} ${url}`);
      return fetch(input, init);
    }) as typeof fetch;
    const client = createUpstreamClient({
      upstream: 'case_system',
      baseUrl: h.url,
      logger: captureLogs().logger,
      clock: fixedClock(FIXTURE_NOW),
      fetch: counting,
    });
    return { cases: createCaseSystem(client), attempts };
  }

  it('returns the canonical comment the mock created', async () => {
    const { cases } = system();
    const comment = await cases.addComment('CS-10231', { author: 'jdoe', body: 'Looking now' });
    expect(comment).toEqual({
      id: expect.stringMatching(/^CM-\d+$/) as string,
      author: 'jdoe',
      body: 'Looking now',
      createdAt: FIXTURE_NOW,
    });
  });

  it.each([500, 503])('makes exactly one attempt on a %i (never retried)', async (status) => {
    h.mock.faults.update('cases', { forceStatus: status, retryAfterSeconds: 0 });
    const { cases, attempts } = system();
    const error = await cases
      .addComment('CS-10231', { author: 'jdoe', body: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).kind).toBe('server_error');
    expect(attempts).toHaveLength(1);
  });

  it('propagates not_found for an unknown case', async () => {
    const { cases, attempts } = system();
    const error = await cases
      .addComment('CS-404', { author: 'jdoe', body: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).kind).toBe('not_found');
    expect(attempts).toHaveLength(1);
  });
});
