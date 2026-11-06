import { describe, expect, it } from 'vitest';
import { useMockServer } from './helpers.js';

const h = useMockServer();

interface Page {
  totalSize: number;
  done: boolean;
  records: Record<string, unknown>[];
  nextRecordsUrl?: string;
}

async function getPage(pathAndQuery: string): Promise<Page> {
  const res = await fetch(`${h.url}${pathAndQuery}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

function ids(page: Page): string[] {
  return page.records.map((r) => r.id as string);
}

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('case system query (S1-2)', () => {
  it('walks all pages at pageSize=4, each case exactly once', async () => {
    const seen: string[] = [];
    let page = await getPage('/cases?pageSize=4');
    let pages = 1;
    expect(page.totalSize).toBe(11);
    seen.push(...ids(page));
    while (page.nextRecordsUrl !== undefined) {
      expect(page.done).toBe(false);
      page = await getPage(page.nextRecordsUrl);
      expect(page.totalSize).toBe(11);
      seen.push(...ids(page));
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(page.done).toBe(true);
    expect(page.nextRecordsUrl).toBeUndefined();
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
    expect(seen).toEqual([...seen].sort());
  });

  it('defaults pageSize to 5', async () => {
    const page = await getPage('/cases');
    expect(page.records).toHaveLength(5);
    expect(page.nextRecordsUrl).toBeDefined();
  });

  it('filters by status and priority', async () => {
    const page = await getPage('/cases?status=open,in_progress&priority=P1&pageSize=200');
    expect(ids(page)).toEqual([
      'CS-10231',
      'CS-10232',
      'CS-10233',
      'CS-10236',
      'CS-10237',
      'CS-10238',
      'CS-10239',
      'CS-10240',
      'CS-10241',
    ]);
    expect(page.totalSize).toBe(9);
  });

  it('filters by accountId', async () => {
    const page = await getPage('/cases?accountId=ACC-012');
    expect(ids(page)).toEqual(['CS-10236']);
  });

  it('treats openedBefore as exclusive and openedAfter as inclusive', async () => {
    const before = await getPage('/cases?openedBefore=2026-11-04T13:00:00Z&pageSize=200');
    expect(ids(before)).not.toContain('CS-10232');
    expect(ids(before)).toContain('CS-10233');
    const after = await getPage('/cases?openedAfter=2026-11-04T13:00:00Z&pageSize=200');
    expect(ids(after)).toContain('CS-10232');
    expect(ids(after)).not.toContain('CS-10233');
  });

  it.each([
    'status=bogus',
    'status=open,bogus',
    'priority=P9',
    'openedAfter=yesterday',
    'openedBefore=2026-11-04',
    'pageSize=0',
    'pageSize=201',
    'pageSize=abc',
    'status=open&status=closed',
  ])('rejects invalid filter %s with the Salesforce error array', async (query) => {
    const res = await fetch(`${h.url}/cases?${query}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode: string; message: string }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]?.errorCode).toBe('MALFORMED_QUERY');
    expect(typeof body[0]?.message).toBe('string');
  });

  it('rejects a malformed locator token', async () => {
    const res = await fetch(`${h.url}/cases/query/not-a-token`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode: string }[];
    expect(body[0]?.errorCode).toBe('INVALID_QUERY_LOCATOR');
  });

  it('rejects a well-formed token with bad contents', async () => {
    const token = Buffer.from(JSON.stringify({ offset: -1, filters: {}, pageSize: 5 })).toString(
      'base64url',
    );
    expect((await fetch(`${h.url}/cases/query/${token}`)).status).toBe(400);
  });
});

describe('case system read (S1-2)', () => {
  it('preserves the mixed casing and returns a quoted ETag', async () => {
    const res = await fetch(`${h.url}/cases/CS-10231`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    const record = (await res.json()) as Record<string, unknown>;
    expect(record).toMatchObject({
      Status: 'open',
      IsEscalated: false,
      openedAt: '2026-10-24T08:12:00Z',
      accountId: 'ACC-007',
    });
    expect(Array.isArray(record.Comments)).toBe(true);
    expect(record).not.toHaveProperty('status');
    expect(record).not.toHaveProperty('comments');
  });

  it('returns 404 in the Salesforce shape for an unknown case', async () => {
    const res = await fetch(`${h.url}/cases/CS-99999`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { errorCode: string }[];
    expect(body[0]?.errorCode).toBe('NOT_FOUND');
  });
});

describe('case system comments (S1-2)', () => {
  it('creates a comment with the next id, clock time and a version bump', async () => {
    const res = await send('POST', '/cases/CS-10232/comments', { body: 'Hello', author: 'jdoe' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(await res.json()).toEqual({
      id: 'CM-7',
      success: true,
      errors: [],
      at: '2026-11-06T12:00:00Z',
    });
    const record = (await (await fetch(`${h.url}/cases/CS-10232`)).json()) as {
      version: number;
      Comments: Record<string, unknown>[];
    };
    expect(record.version).toBe(2);
    expect(record.Comments).toEqual([
      { id: 'CM-7', author: 'jdoe', body: 'Hello', at: '2026-11-06T12:00:00Z' },
    ]);
  });

  it('continues the id counter across cases', async () => {
    await send('POST', '/cases/CS-10232/comments', { body: 'a', author: 'x' });
    const res = await send('POST', '/cases/CS-10234/comments', { body: 'b', author: 'x' });
    expect(((await res.json()) as { id: string }).id).toBe('CM-8');
  });

  it('accepts a comment on a closed case', async () => {
    const res = await send('POST', '/cases/CS-10235/comments', { body: 'late', author: 'x' });
    expect(res.status).toBe(201);
  });

  it('404s for an unknown case', async () => {
    const res = await send('POST', '/cases/CS-99999/comments', { body: 'a', author: 'x' });
    expect(res.status).toBe(404);
  });

  it.each([
    ['empty body', { body: '', author: 'x' }],
    ['missing author', { body: 'a' }],
    ['empty author', { body: 'a', author: '' }],
    ['non-string body', { body: 5, author: 'x' }],
    ['too long', { body: 'a'.repeat(4001), author: 'x' }],
    ['extra key', { body: 'a', author: 'x', extra: 1 }],
    ['array', []],
  ])('rejects %s with 400 INVALID_FIELD', async (_name, payload) => {
    const res = await send('POST', '/cases/CS-10232/comments', payload);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode: string }[];
    expect(body[0]?.errorCode).toBe('INVALID_FIELD');
  });

  it('accepts a body of exactly 4000 characters', async () => {
    const res = await send('POST', '/cases/CS-10232/comments', {
      body: 'a'.repeat(4000),
      author: 'x',
    });
    expect(res.status).toBe(201);
  });

  it('rejects a request with no JSON body', async () => {
    const res = await fetch(`${h.url}/cases/CS-10232/comments`, { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('case system escalation write-through (S1-2)', () => {
  const escalation = {
    IsEscalated: true,
    EscalationReason: 'P1 outage',
    EscalationNote: null,
    EscalatedAt: '2026-11-06T12:00:00Z',
    EscalatedBy: 'user-1',
    EscalatedByAgent: 'agent-1',
    EscalationApprovedBy: 'user-1',
  };

  it('requires If-Match (428)', async () => {
    const res = await send('PATCH', '/cases/CS-10232', escalation);
    expect(res.status).toBe(428);
    const body = (await res.json()) as { errorCode: string }[];
    expect(body[0]?.errorCode).toBe('PRECONDITION_REQUIRED');
  });

  it('rejects a stale version (412)', async () => {
    const res = await send('PATCH', '/cases/CS-10232', escalation, { 'If-Match': '"9"' });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { errorCode: string }[];
    expect(body[0]?.errorCode).toBe('PRECONDITION_FAILED');
  });

  it('404s before checking If-Match', async () => {
    const res = await send('PATCH', '/cases/CS-99999', escalation);
    expect(res.status).toBe(404);
  });

  it('checks If-Match before the body', async () => {
    const res = await send('PATCH', '/cases/CS-10232', { nope: 1 }, { 'If-Match': '"9"' });
    expect(res.status).toBe(412);
  });

  it.each([
    ['unknown key', { Status: 'closed' }],
    ['wrong type', { IsEscalated: 'yes' }],
    ['null where string required', { EscalationReason: null }],
    ['empty object', {}],
    ['array', []],
  ])('rejects %s with 400 INVALID_FIELD', async (_name, payload) => {
    const res = await send('PATCH', '/cases/CS-10232', payload, { 'If-Match': '"1"' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode: string }[];
    expect(body[0]?.errorCode).toBe('INVALID_FIELD');
  });

  it('applies the fields, bumps the version and returns 204 with the new ETag', async () => {
    const res = await send('PATCH', '/cases/CS-10232', escalation, { 'If-Match': '"1"' });
    expect(res.status).toBe(204);
    expect(res.headers.get('etag')).toBe('"2"');
    const record = (await (await fetch(`${h.url}/cases/CS-10232`)).json()) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ ...escalation, version: 2 });
    // The old version no longer matches.
    const again = await send('PATCH', '/cases/CS-10232', escalation, { 'If-Match': '"1"' });
    expect(again.status).toBe(412);
  });

  it('accepts an unquoted If-Match', async () => {
    const res = await send('PATCH', '/cases/CS-10232', { IsEscalated: true }, { 'If-Match': '1' });
    expect(res.status).toBe(204);
  });
});

describe('case system reset', () => {
  it('restores fixture state and the comment counter (part 1: mutate)', async () => {
    await send('POST', '/cases/CS-10232/comments', { body: 'a', author: 'x' });
    await send('PATCH', '/cases/CS-10234', { IsEscalated: true }, { 'If-Match': '1' });
  });

  it('restores fixture state and the comment counter (part 2: verify)', async () => {
    const record = (await (await fetch(`${h.url}/cases/CS-10232`)).json()) as {
      version: number;
      Comments: unknown[];
    };
    expect(record.version).toBe(1);
    expect(record.Comments).toHaveLength(0);
    const res = await send('POST', '/cases/CS-10232/comments', { body: 'a', author: 'x' });
    expect(((await res.json()) as { id: string }).id).toBe('CM-7');
  });

  it('reset() via the mock handle restores state mid-test', async () => {
    await send('PATCH', '/cases/CS-10234', { IsEscalated: true }, { 'If-Match': '1' });
    h.mock.reset();
    const record = (await (await fetch(`${h.url}/cases/CS-10234`)).json()) as {
      IsEscalated: boolean;
      version: number;
    };
    expect(record).toMatchObject({ IsEscalated: false, version: 1 });
  });
});
