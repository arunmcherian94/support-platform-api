/**
 * End to end through the real server: tokens from the dev issuer's token
 * endpoint, verified over HTTP against its JWKS, scopes from the contract,
 * then rate limits (S2-5, S2-6, S2-7, S2-12).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server.js';
import { captureLogs, freePort, startServerWithAuth, testConfig, VALID_CASE } from './helpers.js';

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.shutdown();
  running = undefined;
});

const handlers = {
  getCase: (_req: unknown, res: { json: (body: unknown) => void }) => {
    res.json(VALID_CASE);
  },
};

async function tokenFor(url: string, clientId: string, secret: string): Promise<string> {
  const res = await fetch(`${url}/dev/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('auth and rate limits through the real server', () => {
  it('serves a caller with a token from the token endpoint, verified via JWKS', async () => {
    const logs = captureLogs();
    ({ running } = await startServerWithAuth(logs.logger, { handlers }));
    const token = await tokenFor(running.url, 'support-console', 'dev-only-support-console-secret');

    const res = await fetch(`${running.url}/v1/cases/CS-10231`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit-policy')).toBe('"client";q=100;w=60');
    expect(res.headers.get('ratelimit')).toMatch(/^"client";r=99;t=\d+$/);
    const line = logs.lines().find((l) => l.route === '/v1/cases/{caseId}');
    expect(line).toMatchObject({ clientId: 'support-console', sub: 'jdoe', status: 200 });
    expect(logs.text()).not.toContain(token);
  });

  it('rejects a missing token with 401 and a bearer challenge', async () => {
    ({ running } = await startServerWithAuth(captureLogs().logger, { handlers }));
    const res = await fetch(`${running.url}/v1/cases/CS-10231`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(((await res.json()) as { type: string }).type).toMatch(/unauthorized$/);
  });

  it('logs why a token was rejected, without telling the client', async () => {
    const logs = captureLogs();
    ({ running } = await startServerWithAuth(logs.logger, { handlers }));
    const res = await fetch(`${running.url}/v1/cases/CS-10231`, {
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    const line = logs.lines().find((l) => l.status === 401);
    expect(typeof line?.authFailure).toBe('string');
    expect(body).not.toContain(String(line?.authFailure));
  });

  it('refuses an operation the token has no scope for, naming the scope', async () => {
    ({ running } = await startServerWithAuth(captureLogs().logger, { handlers }));
    const token = await tokenFor(running.url, 'ipaas-flow', 'dev-only-ipaas-flow-secret');
    const res = await fetch(`${running.url}/v1/customers/ACC-007`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="customers:read"',
    );
  });

  it('rate-limits per client with 429 and Retry-After', async () => {
    ({ running } = await startServerWithAuth(captureLogs().logger, {
      handlers,
      env: { RATE_LIMIT_CLIENT_PER_MINUTE: '3' },
    }));
    const console = await tokenFor(
      running.url,
      'support-console',
      'dev-only-support-console-secret',
    );
    const finance = await tokenFor(running.url, 'finance-app', 'dev-only-finance-app-secret');
    const call = (token: string) =>
      fetch(`${running?.url ?? ''}/v1/cases/CS-10231`, {
        headers: { authorization: `Bearer ${token}` },
      });
    for (let i = 0; i < 3; i++) expect((await call(console)).status).toBe(200);
    const limited = await call(console);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get('ratelimit')).toMatch(/^"client";r=0;/);
    expect(((await limited.json()) as { type: string }).type).toMatch(/rate-limited$/);
    // Another client has its own bucket.
    expect((await call(finance)).status).toBe(200);
  });

  it('answers 503 when the identity provider is unreachable', async () => {
    const closed = await freePort(); // nothing listens here
    running = await startServer(
      testConfig({
        PORT: String(await freePort()),
        ISSUER_URL: `http://127.0.0.1:${String(closed)}/dev`,
      }),
      captureLogs().logger,
      { handlers },
    );
    const res = await fetch(`${running.url}/v1/cases/CS-10231`, {
      headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2ln' },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(((await res.json()) as { type: string }).type).toMatch(/upstream-unavailable$/);
  });

  it('does not mount the dev issuer unless DEV_ISSUER=true (S2-12)', async () => {
    running = await startServer(
      testConfig({ PORT: String(await freePort()) }),
      captureLogs().logger,
    );
    expect(running.issuer).toBeUndefined();
    const res = await fetch(`${running.url}/dev/oauth/token`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await fetch(`${running.url}/dev/.well-known/jwks.json`)).status).toBe(404);
  });
});
