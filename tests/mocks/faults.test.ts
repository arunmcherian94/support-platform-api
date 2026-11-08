import { describe, expect, it } from 'vitest';
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
});
