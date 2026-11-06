import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevIssuer, loadDevClients } from '../../src/auth/dev-issuer.js';
import {
  createVerifier,
  InvalidTokenError,
  IssuerUnavailableError,
} from '../../src/auth/verify.js';
import { fixedClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';
import type { RunningServer } from '../../src/server.js';
import { captureLogs, startServerWithAuth, VALID_CASE } from '../http/helpers.js';

const NOW = '2026-11-06T12:00:00Z';
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/** A fake identity provider whose JWKS endpoint answers with the given status and body. */
async function fakeIdp(status: number, body: string, type = 'application/json'): Promise<string> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': type }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  stop = () =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/dev`;
}

async function signedToken(issuerUrl: string, overrides = {}): Promise<string> {
  const config = loadConfig({ NODE_ENV: 'test', ISSUER_URL: issuerUrl, DEV_ISSUER: 'true' });
  const issuer = await createDevIssuer({
    config,
    clock: fixedClock(NOW),
    clients: loadDevClients(),
  });
  return issuer.mint({
    sub: 'jdoe',
    clientId: 'support-console',
    scopes: ['cases:read'],
    overrides,
  });
}

describe('identity provider failures are 503s, not invalid tokens', () => {
  it.each([
    ['a 500 from the JWKS endpoint', 500, '{"error":"boom"}', 'application/json'],
    ['a 404 HTML page', 404, '<html>not found</html>', 'text/html'],
    ['a JSON body that is not a key set', 200, '{"hello":"world"}', 'application/json'],
  ])('treats %s as unavailable', async (_name, status, body, type) => {
    const issuerUrl = await fakeIdp(status, body, type);
    const config = loadConfig({ NODE_ENV: 'test', ISSUER_URL: issuerUrl });
    const verifier = createVerifier({ config, clock: fixedClock(NOW) });
    const token = await signedToken(issuerUrl);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(IssuerUnavailableError);
  });
});

describe('claims the verifier must refuse', () => {
  async function verifyWith(overrides: Record<string, unknown>): Promise<unknown> {
    const config = loadConfig({ NODE_ENV: 'test', DEV_ISSUER: 'true' });
    const issuer = await createDevIssuer({
      config,
      clock: fixedClock(NOW),
      clients: loadDevClients(),
    });
    const { createLocalJWKSet } = await import('jose');
    const verifier = createVerifier({
      config,
      clock: fixedClock(NOW),
      jwks: createLocalJWKSet(issuer.jwks),
    });
    const token = await issuer.mint({
      sub: 'jdoe',
      clientId: 'support-console',
      scopes: ['cases:read'],
      overrides,
    });
    return verifier.verify(token).catch((error: unknown) => error);
  }

  const refused: [string, Record<string, unknown>][] = [
    ['no exp', { exp: undefined }],
    ['act as a string', { act: 'support-copilot' }],
    ['act with an empty sub', { act: { sub: '' } }],
    ['a nested act chain', { act: { sub: 'support-copilot', act: { sub: 'other-agent' } } }],
  ];
  it.each(refused)('refuses a token with %s', async (_name, overrides) => {
    expect(await verifyWith(overrides)).toBeInstanceOf(InvalidTokenError);
  });

  it('accepts a single actor and records it as the agent', async () => {
    expect(await verifyWith({ act: { sub: 'support-copilot' } })).toMatchObject({
      sub: 'jdoe',
      agent: 'support-copilot',
    });
  });
});

describe('rate limits apply to every authenticated response', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.shutdown();
    running = undefined;
  });

  it('charges and labels 400 and 403 responses, not only successes', async () => {
    let auth: { authorization: string };
    ({ running, auth } = await startServerWithAuth(captureLogs().logger, {
      env: { RATE_LIMIT_CLIENT_PER_MINUTE: '3' },
      handlers: {
        getCase: (_req, res) => {
          res.json(VALID_CASE);
        },
      },
    }));
    const url = running.url;
    const invalid = await fetch(`${url}/v1/cases?limit=9999`, { headers: auth });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('ratelimit')).toMatch(/^"client";r=2;/);

    const ipaas = await running.issuer?.mint({
      sub: 'ipaas-flow',
      clientId: 'ipaas-flow',
      scopes: ['cases:read'],
    });
    const forbidden = await fetch(`${url}/v1/customers/ACC-007`, {
      headers: { authorization: `Bearer ${ipaas ?? ''}` },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('ratelimit-policy')).toBe('"client";q=3;w=60');

    // Two more invalid requests use up support-console's quota of 3.
    await fetch(`${url}/v1/cases?limit=9999`, { headers: auth });
    await fetch(`${url}/v1/cases?limit=9999`, { headers: auth });
    expect((await fetch(`${url}/v1/cases/CS-10231`, { headers: auth })).status).toBe(429);
  });

  it('does not charge requests without a valid token', async () => {
    let auth: { authorization: string };
    ({ running, auth } = await startServerWithAuth(captureLogs().logger, {
      env: { RATE_LIMIT_CLIENT_PER_MINUTE: '2' },
      handlers: {
        getCase: (_req, res) => {
          res.json(VALID_CASE);
        },
      },
    }));
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${running.url}/v1/cases/CS-10231`)).status).toBe(401);
    }
    expect((await fetch(`${running.url}/v1/cases/CS-10231`, { headers: auth })).status).toBe(200);
  });
});

describe('token endpoint and logging details', () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.shutdown();
    running = undefined;
  });

  it('rejects Basic credentials that disagree with the form client_id', async () => {
    ({ running } = await startServerWithAuth(captureLogs().logger));
    const res = await fetch(`${running.url}/dev/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('support-console:dev-only-support-console-secret').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&client_id=finance-app',
    });
    expect(res.status).toBe(400);
  });

  it('logs which client obtained a token, never the secret', async () => {
    const logs = captureLogs();
    ({ running } = await startServerWithAuth(logs.logger));
    await fetch(`${running.url}/dev/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&client_id=finance-app&client_secret=dev-only-finance-app-secret',
    });
    const line = logs.lines().find((l) => l.status === 200 && l.method === 'POST');
    expect(line).toMatchObject({ clientId: 'finance-app', sub: 'fbaker' });
    expect(logs.text()).not.toContain('dev-only-finance-app-secret');
  });

  it('logs an error line when authentication fails because the IdP is down', async () => {
    const logs = captureLogs();
    const { startServer } = await import('../../src/server.js');
    const { freePort, testConfig } = await import('../http/helpers.js');
    const closed = await freePort();
    running = await startServer(
      testConfig({
        PORT: String(await freePort()),
        ISSUER_URL: `http://127.0.0.1:${String(closed)}/dev`,
      }),
      logs.logger,
    );
    await fetch(`${running.url}/v1/cases/CS-10231`, {
      headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2ln' },
    });
    expect(logs.lines().some((l) => l.level === 'error' && l.msg === 'authentication failed')).toBe(
      true,
    );
  });
});

describe('dev issuer configuration', () => {
  it('refuses DEV_ISSUER with an OS-chosen port and no issuer URL', () => {
    expect(() => loadConfig({ DEV_ISSUER: 'true', PORT: '0' })).toThrow(/ISSUER_URL is required/);
    expect(
      loadConfig({ DEV_ISSUER: 'true', PORT: '0', ISSUER_URL: 'http://127.0.0.1:9/dev' }).devIssuer,
    ).toBe(true);
  });
});
