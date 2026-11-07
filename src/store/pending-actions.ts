import type { DatabaseSync } from 'node:sqlite';

export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';

export interface EscalateArgs {
  reason: string;
  note?: string;
}

export interface PendingAction {
  id: string;
  action: 'escalate';
  caseId: string;
  args: EscalateArgs;
  etag: string;
  proposedBySub: string;
  agent: string;
  status: PendingStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  result: string | null;
}

/** How long a proposal waits for a human (S5 §2.4). */
export const PENDING_TTL_SEC = 15 * 60;

const iso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createPendingAction(
  db: DatabaseSync,
  input: {
    id: string;
    caseId: string;
    args: EscalateArgs;
    etag: string;
    proposedBySub: string;
    agent: string;
    now: Date;
  },
): PendingAction {
  const createdAt = iso(input.now);
  const expiresAt = iso(new Date(input.now.getTime() + PENDING_TTL_SEC * 1000));
  db.prepare(
    `INSERT INTO pending_actions
       (id, action, case_id, args, etag, proposed_by_sub, agent, status, created_at, expires_at)
     VALUES (?, 'escalate', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    input.id,
    input.caseId,
    JSON.stringify(input.args),
    input.etag,
    input.proposedBySub,
    input.agent,
    createdAt,
    expiresAt,
  );
  const created = getPendingAction(db, input.id);
  if (created === undefined) throw new Error('pending action not stored');
  return created;
}

export function getPendingAction(db: DatabaseSync, id: string): PendingAction | undefined {
  const row = db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(id);
  if (row === undefined) return undefined;
  return {
    id: String(row['id']),
    action: 'escalate',
    caseId: String(row['case_id']),
    args: JSON.parse(String(row['args'])) as EscalateArgs,
    etag: String(row['etag']),
    proposedBySub: String(row['proposed_by_sub']),
    agent: String(row['agent']),
    status: String(row['status']) as PendingStatus,
    createdAt: String(row['created_at']),
    expiresAt: String(row['expires_at']),
    decidedBy: row['decided_by'] === null ? null : String(row['decided_by']),
    decidedAt: row['decided_at'] === null ? null : String(row['decided_at']),
    result: row['result'] === null ? null : String(row['result']),
  };
}

/**
 * Moves a pending, unexpired action to `approved` or `rejected` in one
 * conditional UPDATE, so two deciders can't both win. An expired one is marked
 * `expired` instead. Returns what the row became, or why nothing changed.
 */
export function claimDecision(
  db: DatabaseSync,
  id: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  now: Date,
):
  | { ok: true; action: PendingAction }
  | { ok: false; reason: 'not_found' | 'expired' | PendingStatus } {
  const at = iso(now);
  const changed = db
    .prepare(
      `UPDATE pending_actions SET status = ?, decided_by = ?, decided_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .run(decision, decidedBy, at, id, at).changes;
  const action = getPendingAction(db, id);
  if (action === undefined) return { ok: false, reason: 'not_found' };
  if (changed === 1) return { ok: true, action };
  if (action.status === 'pending') {
    // Still pending, so it failed the expiry condition.
    db.prepare(
      `UPDATE pending_actions SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(at, id);
    return { ok: false, reason: 'expired' };
  }
  return { ok: false, reason: action.status };
}

/** Records how an approved action ended: `ok`, or `failed` with the API's problem type. */
export function recordResult(db: DatabaseSync, id: string, result: string): void {
  db.prepare(
    `UPDATE pending_actions SET status = CASE WHEN ? = 'ok' THEN 'approved' ELSE 'failed' END,
            result = ?
      WHERE id = ? AND status = 'approved'`,
  ).run(result, result, id);
}

/**
 * The same user's live proposal for the same case, agent and arguments, so a
 * model's repeat returns it instead of queueing a second one. Another user's
 * proposal, or different arguments, never match.
 */
export function findOpenPending(
  db: DatabaseSync,
  match: { caseId: string; proposedBySub: string; agent: string; args: EscalateArgs },
  now: Date,
): PendingAction | undefined {
  const row = db
    .prepare(
      `SELECT id FROM pending_actions
        WHERE case_id = ? AND proposed_by_sub = ? AND agent = ? AND args = ?
          AND status = 'pending' AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(match.caseId, match.proposedBySub, match.agent, JSON.stringify(match.args), iso(now));
  return row === undefined ? undefined : getPendingAction(db, String(row['id']));
}
