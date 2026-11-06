import { describe, expect, it } from 'vitest';
import { startServer } from '../../src/server.js';
import { captureLogs, testConfig, VALID_CASE } from './helpers.js';

describe('graceful shutdown (S2-10)', () => {
  it('drains an in-flight request, then refuses new connections', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logs = captureLogs();
    const running = await startServer(testConfig({ PORT: '8097' }), logs.logger, {
      handlers: {
        getCase: async (_req, res) => {
          await held;
          res.json(VALID_CASE);
        },
      },
    });

    const inFlight = fetch(`${running.url}/v1/cases/CS-10231`);
    // Let the request reach the handler before shutting down.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stopped = running.shutdown();
    release();

    const res = await inFlight;
    expect(res.status).toBe(200);
    await stopped;
    await expect(fetch(`${running.url}/healthz`)).rejects.toThrow();
    expect(logs.lines().some((line) => line.msg === 'shutdown complete')).toBe(true);
  });
});
