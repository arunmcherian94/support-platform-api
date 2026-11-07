import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { enqueueEvent } from '../../src/events/enqueue.js';
import {
  DISABLED_GONE,
  DISABLED_UNCONFIGURED,
  upsertSubscription,
} from '../../src/events/subscription.js';
import { deliveryRow, migratedDb, NOW, SECRET, subscriptionRow } from './helpers.js';

const clock = fixedClock(NOW);
const URL_A = 'http://127.0.0.1:9/hooks';
const URL_B = 'http://127.0.0.1:9/other';
const DATA = { caseId: 'CS-10231', accountId: 'ACC-007' };

function addSubscription(
  db: ReturnType<typeof migratedDb>,
  id: string,
  eventTypes: string[],
  active = 1,
): void {
  db.prepare(
    `INSERT INTO webhook_subscriptions (id, url, event_types, secret_ref, active, created_at)
     VALUES (?, ?, ?, 'WEBHOOK_SECRET', ?, ?)`,
  ).run(id, URL_B, JSON.stringify(eventTypes), active, NOW);
}

describe('upsertSubscription', () => {
  it('stores the URL and the secret variable name, never the secret', () => {
    const db = migratedDb();
    expect(upsertSubscription(db, { webhook: { url: URL_A, secret: SECRET } }, clock)).toEqual({
      id: 'sub_default',
      url: URL_A,
    });
    const row = subscriptionRow(db);
    expect(row).toMatchObject({ url: URL_A, active: 1, secret_ref: 'WEBHOOK_SECRET' });
    const dump = JSON.stringify(db.prepare('SELECT * FROM webhook_subscriptions').all());
    expect(dump).not.toContain(SECRET.slice('whsec_'.length));
  });

  it('creates nothing without config, and deactivates the row when the config is removed', () => {
    const db = migratedDb();
    expect(upsertSubscription(db, {}, clock)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM webhook_subscriptions').get()?.['n']).toBe(0);

    upsertSubscription(db, { webhook: { url: URL_A, secret: SECRET } }, clock);
    expect(upsertSubscription(db, {}, clock)).toBeUndefined();
    expect(subscriptionRow(db)).toMatchObject({
      active: 0,
      disabled_reason: DISABLED_UNCONFIGURED,
    });

    // Configured again: active again.
    expect(upsertSubscription(db, { webhook: { url: URL_A, secret: SECRET } }, clock)).toEqual({
      id: 'sub_default',
      url: URL_A,
    });
    expect(subscriptionRow(db)).toMatchObject({ active: 1, disabled_reason: null });
  });

  it('keeps a 410-disabled subscription disabled while the URL is unchanged; a new URL re-enables', () => {
    const db = migratedDb();
    upsertSubscription(db, { webhook: { url: URL_A, secret: SECRET } }, clock);
    db.prepare('UPDATE webhook_subscriptions SET active = 0, disabled_reason = ?').run(
      DISABLED_GONE,
    );

    expect(
      upsertSubscription(db, { webhook: { url: URL_A, secret: SECRET } }, clock),
    ).toBeUndefined();
    expect(subscriptionRow(db)).toMatchObject({ active: 0, disabled_reason: DISABLED_GONE });

    expect(upsertSubscription(db, { webhook: { url: URL_B, secret: SECRET } }, clock)).toEqual({
      id: 'sub_default',
      url: URL_B,
    });
    expect(subscriptionRow(db)).toMatchObject({ url: URL_B, active: 1, disabled_reason: null });
  });
});

describe('enqueueEvent', () => {
  it('inserts one pending row per active subscription to the event type', () => {
    const db = migratedDb();
    upsertSubscription(db, { webhook: { url: URL_A, secret: SECRET } }, clock);
    addSubscription(db, 'sub_second', ['case.updated', 'case.escalated']);
    addSubscription(db, 'sub_other_type', ['case.updated']);
    addSubscription(db, 'sub_inactive', ['case.escalated'], 0);

    const ids = enqueueEvent(db, clock, 'case.escalated', DATA);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const rows = ids.map((id) => deliveryRow(db, id));
    expect(rows.map((row) => row.subscription_id).sort()).toEqual(['sub_default', 'sub_second']);
    for (const row of rows) {
      expect(row.id).toMatch(/^msg_[A-Za-z0-9_-]{22}$/);
      expect(row).toMatchObject({
        status: 'pending',
        attempt: 0,
        next_attempt_at: clock.now().toISOString(),
      });
      expect(JSON.parse(row.payload)).toEqual({
        type: 'case.escalated',
        timestamp: clock.now().toISOString(),
        data: DATA,
      });
    }
    // Serialised once: every subscription gets the identical bytes.
    expect(rows[0]?.payload).toBe(rows[1]?.payload);
  });

  it('inserts nothing when there is no subscription', () => {
    const db = migratedDb();
    upsertSubscription(db, {}, clock);
    expect(enqueueEvent(db, clock, 'case.escalated', DATA)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get()?.['n']).toBe(0);
  });

  it("runs in the caller's transaction: a rollback leaves no delivery", () => {
    const db = migratedDb();
    upsertSubscription(db, { webhook: { url: URL_A, secret: SECRET } }, clock);

    db.exec('BEGIN');
    const [id] = enqueueEvent(db, clock, 'case.escalated', DATA);
    expect(id).toBeDefined();
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get()?.['n']).toBe(0);

    db.exec('BEGIN');
    enqueueEvent(db, clock, 'case.escalated', DATA);
    db.exec('COMMIT');
    expect(db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get()?.['n']).toBe(1);
  });
});
