import type { DatabaseSync } from 'node:sqlite';

/** One `audit_log` row (append-only; triggers refuse updates and deletes). */
export interface AuditRow {
  at: Date;
  correlationId: string;
  sub: string;
  agent?: string;
  clientId: string;
  /** e.g. `case.escalate`, `mcp.search_cases`. */
  action: string;
  resourceType: string;
  resourceId: string;
  /** Arguments with free text removed. Never raw upstream or user text. */
  args?: Record<string, unknown>;
  /** `ok`, `pending`, or the problem type of a refusal. */
  outcome: string;
  latencyMs?: number;
}

export function recordAudit(db: DatabaseSync, row: AuditRow): void {
  db.prepare(
    `INSERT INTO audit_log
       (at, correlation_id, actor_sub, actor_agent, actor_client, action,
        resource_type, resource_id, args_redacted, outcome, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.at.toISOString(),
    row.correlationId,
    row.sub,
    row.agent ?? null,
    row.clientId,
    row.action,
    row.resourceType,
    row.resourceId,
    row.args === undefined ? null : JSON.stringify(row.args),
    row.outcome,
    row.latencyMs ?? null,
  );
}
