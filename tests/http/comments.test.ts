/**
 * `POST /v1/cases/{caseId}/comments` through the real server against the mock
 * case system (S4-1 to S4-5). The server validates every response against the
 * contract; the recording mocks count the upstream POSTs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock, type TestClock } from '../../src/clock.js';
import {
  canonicalJson,
  parseIdempotencyKey,
  requestHash,
} from '../../src/http/handlers/comments.js';
import type { RunningServer } from '../../src/server.js';
import {
  captureLogs,
  FIXTURE_NOW,
  startRecordingMocks,
  startServerWithAuth,
  waitForReady,
} from './helpers.js';

let running: RunningServer | undefined;
let auth: { authorization: string } = { authorization: '' };
let mocks: Awaited<ReturnType<typeof startRecordingMocks>> | undefined;
let clock: TestClock = fixedClock(FIXTURE_NOW);
afterEach(async () => {
  await running?.shutdown();
  await mocks?.close();
  running = undefined;
  mocks = undefined;
});

async function start(): Promise<void> {
  mocks = await startRecordingMocks();
  clock = fixedClock(FIXTURE_NOW);
  ({ running, auth } = await startServerWithAuth(captureLogs().logger, {
    env: { MOCKS_URL: mocks.url },
    clock,
  }));
  await waitForReady(running.url);
}

/** Upstream comment POSTs seen by the mock, for one case. */
const upstreamPosts = (caseId = 'CS-10231'): number =>
  (mocks?.seen ?? []).filter((s) => s.path === `/cases/${caseId}/comments`).length;

async function tokenFor(sub: string, clientId: string): Promise<{ authorization: string }> {
  const token = await running?.issuer?.mint({ sub, clientId, scopes: ['cases:comment'] });
  if (token === undefined) throw new Error('no issuer');
  return { authorization: `Bearer ${token}` };
}

function post(
  options: {
    caseId?: string;
    key?: string | null;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const key = options.key === undefined ? '"key-1"' : options.key;
  return fetch(`${running?.url ?? ''}/v1/cases/${options.caseId ?? 'CS-10231'}/comments`, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
      ...options.headers,
    },
    body: options.body ?? JSON.stringify({ body: 'Fix in progress' }),
  });
}

interface CommentBody {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

describe('create and replay (S4-1)', () => {
  it('creates the comment with 201, Location and the canonical body; the author is the token sub', async () => {
    await start();
    const res = await post();
    expect(res.status).toBe(201);
    const body = (await res.json()) as CommentBody;
    expect(body).toEqual({
      id: expect.stringMatching(/^CM-\d+$/) as string,
      author: 'jdoe',
      body: 'Fix in progress',
      createdAt: FIXTURE_NOW,
    });
    expect(res.headers.get('location')).toBe(`/v1/cases/CS-10231/comments/${body.id}`);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    // The comment is really on the case.
    const detail = (await (
      await fetch(`${running?.url ?? ''}/v1/cases/CS-10231`, { headers: auth })
    ).json()) as { comments: CommentBody[] };
    expect(detail.comments.at(-1)).toEqual(body);
  });

  it('replays the same key and body: identical status, body and Location, one upstream POST', async () => {
    await start();
    const first = await post();
    const firstBody: unknown = await first.json();
    const second = await post();
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(firstBody);
    expect(second.headers.get('location')).toBe(first.headers.get('location'));
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(upstreamPosts()).toBe(1);
  });

  it('treats a quoted and an unquoted key with the same text as the same key', async () => {
    await start();
    await post({ key: '"abc"' });
    const res = await post({ key: 'abc' });
    expect(res.headers.get('idempotent-replayed')).toBe('true');
    expect(upstreamPosts()).toBe(1);
  });

  it('replays a body with different whitespace and key order', async () => {
    await start();
    await post({ body: '{"body":"Fix in progress"}' });
    const res = await post({ body: '{\n  "body" :  "Fix in progress"\n}' });
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBe('true');
    expect(upstreamPosts()).toBe(1);
  });
});

describe('mismatch and missing key (S4-2)', () => {
  it('rejects the same key with a different body as 422 idempotency-key-reused', async () => {
    await start();
    await post();
    const res = await post({ body: JSON.stringify({ body: 'Something else' }) });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(((await res.json()) as { type: string }).type).toBe(
      'https://support-platform.example/problems/idempotency-key-reused',
    );
    expect(upstreamPosts()).toBe(1);
  });

  it('rejects a missing key as 400 idempotency-key-required without calling the case system', async () => {
    await start();
    const res = await post({ key: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type: string }).type).toBe(
      'https://support-platform.example/problems/idempotency-key-required',
    );
    expect(upstreamPosts()).toBe(0);
  });
});

describe('concurrency (S4-3)', () => {
  it('lets exactly one of two concurrent requests reach the case system', async () => {
    await start();
    mocks?.mock.faults.update('cases', { latencyMs: 300 });
    const [a, b] = await Promise.all([post(), post()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(((await conflict.json()) as { type: string }).type).toBe(
      'https://support-platform.example/problems/request-in-progress',
    );
    expect(upstreamPosts()).toBe(1);
    // After completion the same key replays.
    const after = await post();
    expect(after.headers.get('idempotent-replayed')).toBe('true');
    expect(upstreamPosts()).toBe(1);
  });
});

describe('scope and expiry (S4-4)', () => {
  it('treats the same key from another client, user or case as a new request', async () => {
    await start();
    await post();
    const otherClient = await post({ headers: await tokenFor('jdoe', 'finance-app') });
    const otherUser = await post({ headers: await tokenFor('asmith', 'support-console') });
    const otherCase = await post({ caseId: 'CS-10232' });
    for (const res of [otherClient, otherUser, otherCase]) {
      expect(res.status).toBe(201);
      expect(res.headers.get('idempotent-replayed')).toBeNull();
    }
    expect(((await otherUser.json()) as CommentBody).author).toBe('asmith');
    expect(upstreamPosts('CS-10231')).toBe(3);
    expect(upstreamPosts('CS-10232')).toBe(1);
  });

  it('treats an expired key (24 h + 1 s later) as a new request', async () => {
    await start();
    const first = (await (await post()).json()) as CommentBody;
    clock.advance(24 * 60 * 60 * 1000 + 1000);
    const res = await post({ headers: await tokenFor('jdoe', 'support-console') });
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    expect(((await res.json()) as CommentBody).id).not.toBe(first.id);
    expect(upstreamPosts()).toBe(2);
  });
});

describe('failures store nothing (S4-5)', () => {
  it('attempts the write once on a 503, then a retry with the same key creates the comment', async () => {
    await start();
    mocks?.mock.faults.update('cases', { forceStatus: 503, retryAfterSeconds: 0 });
    const failed = await post();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(failed.headers.get('content-type')).toContain('application/problem+json');
    expect(upstreamPosts()).toBe(1);

    mocks?.mock.faults.update('cases', { forceStatus: null });
    const retried = await post();
    expect(retried.status).toBe(201);
    expect(retried.headers.get('idempotent-replayed')).toBeNull();
    expect(upstreamPosts()).toBe(2);
  });

  it('returns 404 for an unknown case and releases the key', async () => {
    await start();
    const res = await post({ caseId: 'CS-99999' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { type: string }).type).toBe(
      'https://support-platform.example/problems/not-found',
    );
    expect(running?.db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get()?.['n']).toBe(0);
    // The same key is free: the retry reaches the case system again.
    expect((await post({ caseId: 'CS-99999' })).status).toBe(404);
    expect(upstreamPosts('CS-99999')).toBe(2);
  });
});

describe('key parsing and request hash', () => {
  it('reads a Structured Field string, unescaping \\" and \\\\, or a bare value', () => {
    expect(parseIdempotencyKey('"abc"')).toBe('abc');
    expect(parseIdempotencyKey('"a\\"b\\\\c"')).toBe('a"b\\c');
    expect(parseIdempotencyKey('abc')).toBe('abc');
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it('hashes the same body with any key order identically, and binds the case', () => {
    const a = requestHash('CS-1', { body: 'x', z: { b: 1, a: [2, { d: 1, c: 2 }] } });
    const b = requestHash('CS-1', { z: { a: [2, { c: 2, d: 1 }], b: 1 }, body: 'x' });
    expect(a).toBe(b);
    expect(requestHash('CS-2', { body: 'x' })).not.toBe(requestHash('CS-1', { body: 'x' }));
    expect(requestHash('CS-1', { body: 'y' })).not.toBe(requestHash('CS-1', { body: 'x' }));
    expect(canonicalJson({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}');
  });
});
