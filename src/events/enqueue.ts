import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock.js';

/** `msg_` + 128 random bits, base64url: the `webhook-id`, the same on every retry. */
function newDeliveryId(): string {
  return `msg_${randomBytes(16).toString('base64url')}`;
}

/**
 * Enqueues an event for every active subscription to `type` (S4 §2.3).
 *
 * The Standard Webhooks envelope `{ type, timestamp, data }` is serialised once here;
 * the stored `payload` is the exact bytes later signed and sent, never re-serialised.
 *
 * This opens no transaction of its own: it runs inside the caller's, so the event is
 * written atomically with the change it announces (escalate wraps it with its audit
 * record in `BEGIN` … `COMMIT`). A rollback by the caller leaves no delivery behind.
 *
 * Returns the delivery IDs created (empty when nothing subscribes to `type`).
 */
export function enqueueEvent(
  db: DatabaseSync,
  clock: Clock,
  type: string,
  data: unknown,
): string[] {
  const now = clock.now().toISOString();
  const payload = JSON.stringify({ type, timestamp: now, data });

  const subscriptions = db
    .prepare(
      `SELECT id FROM webhook_subscriptions
       WHERE active = 1 AND EXISTS (SELECT 1 FROM json_each(event_types) WHERE value = ?)
       ORDER BY id`,
    )
    .all(type);

  const insert = db.prepare(
    `INSERT INTO webhook_deliveries
       (id, subscription_id, event_type, payload, attempt, status, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 0, 'pending', ?, ?)`,
  );
  const ids: string[] = [];
  for (const subscription of subscriptions) {
    const id = newDeliveryId();
    insert.run(id, String(subscription['id']), type, payload, now, now);
    ids.push(id);
  }
  return ids;
}
