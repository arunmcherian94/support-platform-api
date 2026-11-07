/**
 * The human's side of the approval gate (S5 §2.4):
 *   make approve ID=pa_…            approve and run the escalation
 *   make approve ID=pa_… REJECT=1   reject it
 * It uses the human's own token, never the agent's.
 */
import { systemClock } from '../src/clock.js';
import { openDatabase } from '../src/store/db.js';
import { migrate } from '../src/store/migrate.js';
import { getPendingAction } from '../src/store/pending-actions.js';
import { decidePendingAction, devApproverToken } from '../mcp/server/approvals.js';

async function main(): Promise<number> {
  const id = process.argv[2] ?? process.env.ID ?? '';
  const reject = process.env.REJECT === '1' || process.argv.includes('--reject');
  if (id === '') {
    process.stderr.write('usage: make approve ID=<pendingActionId> [REJECT=1]\n');
    return 2;
  }
  const apiUrl = (process.env.API_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const db = openDatabase(process.env.DB_PATH ?? 'data/platform.db');
  migrate(db);

  const action = getPendingAction(db, id);
  if (action === undefined) {
    process.stderr.write(`No pending action ${id}.\n`);
    return 1;
  }
  process.stdout.write(
    [
      `Pending action ${action.id} (${action.status})`,
      // JSON-quoted: the note is model-written text and must not forge lines on this screen.
      `  escalate ${action.caseId}: reason=${action.args.reason}${action.args.note === undefined ? '' : `, note=${JSON.stringify(action.args.note)}`}`,
      `  proposed by agent ${action.agent} for ${action.proposedBySub} at ${action.createdAt}`,
      `  expires ${action.expiresAt}; case version ${action.etag}`,
      '',
    ].join('\n'),
  );

  const approver = await devApproverToken(
    process.env.TOKEN_URL ?? `${apiUrl}/dev/oauth/token`,
    process.env.APPROVER_CLIENT_ID ?? 'support-console',
    // The dev-only, deliberately public secret from config/dev-clients.json.
    process.env.APPROVER_CLIENT_SECRET ?? 'dev-only-support-console-secret',
  );
  const result = await decidePendingAction(
    // Real time, not the NOW anchor: this process starts fresh, so an anchored
    // clock would make every proposal look unexpired.
    { db, clock: systemClock({}), apiUrl, approver },
    id,
    reject ? 'reject' : 'approve',
  );
  const detail = result.problem === undefined ? '' : ` (${result.problem})`;
  process.stdout.write(`${result.outcome}${detail} by ${approver.sub}\n`);
  if (!result.audited) process.stderr.write('warning: the audit row was not written\n');
  return result.outcome === 'escalated' || result.outcome === 'rejected' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
