/**
 * `POST /v1/cases/{caseId}/escalate` through the real server against the mock
 * case system (S5-1). Responses are validated against the contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import type { RunningServer } from '../../src/server.js';
import { SECRET } from '../events/helpers.js';
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

async function start(): Promise<void> {
  mocks = await startRecordingMocks();
  ({ running, auth } = await startServerWithAuth(captureLogs().logger, {
    env: {
      MOCKS_URL: mocks.url,
      // A subscription so the event is queued; the dispatcher never runs in the test.
      WEBHOOK_URL: 'http://127.0.0.1:9/hooks',
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_DISPATCH_INTERVAL_MS: '60000',
      PUBLIC_BASE_URL: 'https://api.example',
    },
    clock: fixedClock(FIXTURE_NOW),
  }));
  await waitForReady(running.url);
}

const url = (caseId: string): string => `${running?.url ?? ''}/v1/cases/${caseId}`;

async function etagOf(caseId: string): Promise<string> {
  const res = await fetch(url(caseId), { headers: auth });
  return res.headers.get('etag') ?? '';
}

function escalate(
  caseId: string,
  ifMatch: string | null,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${url(caseId)}/escalate`, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': 'application/json',
      ...(ifMatch === null ? {} : { 'if-match': ifMatch }),
      ...options.headers,
    },
    body: JSON.stringify(options.body ?? { reason: 'sla_risk', note: 'Open 13 days' }),
  });
}

interface AuditRow {
  actor_sub: string;
  actor_agent: string | null;
  actor_client: string;
  action: string;
  resource_id: string;
  args_redacted: string | null;
  outcome: string;
}
const audits = (): AuditRow[] =>
  (running?.db.prepare('SELECT * FROM audit_log ORDER BY id').all() ?? []) as unknown as AuditRow[];
const deliveries = (): { payload: string }[] =>
  (running?.db.prepare('SELECT payload FROM webhook_deliveries').all() ?? []) as unknown as {
    payload: string;
  }[];

const problemType = async (res: Response): Promise<string> =>
  ((await res.json()) as { type: string }).type.split('/').pop() ?? '';

describe('escalate (S5-1)', () => {
  it('escalates a P1 with 200 and a new ETag; one audit row and one delivery', async () => {
    await start();
    const before = await etagOf('CS-10231');
    const res = await escalate('CS-10231', before);
    expect(res.status).toBe(200);
    const after = res.headers.get('etag');
    expect(after).not.toBe(before);
    const body = (await res.json()) as { escalation: unknown };
    expect(body.escalation).toEqual({
      reason: 'sla_risk',
      note: 'Open 13 days',
      escalatedAt: FIXTURE_NOW,
      escalatedBy: { user: 'jdoe' },
    });
    // The case system really holds it, at the new version.
    expect(await etagOf('CS-10231')).toBe(after);

    expect(audits()).toEqual([
      expect.objectContaining({
        actor_sub: 'jdoe',
        actor_agent: null,
        actor_client: 'support-console',
        action: 'case.escalate',
        resource_id: 'CS-10231',
        args_redacted: JSON.stringify({ reason: 'sla_risk', hasNote: true }),
        outcome: 'ok',
      }),
    ]);
    const [delivery, ...rest] = deliveries();
    expect(rest).toHaveLength(0);
    const event = JSON.parse(delivery?.payload ?? '{}') as {
      type: string;
      data: Record<string, unknown>;
    };
    expect(event.type).toBe('case.escalated');
    expect(event.data).toEqual({
      caseId: 'CS-10231',
      accountId: 'ACC-007',
      priority: 'P1',
      escalation: { reason: 'sla_risk', escalatedAt: FIXTURE_NOW, escalatedBy: { user: 'jdoe' } },
      caseEtag: after,
      caseUrl: 'https://api.example/v1/cases/CS-10231',
    });
    // The free-text note never leaves in the event.
    expect(delivery?.payload).not.toContain('Open 13 days');
  });

  it('records the agent from a delegated token', async () => {
    await start();
    const token = await running?.issuer?.mint({
      sub: 'jdoe',
      clientId: 'support-copilot',
      scopes: ['cases:read', 'cases:escalate'],
      act: { sub: 'support-copilot' },
    });
    const headers = { authorization: `Bearer ${token ?? ''}` };
    const res = await escalate('CS-10231', await etagOf('CS-10231'), { headers });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { escalation: { escalatedBy: unknown } }).escalation.escalatedBy,
    ).toEqual({
      user: 'jdoe',
      agent: 'support-copilot',
    });
    expect(audits()[0]).toMatchObject({ actor_sub: 'jdoe', actor_agent: 'support-copilot' });
  });

  it('428 without If-Match, and nothing is written', async () => {
    await start();
    const res = await escalate('CS-10231', null);
    expect(res.status).toBe(428);
    expect(await problemType(res)).toBe('precondition-required');
    expect(deliveries()).toHaveLength(0);
  });

  it('412 with a stale ETag (the case changed), audited as refused', async () => {
    await start();
    const before = await etagOf('CS-10231');
    // A comment bumps the case version.
    await fetch(`${url('CS-10231')}/comments`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': '"k"' },
      body: JSON.stringify({ body: 'update' }),
    });
    const res = await escalate('CS-10231', before);
    expect(res.status).toBe(412);
    expect(await problemType(res)).toBe('precondition-failed');
    expect(audits().map((a) => a.outcome)).toEqual(['precondition-failed']);
    expect(deliveries()).toHaveLength(0);
  });

  it('409 when closed, and 409 with the existing escalation when repeated', async () => {
    await start();
    const closed = await escalate('CS-10235', await etagOf('CS-10235'));
    expect(closed.status).toBe(409);
    expect(await problemType(closed)).toBe('invalid-state');

    expect((await escalate('CS-10231', await etagOf('CS-10231'))).status).toBe(200);
    const again = await escalate('CS-10231', await etagOf('CS-10231'));
    expect(again.status).toBe(409);
    const problem = (await again.json()) as { escalation?: { escalatedBy: { user: string } } };
    expect(problem.escalation?.escalatedBy.user).toBe('jdoe');
    expect(deliveries()).toHaveLength(1);
  });

  it('422 for a P3 on a gold account; 503 for a P3 when entitlement data is stale', async () => {
    await start();
    // No fixture case is P3 (the fixtures are fixed ground truth), so the read is
    // overridden to report CS-10238 (ACC-021, gold) as P3.
    const cases = running?.upstreams.cases;
    if (cases === undefined) throw new Error('no upstreams');
    const realGet = cases.get.bind(cases);
    cases.get = async (id) => ({ ...(await realGet(id)), priority: 'P3' });
    const gold = await escalate('CS-10238', await etagOf('CS-10238'));
    expect(gold.status).toBe(422);
    expect(await problemType(gold)).toBe('escalation-not-allowed');

    const entitlement = running?.upstreams.entitlement;
    if (entitlement === undefined) throw new Error('no upstreams');
    entitlement.current = () => ({ usable: false, reason: 'too_old' });
    const stale = await escalate('CS-10238', await etagOf('CS-10238'));
    expect(stale.status).toBe(503);
    expect(await problemType(stale)).toBe('entitlement-stale');
    expect(deliveries()).toHaveLength(0);
  });

  it('403 for ipaas-flow, which has no cases:escalate', async () => {
    await start();
    const token = await running?.issuer?.mint({
      sub: 'svc-flow',
      clientId: 'ipaas-flow',
      scopes: ['cases:read', 'cases:comment'],
    });
    const res = await escalate('CS-10231', await etagOf('CS-10231'), {
      headers: { authorization: `Bearer ${token ?? ''}` },
    });
    expect(res.status).toBe(403);
    expect(await problemType(res)).toBe('insufficient-scope');
  });

  it('400 when reason is other without a note', async () => {
    await start();
    const res = await escalate('CS-10231', await etagOf('CS-10231'), { body: { reason: 'other' } });
    expect(res.status).toBe(400);
  });
});
