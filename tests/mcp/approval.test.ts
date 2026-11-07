/**
 * The human approval gate (S5-5, S5-10): only `decidePendingAction`, run with
 * the human's own token, ever calls the escalate endpoint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { decidePendingAction, type Approver } from '../../mcp/server/approvals.js';
import { fixedClock, type Clock } from '../../src/clock.js';
import { getPendingAction } from '../../src/store/pending-actions.js';
import { FIXTURE_NOW } from '../http/helpers.js';
import { ALL_USER_SCOPES, auditRows, startHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function approver(harness: Harness): Promise<Approver> {
  return {
    token: await harness.userToken('jdoe', ALL_USER_SCOPES),
    sub: 'jdoe',
    clientId: 'support-console',
  };
}

async function propose(harness: Harness, caseId = 'CS-10231'): Promise<string> {
  const res = await harness.call('escalate_case', { caseId, reason: 'sla_risk' });
  return String(res.data.pendingActionId);
}

async function decide(harness: Harness, id: string, decision: 'approve' | 'reject', clock?: Clock) {
  return decidePendingAction(
    {
      db: harness.db,
      clock: clock ?? harness.clock,
      apiUrl: harness.running.url,
      approver: await approver(harness),
    },
    id,
    decision,
  );
}

describe('approval (S5-5)', () => {
  it('escalates only when a human approves, with the stored version', async () => {
    h = await startHarness();
    const id = await propose(h);
    const result = await decide(h, id, 'approve');
    expect(result).toMatchObject({ outcome: 'escalated', status: 200, audited: true });
    expect(getPendingAction(h.db, id)).toMatchObject({
      status: 'approved',
      result: 'ok',
      decidedBy: 'jdoe',
    });
    const read = await h.call('get_case', { caseId: 'CS-10231' });
    expect(read.data.escalation).toMatchObject({
      reason: 'sla_risk',
      escalatedBy: { user: 'jdoe' },
    });
  });

  it('a rejected action never runs', async () => {
    h = await startHarness();
    const id = await propose(h);
    expect((await decide(h, id, 'reject')).outcome).toBe('rejected');
    expect((await decide(h, id, 'approve')).outcome).toBe('already_decided');
    expect((await h.call('get_case', { caseId: 'CS-10231' })).data.escalation).toBeNull();
  });

  it('an expired action never runs', async () => {
    h = await startHarness();
    const id = await propose(h);
    const later = fixedClock(new Date(Date.parse(FIXTURE_NOW) + 16 * 60_000));
    expect((await decide(h, id, 'approve', later)).outcome).toBe('expired');
    expect(getPendingAction(h.db, id)?.status).toBe('expired');
    expect((await h.call('get_case', { caseId: 'CS-10231' })).data.escalation).toBeNull();
  });

  it('a case changed after the proposal gets 412 and the action is marked failed', async () => {
    h = await startHarness();
    const id = await propose(h);
    await h.call('add_case_comment', { caseId: 'CS-10231', body: 'New information arrived.' });
    const result = await decide(h, id, 'approve');
    expect(result).toMatchObject({
      outcome: 'failed',
      problem: 'precondition-failed',
      status: 412,
    });
    expect(getPendingAction(h.db, id)).toMatchObject({
      status: 'failed',
      result: 'precondition-failed',
    });
    expect((await h.call('get_case', { caseId: 'CS-10231' })).data.escalation).toBeNull();
  });

  it('cannot be approved twice', async () => {
    h = await startHarness();
    const id = await propose(h);
    const [a, b] = await Promise.all([decide(h, id, 'approve'), decide(h, id, 'approve')]);
    expect([a.outcome, b.outcome].sort()).toEqual(['already_decided', 'escalated']);
  });

  it('audits the decision with the approver and the proposing agent', async () => {
    h = await startHarness();
    const id = await propose(h);
    await decide(h, id, 'approve');
    const row = auditRows(h.db).find((r) => r.action === 'approval.approve');
    expect(row).toMatchObject({
      actor_sub: 'jdoe',
      actor_agent: null,
      resource_id: id,
      outcome: 'escalated',
    });
    expect(JSON.parse(row?.args_redacted ?? '{}')).toMatchObject({
      caseId: 'CS-10231',
      proposedBy: 'jdoe',
      agent: 'support-copilot',
    });
  });
});

describe('approval review fixes', () => {
  it('an unreachable API marks the action failed and audits it, never leaves it stuck', async () => {
    h = await startHarness();
    const id = await propose(h);
    const result = await decidePendingAction(
      { db: h.db, clock: h.clock, apiUrl: 'http://127.0.0.1:9', approver: await approver(h) },
      id,
      'approve',
    );
    expect(result).toMatchObject({
      outcome: 'failed',
      problem: 'upstream-unreachable',
      audited: true,
    });
    expect(getPendingAction(h.db, id)).toMatchObject({
      status: 'failed',
      result: 'upstream-unreachable',
    });
  });

  it("another user's open proposal is never returned", async () => {
    h = await startHarness();
    const id = await propose(h);
    const action = getPendingAction(h.db, id);
    if (action === undefined) throw new Error('missing');
    const { findOpenPending } = await import('../../src/store/pending-actions.js');
    const match = { caseId: action.caseId, agent: action.agent, args: action.args };
    expect(findOpenPending(h.db, { ...match, proposedBySub: 'jdoe' }, h.clock.now())?.id).toBe(id);
    expect(
      findOpenPending(h.db, { ...match, proposedBySub: 'someone-else' }, h.clock.now()),
    ).toBeUndefined();
  });
});
