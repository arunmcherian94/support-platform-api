/** The dispatcher wired into the real server (S4-6, S4-9). */
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { enqueueEvent } from '../../src/events/enqueue.js';
import { startServer, type RunningServer } from '../../src/server.js';
import { SECRET, startReceiver, type TestReceiver } from '../events/helpers.js';
import { captureLogs, FIXTURE_NOW, testConfig } from './helpers.js';

let running: RunningServer | undefined;
let receiver: TestReceiver | undefined;
afterEach(async () => {
  await running?.shutdown();
  await receiver?.close();
  running = undefined;
  receiver = undefined;
});

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('webhook delivery through the running server', () => {
  it('delivers an enqueued event to the configured receiver, signed and verifiable', async () => {
    const clock = fixedClock(FIXTURE_NOW);
    receiver = await startReceiver(clock);
    running = await startServer(
      testConfig({
        PORT: '0',
        WEBHOOK_URL: receiver.url,
        WEBHOOK_SECRET: SECRET,
        WEBHOOK_DISPATCH_INTERVAL_MS: '50',
      }),
      captureLogs().logger,
      { clock },
    );
    const db = running.db;
    db.exec('BEGIN');
    const [id] = enqueueEvent(db, clock, 'case.escalated', { caseId: 'CS-10231' });
    db.exec('COMMIT');
    await until(() => (receiver?.received.length ?? 0) > 0);
    const got = receiver.received[0];
    expect(got?.verdict).toEqual({ ok: true });
    expect(got?.headers['webhook-id']).toBe(id);
    const row = db.prepare('SELECT status FROM webhook_deliveries WHERE id = ?').get(id ?? '') as
      { status: string } | undefined;
    await until(
      () =>
        (
          db.prepare('SELECT status FROM webhook_deliveries WHERE id = ?').get(id ?? '') as {
            status: string;
          }
        ).status === 'delivered',
    );
    expect(row).toBeDefined();
  });

  it('queues nothing and runs no dispatcher without WEBHOOK_URL', async () => {
    const clock = fixedClock(FIXTURE_NOW);
    running = await startServer(testConfig({ PORT: '0' }), captureLogs().logger, { clock });
    const ids = enqueueEvent(running.db, clock, 'case.escalated', { caseId: 'CS-10231' });
    expect(ids).toEqual([]);
  });
});
