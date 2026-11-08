/**
 * `GET /v1/cases/{caseId}` through the real server against the mock upstreams
 * (S3-11, S3-12, S3-14). The server validates every response against the
 * contract, so a body with an extra key would fail here as a 500.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../../src/clock.js';
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
afterEach(async () => {
  await running?.shutdown();
  await mocks?.close();
  running = undefined;
  mocks = undefined;
});

interface CommentBody {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}
interface CaseBody {
  id: string;
  accountId: string;
  account: Record<string, string> | null;
  comments: CommentBody[];
  commentCount: number;
  [key: string]: unknown;
}

async function start(setup?: (m: NonNullable<typeof mocks>) => void): Promise<void> {
  mocks = await startRecordingMocks();
  setup?.(mocks);
  ({ running, auth } = await startServerWithAuth(captureLogs().logger, {
    env: { MOCKS_URL: mocks.url },
    clock: fixedClock(FIXTURE_NOW),
  }));
  await waitForReady(running.url);
}

const getCase = (id: string): Promise<Response> =>
  fetch(`${running?.url ?? ''}/v1/cases/${id}`, { headers: auth });

const UPSTREAM_KEYS = ['Status', 'Comments', 'IsEscalated', 'version', 'etag', 'at'];

function expectNoUpstreamKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoUpstreamKeys);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      expect(UPSTREAM_KEYS).not.toContain(key);
      expectNoUpstreamKeys(inner);
    }
  }
}

describe('a case (S3-11)', () => {
  it('returns the canonical case with its ETag, comments newest last and the count', async () => {
    await start();
    const res = await getCase('CS-10231');
    expect(res.status).toBe(200);
    // Fixture version 3: `"` + base64url("CS-10231:3") + `"`.
    const expectedTag = `"${Buffer.from('CS-10231:3').toString('base64url')}"`;
    expect(res.headers.get('etag')).toBe(expectedTag);
    const body = (await res.json()) as CaseBody;
    expect(body).toEqual({
      id: 'CS-10231',
      accountId: 'ACC-007',
      account: { name: 'Acme Corp', supportTier: 'platinum', renewalDate: '2027-01-15' },
      subject: 'Backup failing on node 3',
      status: 'open',
      priority: 'P1',
      openedAt: '2026-10-24T08:12:00Z',
      escalation: null,
      comments: [
        {
          id: 'CM-1',
          author: 'jdoe',
          body: 'Investigating',
          createdAt: '2026-10-24T09:00:00Z',
        },
        {
          id: 'CM-2',
          author: 'asmith',
          body: 'Customer contact is jane.doe@acme.example, +1-415-555-0142. Prefers a call before any change window.',
          createdAt: '2026-10-25T10:00:00Z',
        },
      ],
      commentCount: 2,
    });
    expectNoUpstreamKeys(body);
  });

  it('returns only the newest 50 comments, newest last, with the full count', async () => {
    await start();
    // Add 55 comments straight to the mock case system: 57 in all.
    for (let i = 1; i <= 55; i += 1) {
      const added = await fetch(`${mocks?.url ?? ''}/cases/CS-10231/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: 'bulk', body: `comment ${String(i)}` }),
      });
      expect(added.status).toBe(201);
    }
    const res = await getCase('CS-10231');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseBody;
    expect(body.commentCount).toBe(57);
    expect(body.comments).toHaveLength(50);
    // The oldest 7 (CM-1, CM-2 and comments 1–5) are dropped.
    expect(body.comments[0]?.body).toBe('comment 6');
    expect(body.comments.at(-1)?.body).toBe('comment 55');
    // The ETag follows the upstream version: 3 + 55 comments.
    expect(res.headers.get('etag')).toBe(`"${Buffer.from('CS-10231:58').toString('base64url')}"`);
  });

  it('gives 404 not-found for an unknown case', async () => {
    await start();
    const res = await getCase('CS-99999');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string };
    expect(body.type).toMatch(/\/not-found$/);
    expectNoUpstreamKeys(body);
  });

  it('maps a failing case system to a problem (S3 §2.3), with no upstream body', async () => {
    await start((m) => m.mock.faults.update('cases', { forceStatus: 503 }));
    const res = await getCase('CS-10231');
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toMatch(/upstream-error/);
    expect(res.headers.get('etag')).toBeNull();
  });
});

describe('a case whose account has no entitlement record (S3-12)', () => {
  it('returns account: null and reports the account as unmatched', async () => {
    await start();
    if (running === undefined) throw new Error('server not started');
    const report = vi.spyOn(running.upstreams.entitlement, 'reportUnmatched');
    const res = await getCase('CS-10241');
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseBody;
    expect(body.accountId).toBe('ACC-099');
    expect(body.account).toBeNull();
    expect(report).toHaveBeenCalledWith('ACC-099');
  });
});
