/**
 * Deciding a pending escalation (S5 §2.4). This runs outside the model's
 * reach: the approve command and the demo's y/n prompt call it, with the
 * human's own token. No MCP tool calls it.
 */
import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../../src/clock.js';
import { recordAudit } from '../../src/store/audit.js';
import {
  claimDecision,
  getPendingAction,
  recordResult,
  type PendingAction,
} from '../../src/store/pending-actions.js';

export interface Approver {
  /** The human's own access token (not the agent's delegated one). */
  token: string;
  sub: string;
  clientId: string;
}

export interface DecisionDeps {
  db: DatabaseSync;
  clock: Clock;
  apiUrl: string;
  approver: Approver;
}

export type DecisionOutcome =
  | 'escalated'
  | 'rejected'
  | 'not_found'
  | 'expired'
  | 'already_decided'
  /** Approved, but the API refused it; `problem` says why (412: the case changed). */
  | 'failed';

export interface DecisionResult {
  outcome: DecisionOutcome;
  action?: PendingAction;
  problem?: string;
  status?: number;
  /** False if the decision happened but its audit row could not be written. */
  audited: boolean;
}

export async function decidePendingAction(
  deps: DecisionDeps,
  id: string,
  decision: 'approve' | 'reject',
): Promise<DecisionResult> {
  const started = deps.clock.now().getTime();
  const claimed = claimDecision(
    deps.db,
    id,
    decision === 'approve' ? 'approved' : 'rejected',
    deps.approver.sub,
    deps.clock.now(),
  );

  let result: DecisionResult;
  let correlationId: string = randomUUID();
  if (!claimed.ok) {
    const outcome =
      claimed.reason === 'not_found' || claimed.reason === 'expired'
        ? claimed.reason
        : 'already_decided';
    const action = getPendingAction(deps.db, id);
    result = { outcome, audited: false, ...(action === undefined ? {} : { action }) };
  } else if (decision === 'reject') {
    result = { outcome: 'rejected', action: claimed.action, audited: false };
  } else {
    const { action } = claimed;
    let res: Response;
    try {
      res = await fetch(`${deps.apiUrl}/v1/cases/${encodeURIComponent(action.caseId)}/escalate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.approver.token}`,
          'content-type': 'application/json',
          'if-match': action.etag,
          'x-request-id': correlationId,
        },
        body: JSON.stringify(action.args),
      });
    } catch {
      // The API couldn't be reached: mark the action failed so it's visible and
      // audited, never left `approved` with no result.
      res = Response.json({ type: 'upstream-unreachable' }, { status: 503 });
    }
    correlationId = res.headers.get('x-request-id') ?? correlationId;
    if (res.ok) {
      recordResult(deps.db, id, 'ok');
      result = { outcome: 'escalated', action, status: res.status, audited: false };
    } else {
      const body = (await res.json().catch(() => ({}))) as { type?: unknown };
      const problem =
        typeof body.type === 'string' ? (body.type.split('/').pop() ?? 'unknown') : 'unknown';
      recordResult(deps.db, id, problem);
      result = { outcome: 'failed', action, problem, status: res.status, audited: false };
    }
    const updated = getPendingAction(deps.db, id);
    if (updated !== undefined) result.action = updated;
  }

  try {
    recordAudit(deps.db, {
      at: deps.clock.now(),
      correlationId,
      sub: deps.approver.sub,
      clientId: deps.approver.clientId,
      action: `approval.${decision}`,
      resourceType: 'pending_action',
      resourceId: id,
      args: {
        ...(result.action === undefined
          ? {}
          : {
              caseId: result.action.caseId,
              proposedBy: result.action.proposedBySub,
              agent: result.action.agent,
            }),
        ...(result.problem === undefined ? {} : { problem: result.problem }),
      },
      outcome: result.outcome,
      latencyMs: deps.clock.now().getTime() - started,
    });
    result.audited = true;
  } catch {
    // The decision already happened; the caller reports the missing audit row.
  }
  return result;
}

/**
 * Dev only: the human's own token from the dev issuer (client_credentials for
 * the support console, whose fixed user is the approver). A real deployment
 * would take the approver's token from their own sign-in.
 */
export async function devApproverToken(
  tokenUrl: string,
  clientId: string,
  secret: string,
): Promise<Approver> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || body.access_token === undefined) {
    throw new Error(`approver token request failed: ${body.error ?? String(res.status)}`);
  }
  const claims = decodeJwt(body.access_token);
  return { token: body.access_token, sub: String(claims.sub), clientId: String(claims.client_id) };
}
