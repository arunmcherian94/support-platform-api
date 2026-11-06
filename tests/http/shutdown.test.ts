import { describe, expect, it } from 'vitest';
import { startServer } from '../../src/server.js';
import { captureLogs, testConfig, VALID_CASE } from './helpers.js';

describe('graceful shutdown (S2-10)', () => {
  it('drains an in-flight request, closes the database, then refuses connections', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const logs = captureLogs();
    const running = await startServer(testConfig({ PORT: '0' }), logs.logger, {
      handlers: {
        getCase: async (_req, res) => {
          entered();
          await held;
          res.json(VALID_CASE);
        },
      },
    });

    const inFlight = fetch(`${running.url}/v1/cases/CS-10231`);
    await reached;
    const stopped = running.shutdown();
    release();

    expect((await inFlight).status).toBe(200);
    await stopped;
    expect(() => running.db.prepare('SELECT 1')).toThrow();
    await expect(fetch(`${running.url}/healthz`)).rejects.toThrow();
  });
});

describe('readiness during shutdown', () => {
  it('reports 503 during the readiness delay, before the listener closes', async () => {
    const running = await startServer(
      testConfig({ PORT: '0', SHUTDOWN_READINESS_DELAY_MS: '300' }),
      captureLogs().logger,
    );
    expect((await fetch(`${running.url}/readyz`)).status).toBe(200);
    const stopped = running.shutdown();
    const res = await fetch(`${running.url}/readyz`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { status: string }).status).toBe('unavailable');
    // Liveness is unaffected: the process is healthy, just leaving.
    expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
    await stopped;
    await expect(fetch(`${running.url}/readyz`)).rejects.toThrow();
  });
});
