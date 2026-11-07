import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock.js';
import type { Logger } from '../observability/logger.js';
import { decodeSecret, sign } from './signing.js';
import { DISABLED_GONE } from './subscription.js';

/** Delay before each retry (S4 §2.4): 5 s, 1 min, 5 min, 30 min, 2 h, 6 h, 14 h. */
export const RETRY_SCHEDULE_MS = [
  5_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  14 * 3_600_000,
] as const;
/** The first attempt plus one per scheduled retry. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;
export const JITTER = 0.2;
export const DELIVERY_TIMEOUT_MS = 15_000;
export const BATCH_SIZE = 20;

export interface DispatcherOptions {
  db: DatabaseSync;
  clock: Clock;
  logger: Logger;
  /** The Standard Webhooks secret (`whsec_…`) of the one configured subscription. */
  secret: string;
  intervalMs: number;
  fetch?: typeof fetch;
  /** Returns [0, 1); injected so tests can pin the jitter. */
  random?: () => number;
  /** Per-attempt timeout; 15 s by contract, shorter only in tests. */
  timeoutMs?: number;
}

export interface Dispatcher {
  start(): void;
  /** Stops polling and waits for the in-flight tick (bounded by the attempt timeout). */
  stop(): Promise<void>;
  /** Runs one poll; resolves when its attempts finish. Concurrent calls share one run. */
  tick(): Promise<void>;
}

interface DueDelivery {
  id: string;
  subscriptionId: string;
  url: string;
  payload: string;
  attempt: number;
}

type Outcome =
  | { kind: 'delivered'; status: number }
  | { kind: 'gone'; status: number }
  | { kind: 'failed'; status: number | null; error: string };

/**
 * Polls `webhook_deliveries` and sends due deliveries (S4 §2.4). One process only:
 * with several instances the poll would claim rows with `FOR UPDATE SKIP LOCKED`.
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { db, clock, logger, intervalMs } = options;
  const key = decodeSecret(options.secret);
  const doFetch = options.fetch ?? globalThis.fetch;
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  // `next_attempt_at` is compared as text so the (status, next_attempt_at) index serves
  // the poll. That is only correct while every writer uses `Date#toISOString()`
  // (`…T12:00:00.000Z`); `…T12:00:00Z` would sort after it and look not yet due.
  const selectDue = db.prepare(
    `SELECT d.id, d.subscription_id, s.url, d.payload, d.attempt
     FROM webhook_deliveries d
     JOIN webhook_subscriptions s ON s.id = d.subscription_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND s.active = 1
     ORDER BY d.next_attempt_at, d.created_at, d.id
     LIMIT ${String(BATCH_SIZE)}`,
  );

  async function send(delivery: DueDelivery): Promise<Outcome> {
    const timestamp = Math.floor(clock.now().getTime() / 1000);
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': delivery.id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': sign(key, delivery.id, timestamp, delivery.payload),
        },
        body: delivery.payload,
        // A redirect is a failure: following it would send signed events to a URL
        // nobody configured.
        redirect: 'manual',
        signal,
      });
    } catch {
      // The error may carry the URL or socket details; only its class is kept.
      return { kind: 'failed', status: null, error: signal.aborted ? 'timeout' : 'network' };
    }
    // The receiver's body is never read into state or logs.
    await response.body?.cancel().catch(() => undefined);
    const { status } = response;
    if (status >= 200 && status < 300) return { kind: 'delivered', status };
    if (status === 410) return { kind: 'gone', status };
    return { kind: 'failed', status, error: `http_${String(status)}` };
  }

  function record(delivery: DueDelivery, outcome: Outcome): void {
    const now = clock.now();
    const attempt = delivery.attempt + 1;
    const log = {
      deliveryId: delivery.id,
      subscriptionId: delivery.subscriptionId,
      attempt,
      httpStatus: outcome.status ?? undefined,
    };

    if (outcome.kind === 'delivered') {
      db.prepare(
        `UPDATE webhook_deliveries
         SET status = 'delivered', attempt = ?, last_status = ?, last_error = NULL,
             next_attempt_at = NULL, delivered_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(attempt, outcome.status, now.toISOString(), delivery.id);
      logger.info({ ...log, outcome: 'delivered' }, 'webhook delivered');
      return;
    }

    if (outcome.kind === 'gone') {
      db.exec('BEGIN');
      try {
        db.prepare(
          `UPDATE webhook_subscriptions SET active = 0, disabled_reason = ? WHERE id = ?`,
        ).run(DISABLED_GONE, delivery.subscriptionId);
        db.prepare(
          `UPDATE webhook_deliveries
           SET status = 'dead', attempt = ?, last_status = ?, last_error = 'http_410',
               next_attempt_at = NULL
           WHERE id = ? AND status = 'pending'`,
        ).run(attempt, outcome.status, delivery.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      logger.warn(
        { ...log, outcome: 'gone' },
        'webhook receiver returned 410; subscription disabled',
      );
      return;
    }

    const delay = RETRY_SCHEDULE_MS[attempt - 1];
    if (delay === undefined) {
      db.prepare(
        `UPDATE webhook_deliveries
         SET status = 'dead', attempt = ?, last_status = ?, last_error = ?, next_attempt_at = NULL
         WHERE id = ? AND status = 'pending'`,
      ).run(attempt, outcome.status, outcome.error, delivery.id);
      logger.warn({ ...log, outcome: 'dead', error: outcome.error }, 'webhook delivery dead');
      return;
    }
    const jittered = Math.round(delay * (1 + (random() * 2 - 1) * JITTER));
    const next = new Date(now.getTime() + jittered).toISOString();
    db.prepare(
      `UPDATE webhook_deliveries
       SET attempt = ?, last_status = ?, last_error = ?, next_attempt_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(attempt, outcome.status, outcome.error, next, delivery.id);
    logger.warn(
      { ...log, outcome: 'retry', error: outcome.error, nextAttemptAt: next },
      'webhook delivery failed; retry scheduled',
    );
  }

  async function attemptDelivery(delivery: DueDelivery): Promise<void> {
    try {
      record(delivery, await send(delivery));
    } catch (error) {
      // A store error: the row stays as it was and is picked up on a later tick.
      logger.error(
        { deliveryId: delivery.id, subscriptionId: delivery.subscriptionId, err: error },
        'webhook delivery bookkeeping failed',
      );
    }
  }

  async function run(): Promise<void> {
    const due: DueDelivery[] = selectDue.all(clock.now().toISOString()).map((row) => ({
      id: String(row['id']),
      subscriptionId: String(row['subscription_id']),
      url: String(row['url']),
      payload: String(row['payload']),
      attempt: Number(row['attempt']),
    }));
    // Attempts run side by side, so one slow receiver doesn't hold up the batch.
    await Promise.all(due.map(attemptDelivery));
  }

  function tick(): Promise<void> {
    running ??= run().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        tick().catch((error: unknown) => {
          logger.error({ err: error }, 'webhook dispatcher tick failed');
        });
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (running !== undefined) await running.catch(() => undefined);
    },
    tick,
  };
}
