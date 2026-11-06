import { describe, expect, it } from 'vitest';
import { FaultInjector, faultsFromEnv, parseFaultUpdate } from '../../mocks/faults.js';
import { useMockServer } from './helpers.js';

const h = useMockServer();

async function setFault(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${h.url}/__admin/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('fault injection (S1-5)', () => {
  it('forces 429 with Retry-After on one upstream only', async () => {
    expect(
      (await setFault({ upstream: 'cases', forceStatus: 429, retryAfterSeconds: 7 })).status,
    ).toBe(200);
    const res = await fetch(`${h.url}/cases/anything`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    // Other upstreams are unaffected: the entitlement path falls through to 404, not 429.
    expect((await fetch(`${h.url}/exports/none`)).status).toBe(404);
  });

  it('drops the connection when down', async () => {
    await setFault({ upstream: 'warehouse', down: true });
    await expect(fetch(`${h.url}/api/v2/statements`, { method: 'POST' })).rejects.toThrow();
  });

  it('adds latency', async () => {
    await setFault({ upstream: 'entitlement', latencyMs: 150, forceStatus: 503 });
    const started = performance.now();
    const res = await fetch(`${h.url}/feeds/entitlements.xml`);
    expect(res.status).toBe(503);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('reset restores defaults', async () => {
    await setFault({ upstream: 'cases', forceStatus: 503 });
    expect((await fetch(`${h.url}/__admin/reset`, { method: 'POST' })).status).toBe(204);
    const faults = (await (await fetch(`${h.url}/__admin/faults`)).json()) as Record<
      string,
      { forceStatus: unknown }
    >;
    expect(faults.cases?.forceStatus).toBeNull();
  });

  it('rejects unknown upstreams and settings', async () => {
    expect((await setFault({ upstream: 'crm', down: true })).status).toBe(400);
    expect((await setFault({ upstream: 'cases', explode: true })).status).toBe(400);
  });
});

describe('fault configuration', () => {
  it('error rate is deterministic for a seed', () => {
    const draw = (): number[] => {
      const injector = new FaultInjector(7);
      injector.update('cases', { errorRate: 0.5 });
      const results: number[] = [];
      const mw = injector.middleware('cases');
      for (let i = 0; i < 20; i++) {
        let status = 200;
        const res = {
          status: (s: number) => ({
            json: () => {
              status = s;
            },
          }),
          set: () => undefined,
        };
        void mw({} as never, res as never, () => undefined);
        results.push(status);
      }
      return results;
    };
    const first = draw();
    expect(first).toEqual(draw());
    expect(first).toContain(500);
    expect(first).toContain(200);
  });

  it('parses MOCK_FAULTS', () => {
    expect(faultsFromEnv('{"warehouse":{"down":true}}')).toEqual({ warehouse: { down: true } });
    expect(() => faultsFromEnv('{"crm":{}}')).toThrow(/unknown upstream/);
    expect(() => parseFaultUpdate({ errorRate: 2 })).toThrow(/errorRate/);
  });
});
