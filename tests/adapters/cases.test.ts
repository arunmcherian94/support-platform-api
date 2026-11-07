import { describe, expect, it } from 'vitest';
import { createCaseSystem } from '../../src/adapters/cases.js';
import { UpstreamError, type Upstream } from '../../src/adapters/errors.js';
import type {
  UpstreamClient,
  UpstreamRequest,
  UpstreamResponse,
} from '../../src/adapters/types.js';
import type { CaseQuery } from '../../src/ports/cases.js';
import { useMockServer } from '../mocks/helpers.js';

const h = useMockServer();

/** A minimal stand-in for the resilient client: plain fetch, status mapped to failure kinds. */
function testClient(upstream: Upstream, baseUrl: () => string): UpstreamClient {
  return {
    upstream,
    health: () => 'ok',
    async request(request: UpstreamRequest): Promise<UpstreamResponse> {
      const res = await fetch(`${baseUrl()}${request.path}`, {
        method: request.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...request.headers },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const text = await res.text();
      if (res.status >= 500)
        throw new UpstreamError(upstream, 'server_error', { status: res.status });
      if (res.status === 404) throw new UpstreamError(upstream, 'not_found', { status: 404 });
      if (res.status >= 400)
        throw new UpstreamError(upstream, 'client_error', { status: res.status });
      return { status: res.status, headers: res.headers, text };
    },
  };
}

function fakeClient(text: string): UpstreamClient {
  return {
    upstream: 'case_system',
    health: () => 'ok',
    request: () => Promise.resolve({ status: 200, headers: new Headers(), text }),
  };
}

const realSystem = () => createCaseSystem(testClient('case_system', () => h.url));

const baseQuery: CaseQuery = { sort: { field: 'openedAt', descending: false }, limit: 50 };

const GOOD_CASE = {
  id: 'CS-10231',
  accountId: 'ACC-007',
  priority: 'P1',
  Status: 'open',
  openedAt: '2026-10-24T08:12:00Z',
  subject: 'Backup failing on node 3',
  version: 7,
  IsEscalated: false,
  Comments: [],
};

describe('case adapter get', () => {
  it('returns the canonical CS-10231 with comments oldest first and an ETag from the version', async () => {
    const record = await realSystem().get('CS-10231');
    expect(record).toMatchObject({
      id: 'CS-10231',
      accountId: 'ACC-007',
      status: 'open',
      priority: 'P1',
      openedAt: '2026-10-24T08:12:00Z',
      escalation: null,
      version: 3,
      etag: `"${Buffer.from('CS-10231:3').toString('base64url')}"`,
    });
    expect(record.comments.map((c) => c.id)).toEqual(['CM-1', 'CM-2']);
    expect(record.comments[0]).toEqual({
      id: 'CM-1',
      author: 'jdoe',
      body: 'Investigating',
      createdAt: '2026-10-24T09:00:00Z',
    });
  });

  it('derives the contract example ETag for version 7', async () => {
    const record = await createCaseSystem(fakeClient(JSON.stringify(GOOD_CASE))).get('CS-10231');
    expect(record.etag).toBe('"Q1MtMTAyMzE6Nw"');
  });

  it('leaks no upstream field names', async () => {
    const system = realSystem();
    const detail = JSON.stringify(await system.get('CS-10231'));
    const page = JSON.stringify(await system.search(baseQuery));
    for (const text of [detail, page]) {
      for (const key of ['"Status"', '"Comments"', '"IsEscalated"', '"at"']) {
        expect(text).not.toContain(key);
      }
    }
  });

  it('propagates not_found for an unknown case', async () => {
    await expect(realSystem().get('CS-99999')).rejects.toMatchObject({
      name: 'UpstreamError',
      kind: 'not_found',
    });
  });

  it('encodes the case id in the path', async () => {
    const paths: string[] = [];
    const client: UpstreamClient = {
      ...fakeClient(JSON.stringify(GOOD_CASE)),
      request: (r) => {
        paths.push(r.path);
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          text: JSON.stringify(GOOD_CASE),
        });
      },
    };
    await createCaseSystem(client).get('a/b?c');
    expect(paths).toEqual(['/cases/a%2Fb%3Fc']);
  });

  it('maps an escalated case, omitting null optional fields', async () => {
    const escalated = {
      ...GOOD_CASE,
      IsEscalated: true,
      EscalationReason: 'sla_risk',
      EscalationNote: null,
      EscalatedAt: '2026-11-06T10:00:00Z',
      EscalatedBy: 'jdoe',
      EscalatedByAgent: 'copilot',
      EscalationApprovedBy: null,
    };
    const record = await createCaseSystem(fakeClient(JSON.stringify(escalated))).get('CS-10231');
    expect(record.escalation).toEqual({
      reason: 'sla_risk',
      escalatedAt: '2026-11-06T10:00:00Z',
      escalatedBy: { user: 'jdoe', agent: 'copilot' },
    });
    expect(JSON.stringify(record)).not.toContain('Escalat');
  });

  it('sorts comments oldest first even when upstream sends them newest first', async () => {
    const body = {
      ...GOOD_CASE,
      Comments: [
        { id: 'CM-2', author: 'a', body: 'b', at: '2026-10-25T10:00:00Z' },
        { id: 'CM-1', author: 'a', body: 'b', at: '2026-10-24T09:00:00Z' },
      ],
    };
    const record = await createCaseSystem(fakeClient(JSON.stringify(body))).get('CS-10231');
    expect(record.comments.map((c) => c.id)).toEqual(['CM-1', 'CM-2']);
  });
});

describe('case adapter search', () => {
  it('returns limit records and hasMore when the upstream has more', async () => {
    const page = await realSystem().search({ ...baseQuery, limit: 2 });
    expect(page.records.map((r) => r.id)).toEqual(['CS-10235', 'CS-10231']);
    expect(page.hasMore).toBe(true);
  });

  it('reports hasMore false when the result fits within the limit', async () => {
    const page = await realSystem().search({ ...baseQuery, accountIds: ['ACC-012'], limit: 1 });
    expect(page.records.map((r) => r.id)).toEqual(['CS-10236']);
    expect(page.hasMore).toBe(false);
  });

  it('continues with keyset after the last record with no overlap', async () => {
    const system = realSystem();
    const seen: string[] = [];
    let after: CaseQuery['after'];
    for (let i = 0; i < 20; i++) {
      const page = await system.search({
        ...baseQuery,
        limit: 4,
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.records.map((r) => r.id));
      const last = page.records.at(-1);
      if (!page.hasMore || last === undefined) break;
      after = { value: last.openedAt, id: last.id };
    }
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
    expect(seen.slice(0, 4)).toEqual(['CS-10235', 'CS-10231', 'CS-10234', 'CS-10236']);
    expect(seen.at(-1)).toBe('CS-10232');
  });

  it('sends filters, lists, sort and keyset to the upstream, URL-encoded', async () => {
    const paths: string[] = [];
    const client: UpstreamClient = {
      ...fakeClient(''),
      request: (r) => {
        paths.push(r.path);
        return Promise.resolve({ status: 200, headers: new Headers(), text: '{"records":[]}' });
      },
    };
    await createCaseSystem(client).search({
      status: ['open', 'in_progress'],
      priority: ['P1'],
      accountIds: ['ACC-007', 'ACC-012'],
      openedAfter: '2026-10-01T00:00:00+05:30',
      openedBefore: '2026-11-01T00:00:00Z',
      sort: { field: 'priority', descending: true },
      after: { value: 'P1', id: 'CS 1&2' },
      limit: 10,
    });
    expect(paths).toEqual([
      '/cases?status=open,in_progress&priority=P1&accountId=ACC-007,ACC-012' +
        '&openedAfter=2026-10-01T00%3A00%3A00%2B05%3A30&openedBefore=2026-11-01T00%3A00%3A00Z' +
        '&sort=-priority&afterValue=P1&afterId=CS%201%262&pageSize=11',
    ]);
  });
});

describe('case adapter bad responses', () => {
  const cases: [string, string][] = [
    ['invalid JSON', '{not json'],
    ['records not an array', '{"records":{}}'],
    ['missing Status', JSON.stringify({ ...GOOD_CASE, Status: undefined })],
    ['unknown status', JSON.stringify({ ...GOOD_CASE, Status: 'pending' })],
    ['unknown priority', JSON.stringify({ ...GOOD_CASE, priority: 'P9' })],
    ['wrong type version', JSON.stringify({ ...GOOD_CASE, version: '7' })],
    ['escalated without reason', JSON.stringify({ ...GOOD_CASE, IsEscalated: true })],
  ];

  it.each(cases)('search maps %s to bad_response', async (_name, text) => {
    const body =
      text.startsWith('{"records"') || text.startsWith('{not') ? text : `{"records":[${text}]}`;
    await expect(createCaseSystem(fakeClient(body)).search(baseQuery)).rejects.toMatchObject({
      upstream: 'case_system',
      kind: 'bad_response',
    });
  });

  it.each(cases.filter(([name]) => name !== 'records not an array'))(
    'get maps %s to bad_response',
    async (_name, text) => {
      await expect(createCaseSystem(fakeClient(text)).get('CS-10231')).rejects.toMatchObject({
        upstream: 'case_system',
        kind: 'bad_response',
      });
    },
  );

  it('get rejects a missing Comments array', async () => {
    const body = { ...GOOD_CASE, Comments: undefined };
    await expect(
      createCaseSystem(fakeClient(JSON.stringify(body))).get('CS-10231'),
    ).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('a non-JSON body never reaches the error or the logs (S3-8)', () => {
  it('keeps no fragment of the upstream body', async () => {
    const body = 'Acme Corp ARR 480000 jane.doe@acme.example';
    const error = await createCaseSystem(fakeClient(body))
      .get('CS-10231')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    const { captureLogs } = await import('../http/helpers.js');
    const logs = captureLogs();
    logs.logger.error({ err: error }, 'unhandled error');
    expect(logs.text()).not.toMatch(/Acme|480000|jane/);
  });
});
