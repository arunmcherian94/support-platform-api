import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';

export const DEFAULT_SUBSCRIPTION_ID = 'sub_default';
/** The environment variable holding the secret; the table stores this name, never the secret. */
export const SECRET_REF = 'WEBHOOK_SECRET';
export const DEFAULT_EVENT_TYPES = ['case.escalated'];

/** Why a subscription is inactive. */
export const DISABLED_GONE = 'receiver_gone_410';
export const DISABLED_UNCONFIGURED = 'not_configured';

export interface ActiveSubscription {
  id: string;
  url: string;
}

/**
 * Makes the one environment-defined subscription (S4 §2.2) match the config at start-up.
 *
 * - `config.webhook` set: the `sub_default` row gets the URL, event types and the
 *   secret's variable name. It is (re)activated, except when the receiver disabled it
 *   with a 410 and the URL is unchanged: restarting must not override the receiver's
 *   "stop sending". A new URL, or a row deactivated only because the config was unset,
 *   is activated.
 * - `config.webhook` unset: the default row, if any, is deactivated, so pending
 *   deliveries wait instead of going to a URL nobody configured any more.
 *
 * Returns the active subscription, or undefined when there is none.
 */
export function upsertSubscription(
  db: DatabaseSync,
  config: Pick<Config, 'webhook'>,
  clock: Clock,
): ActiveSubscription | undefined {
  if (config.webhook === undefined) {
    db.prepare(
      `UPDATE webhook_subscriptions SET active = 0, disabled_reason = ?
       WHERE id = ? AND active = 1`,
    ).run(DISABLED_UNCONFIGURED, DEFAULT_SUBSCRIPTION_ID);
    return undefined;
  }

  const { url } = config.webhook;
  db.prepare(
    `INSERT INTO webhook_subscriptions (id, url, event_types, secret_ref, active, disabled_reason, created_at)
     VALUES (?, ?, ?, ?, 1, NULL, ?)
     ON CONFLICT (id) DO UPDATE SET
       active = CASE
         WHEN webhook_subscriptions.disabled_reason = ? AND webhook_subscriptions.url = excluded.url
           THEN webhook_subscriptions.active
         ELSE 1 END,
       disabled_reason = CASE
         WHEN webhook_subscriptions.disabled_reason = ? AND webhook_subscriptions.url = excluded.url
           THEN webhook_subscriptions.disabled_reason
         ELSE NULL END,
       url = excluded.url,
       event_types = excluded.event_types,
       secret_ref = excluded.secret_ref`,
  ).run(
    DEFAULT_SUBSCRIPTION_ID,
    url,
    JSON.stringify(DEFAULT_EVENT_TYPES),
    SECRET_REF,
    clock.now().toISOString(),
    DISABLED_GONE,
    DISABLED_GONE,
  );

  const row = db
    .prepare('SELECT id, url FROM webhook_subscriptions WHERE id = ? AND active = 1')
    .get(DEFAULT_SUBSCRIPTION_ID);
  return row === undefined ? undefined : { id: String(row['id']), url: String(row['url']) };
}
