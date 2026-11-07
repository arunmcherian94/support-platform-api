import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, type TestClock } from '../../src/clock.js';
import {
  createDispatcher,
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_MS,
  type DispatcherOptions,
} from '../../src/events/dispatcher.js';
import { enqueueEvent } from '../../src/events/enqueue.js';
import { DISABLED_GONE, upsertSubscription } from '../../src/events/subscription.js';
import { captureLogs } from '../http/helpers.js';
import {
  deliveryRow,
  header,
  KEY,
  migratedDb,
  NOW,
  SECRET,
  startReceiver,
  subscriptionRow,
  type TestReceiver,
} from './helpers.js';

const DATA = { caseId: 'CS-10231', accountId: 'ACC-007', priority: 'P1' };
const RESPONSE_SECRET = 'sk_live_RECEIVER_BODY_MUST_NOT_LEAK_4242';

let clock: TestClock;
let db: DatabaseSync;
let receiver: TestReceiver;
let logs: ReturnType<typeof captureLogs>;

function dispatcher(overrides: Partial<DispatcherOptions> = {}) {
  return createDispatcher({
    db,
    clock,
    logger: logs.logger,
    secret: SECRET,
    intervalMs: 1000,
    random: () => 0.5, // no jitter unless a test pins otherwise
    ...overrides,
  });
}

function enqueue(): string {
  const [id] = enqueueEvent(db, clock, 'case.escalated', DATA);
  if (id === undefined) throw new Error('nothing enqueued');
  return id;
}

function msUntilNext(id: string): number {
  const next = deliveryRow(db, id).next_attempt_at;
  if (next === null) throw new Error('no next attempt');
  return Date.parse(next) - clock.now().getTime();
}

beforeEach(async () => {
  clock = fixedClock(NOW);
  db = migratedDb();
  receiver = await startReceiver(clock);
  logs = captureLogs();
  upsertSubscription(db, { webhook: { url: receiver.url, secret: SECRET } }, clock);
});

afterEach(async () => {
  await receiver.close();
  db.close();
});

describe('dispatcher delivery (S4-6, S4-7)', () => {
  it('delivers the stored bytes with the three headers, and the receiver verifies them', async () => {
    const id = enqueue();
    await dispatcher().tick();

    expect(receiver.received).toHaveLength(1);
    const [got] = receiver.received;
    if (got === undefined) throw new Error('nothing received');
    expect(header(got.headers, 'webhook-id')).toBe(id);
    expect(header(got.headers, 'webhook-timestamp')).toBe(String(clock.now().getTime() / 1000));
    expect(header(got.headers, 'webhook-signature')).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(header(got.headers, 'content-type')).toBe('application/json');
    expect(got.rawBody.toString('utf8')).toBe(deliveryRow(db, id).payload);
    expect(got.verdict).toEqual({ ok: true });

    expect(deliveryRow(db, id)).toMatchObject({
      status: 'delivered',
      attempt: 1,
      last_status: 200,
      last_error: null,
      delivered_at: clock.now().toISOString(),
      next_attempt_at: null,
    });
  });

  it('signs each attempt with a fresh timestamp over the same bytes and the same webhook-id', async () => {
    const id = enqueue();
    receiver.respond(500);
    const d = dispatcher();
    await d.tick();
    clock.advance(RETRY_SCHEDULE_MS[0]);
    receiver.respond(200);
    await d.tick();

    const [first, second] = receiver.received;
    if (first === undefined || second === undefined) throw new Error('expected two attempts');
    expect(header(first.headers, 'webhook-id')).toBe(id);
    expect(header(second.headers, 'webhook-id')).toBe(id);
    expect(Number(header(second.headers, 'webhook-timestamp'))).toBe(
      Number(header(first.headers, 'webhook-timestamp')) + 5,
    );
    expect(header(second.headers, 'webhook-signature')).not.toBe(
      header(first.headers, 'webhook-signature'),
    );
    expect(second.rawBody.equals(first.rawBody)).toBe(true);
    expect(second.verdict).toEqual({ ok: true });
  });

  it('a receiver using another secret rejects the delivery', async () => {
    await receiver.close();
    receiver = await startReceiver(clock, `whsec_${Buffer.alloc(32, 9).toString('base64')}`);
    db.prepare('UPDATE webhook_subscriptions SET url = ?').run(receiver.url);
    enqueue();
    await dispatcher().tick();
    expect(receiver.received[0]?.verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('signs and sends the stored bytes as they are, never a re-serialisation', async () => {
    // Bytes JSON.stringify would not produce, so re-serialising would change them.
    const stored =
      '{ "type": "case.escalated",\n  "timestamp": "2026-11-06T12:00:00Z", "data": {} }';
    db.prepare(
      `INSERT INTO webhook_deliveries (id, subscription_id, event_type, payload, attempt, status, next_attempt_at, created_at)
       VALUES ('msg_spaced', 'sub_default', 'case.escalated', ?, 0, 'pending', ?, ?)`,
    ).run(stored, clock.now().toISOString(), clock.now().toISOString());
    await dispatcher().tick();
    expect(receiver.received[0]?.rawBody.toString('utf8')).toBe(stored);
    expect(receiver.received[0]?.verdict).toEqual({ ok: true });
  });

  it('does not send deliveries that are not yet due, or already settled', async () => {
    const id = enqueue();
    db.prepare('UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?').run(
      new Date(clock.now().getTime() + 1).toISOString(),
      id,
    );
    const d = dispatcher();
    await d.tick();
    expect(receiver.received).toHaveLength(0);
    clock.advance(1);
    await d.tick();
    await d.tick();
    expect(receiver.received).toHaveLength(1);
  });

  it('concurrent ticks share one run, so nothing is sent twice', async () => {
    enqueue();
    const d = dispatcher();
    const a = d.tick();
    const b = d.tick();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(receiver.received).toHaveLength(1);
  });

  it('start() polls on its interval until stop()', async () => {
    const id = enqueue();
    const d = dispatcher({ intervalMs: 50 });
    d.start();
    for (let i = 0; i < 100 && deliveryRow(db, id).status !== 'delivered'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await d.stop();
    expect(deliveryRow(db, id).status).toBe('delivered');
  });
});

describe('dispatcher retries (S4-8)', () => {
  it('retries on the schedule, never early, and marks the delivery dead after 8 failed attempts', async () => {
    const id = enqueue();
    receiver.respond(500);
    const d = dispatcher();

    await d.tick();
    expect(receiver.received).toHaveLength(1);
    for (const [index, delay] of RETRY_SCHEDULE_MS.entries()) {
      expect(deliveryRow(db, id)).toMatchObject({
        status: 'pending',
        attempt: index + 1,
        last_status: 500,
        last_error: 'http_500',
      });
      expect(msUntilNext(id)).toBe(delay);

      clock.advance(delay - 1);
      await d.tick();
      expect(receiver.received).toHaveLength(index + 1); // not due yet

      clock.advance(1);
      await d.tick();
      expect(receiver.received).toHaveLength(index + 2);
    }

    expect(receiver.received).toHaveLength(MAX_ATTEMPTS);
    expect(MAX_ATTEMPTS).toBe(8);
    expect(deliveryRow(db, id)).toMatchObject({
      status: 'dead',
      attempt: 8,
      last_status: 500,
      last_error: 'http_500',
      next_attempt_at: null,
    });
    clock.advance(30 * 24 * 3_600_000);
    await d.tick();
    expect(receiver.received).toHaveLength(MAX_ATTEMPTS);
  });

  it.each([
    ['low', 0, 0.8],
    ['high', 0.999_999, 1.2],
  ])('keeps jitter within ±20%% (random pinned %s)', async (_label, value, factor) => {
    const id = enqueue();
    receiver.respond(503);
    const d = dispatcher({ random: () => value });
    await d.tick();
    for (const [index, delay] of RETRY_SCHEDULE_MS.entries()) {
      const wait = msUntilNext(id);
      expect(wait).toBeGreaterThanOrEqual(Math.floor(delay * 0.8));
      expect(wait).toBeLessThanOrEqual(Math.ceil(delay * 1.2));
      // 0.999999 is a hair under the top of the range: allow that hair plus rounding.
      expect(Math.abs(wait - delay * factor)).toBeLessThanOrEqual(delay * 1e-6 + 1);
      clock.advance(wait);
      await d.tick();
      expect(receiver.received).toHaveLength(index + 2);
    }
    expect(deliveryRow(db, id).status).toBe('dead');
  });

  it('a later 2xx stops the retries', async () => {
    const id = enqueue();
    receiver.respond(500);
    const d = dispatcher();
    await d.tick();
    clock.advance(RETRY_SCHEDULE_MS[0]);
    receiver.respond(204);
    await d.tick();
    expect(deliveryRow(db, id)).toMatchObject({
      status: 'delivered',
      attempt: 2,
      last_status: 204,
    });

    clock.advance(24 * 3_600_000);
    await d.tick();
    expect(receiver.received).toHaveLength(2);
  });

  it('410 disables the subscription, kills the delivery and stops all delivery to it', async () => {
    const id = enqueue();
    receiver.respond(410);
    const d = dispatcher();
    await d.tick();

    expect(deliveryRow(db, id)).toMatchObject({ status: 'dead', attempt: 1, last_status: 410 });
    expect(subscriptionRow(db)).toMatchObject({ active: 0, disabled_reason: DISABLED_GONE });

    // A delivery already queued for the subscription is not attempted.
    db.prepare(
      `INSERT INTO webhook_deliveries (id, subscription_id, event_type, payload, attempt, status, next_attempt_at, created_at)
       VALUES ('msg_queued', 'sub_default', 'case.escalated', '{}', 0, 'pending', ?, ?)`,
    ).run(clock.now().toISOString(), clock.now().toISOString());
    // New events are not enqueued for it.
    expect(enqueueEvent(db, clock, 'case.escalated', DATA)).toEqual([]);

    receiver.respond(200);
    clock.advance(24 * 3_600_000);
    await d.tick();
    expect(receiver.received).toHaveLength(1);
    expect(deliveryRow(db, 'msg_queued').status).toBe('pending');

    // Control: the queued row was due; only the disabled subscription held it back.
    db.prepare('UPDATE webhook_subscriptions SET active = 1, disabled_reason = NULL').run();
    await d.tick();
    expect(receiver.received).toHaveLength(2);
    expect(deliveryRow(db, 'msg_queued').status).toBe('delivered');
  });

  it('a redirect is a failure and is not followed', async () => {
    const target = await startReceiver(clock);
    try {
      const id = enqueue();
      receiver.respond(302, '', { location: target.url });
      await dispatcher().tick();
      expect(target.received).toHaveLength(0);
      expect(deliveryRow(db, id)).toMatchObject({
        status: 'pending',
        last_status: 302,
        last_error: 'http_302',
      });
    } finally {
      await target.close();
    }
  });

  it('a timeout counts as a failure', async () => {
    const id = enqueue();
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    await dispatcher({ fetch: hangingFetch, timeoutMs: 20 }).tick();
    expect(deliveryRow(db, id)).toMatchObject({
      status: 'pending',
      attempt: 1,
      last_status: null,
      last_error: 'timeout',
    });
    expect(msUntilNext(id)).toBe(RETRY_SCHEDULE_MS[0]);
  });

  it('a network error counts as a failure', async () => {
    const id = enqueue();
    const failingFetch: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await dispatcher({ fetch: failingFetch }).tick();
    expect(deliveryRow(db, id)).toMatchObject({
      status: 'pending',
      attempt: 1,
      last_status: null,
      last_error: 'network',
    });
  });
});

describe('dispatcher hygiene and shutdown (S4-9)', () => {
  it('keeps the response body, secret, signature and payload out of state and logs', async () => {
    const id = enqueue();
    receiver.respond(500, RESPONSE_SECRET);
    const d = dispatcher();
    await d.tick();
    receiver.respond(410, RESPONSE_SECRET);
    clock.advance(RETRY_SCHEDULE_MS[0]);
    await d.tick();

    const state = JSON.stringify([
      db.prepare('SELECT * FROM webhook_deliveries').all(),
      db.prepare('SELECT * FROM webhook_subscriptions').all(),
    ]);
    const logText = logs.text();
    const signature = header(receiver.received[0]?.headers ?? {}, 'webhook-signature') ?? '';
    expect(signature).not.toBe('');

    for (const forbidden of [RESPONSE_SECRET, SECRET, KEY.toString('base64')]) {
      expect(state).not.toContain(forbidden);
      expect(logText).not.toContain(forbidden);
    }
    expect(logText).not.toContain(signature.slice('v1,'.length));
    expect(logText).not.toContain('CS-10231'); // payload content

    const lines = logs.lines().filter((line) => line['deliveryId'] === id);
    expect(lines.map((line) => line['outcome'])).toEqual(['retry', 'gone']);
    expect(lines[0]).toMatchObject({
      subscriptionId: 'sub_default',
      attempt: 1,
      error: 'http_500',
    });
  });

  it('stop() waits for an in-flight attempt to finish', async () => {
    const id = enqueue();
    let release: (() => void) | undefined;
    let called: (() => void) | undefined;
    const fetchCalled = new Promise<void>((resolve) => {
      called = resolve;
    });
    const slowFetch: typeof fetch = () =>
      new Promise<Response>((resolve) => {
        release = () => {
          resolve(new Response(null, { status: 200 }));
        };
        called?.();
      });
    const d = dispatcher({ fetch: slowFetch });
    d.start();
    void d.tick();
    await fetchCalled;

    let stopped = false;
    const stopping = d.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    expect(deliveryRow(db, id).status).toBe('pending');

    release?.();
    await stopping;
    expect(stopped).toBe(true);
    expect(deliveryRow(db, id).status).toBe('delivered');
  });
});
