import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type express from 'express';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { loadConfig, type Config } from '../../src/config.js';
import {
  createDevIssuer,
  devIssuerEnabled,
  loadDevClients,
  type DevIssuer,
} from '../../src/auth/dev-issuer.js';
import { createApp } from '../../src/http/app.js';
import { openDatabase } from '../../src/store/db.js';
import { captureLogs, FIXTURE_NOW } from '../http/helpers.js';

const CLIENTS = loadDevClients();

interface IssuerApp {
  url: string;
  config: Config;
  issuer: DevIssuer;
  logs: ReturnType<typeof captureLogs>;
  close(): Promise<void>;
}

async function startIssuerApp(options: { mountIssuer?: boolean } = {}): Promise<IssuerApp> {
  const config = loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:', DEV_ISSUER: 'true' });
  const clock = fixedClock(FIXTURE_NOW);
  const logs = captureLogs();
  const issuer = await createDevIssuer({ config, clock, clients: CLIENTS });
  const preValidation: express.Router[] = options.mountIssuer === false ? [] : [issuer.router];
  const app = createApp({
    config,
    clock,
    logger: logs.logger,
    db: openDatabase(':memory:'),
    preValidation,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    config,
    issuer,
    logs,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

let app: IssuerApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const basic = (id: string, secret: string): string =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

function requestToken(
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/dev/oauth/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(form),
  });
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface OAuthErrorBody {
  error: string;
  error_description: string;
}

const CONSOLE_SECRET = 'dev-only-support-console-secret';
const GRANT = { grant_type: 'client_credentials' };

describe('dev issuer JWKS', () => {
  it('publishes one RS256 signing key with a kid', async () => {
    app = await startIssuerApp();
    const res = await fetch(`${app.url}/dev/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(typeof body.keys[0]?.kid).toBe('string');
    // Public key only.
    expect(body.keys[0]).not.toHaveProperty('d');
  });
});

describe('dev issuer token endpoint (client_credentials)', () => {
  it('issues a token with client authentication over HTTP Basic', async () => {
    app = await startIssuerApp();
    const res = await requestToken(app.url, GRANT, {
      Authorization: basic('support-console', CONSOLE_SECRET),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as TokenResponse;
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'customers:read cases:read cases:comment cases:escalate',
    });
    const iat = Date.parse(FIXTURE_NOW) / 1000;
    const claims = decodeJwt(body.access_token);
    expect(claims).toMatchObject({
      iss: app.config.issuerUrl,
      aud: app.config.audience,
      sub: 'jdoe',
      client_id: 'support-console',
      scope: body.scope,
      iat,
      exp: iat + 900,
    });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(decodeProtectedHeader(body.access_token)).toMatchObject({
      alg: 'RS256',
      kid: app.issuer.jwks.keys[0]?.kid,
    });
  });

  it('issues a token with client credentials in the form', async () => {
    app = await startIssuerApp();
    const res = await requestToken(app.url, {
      ...GRANT,
      client_id: 'ipaas-flow',
      client_secret: 'dev-only-ipaas-flow-secret',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenResponse;
    // No configured sub: the client acts as itself.
    expect(decodeJwt(body.access_token)).toMatchObject({ sub: 'ipaas-flow', scope: 'cases:read' });
  });

  it('grants a requested subset of the allowed scopes', async () => {
    app = await startIssuerApp();
    const res = await requestToken(
      app.url,
      { ...GRANT, scope: 'cases:read customers:read' },
      { Authorization: basic('support-console', CONSOLE_SECRET) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as TokenResponse).scope).toBe('cases:read customers:read');
  });

  it('refuses a scope the client is not allowed with invalid_scope', async () => {
    app = await startIssuerApp();
    const res = await requestToken(
      app.url,
      { ...GRANT, scope: 'cases:read finance:read' },
      { Authorization: basic('support-console', CONSOLE_SECRET) },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as OAuthErrorBody).error).toBe('invalid_scope');
  });

  it('refuses a wrong secret with 401 invalid_client and a Basic challenge', async () => {
    app = await startIssuerApp();
    const res = await requestToken(app.url, GRANT, {
      Authorization: basic('support-console', 'dev-only-support-console-secreT'),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="dev-issuer"');
    expect(((await res.json()) as OAuthErrorBody).error).toBe('invalid_client');
  });

  it('refuses an unknown client the same way as a wrong secret', async () => {
    app = await startIssuerApp();
    const res = await requestToken(app.url, {
      ...GRANT,
      client_id: 'nobody',
      client_secret: CONSOLE_SECRET,
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as OAuthErrorBody).toEqual({
      error: 'invalid_client',
      error_description: 'Client authentication failed.',
    });
  });

  it('refuses a request without client authentication', async () => {
    app = await startIssuerApp();
    const res = await requestToken(app.url, GRANT);
    expect(res.status).toBe(401);
    expect(((await res.json()) as OAuthErrorBody).error).toBe('invalid_client');
  });

  it('refuses two client authentication methods at once', async () => {
    app = await startIssuerApp();
    const res = await requestToken(
      app.url,
      { ...GRANT, client_id: 'support-console', client_secret: CONSOLE_SECRET },
      { Authorization: basic('support-console', CONSOLE_SECRET) },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as OAuthErrorBody).error).toBe('invalid_request');
  });

  it('refuses another grant type with unsupported_grant_type', async () => {
    app = await startIssuerApp();
    const res = await requestToken(
      app.url,
      { grant_type: 'password' },
      { Authorization: basic('support-console', CONSOLE_SECRET) },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as OAuthErrorBody).error).toBe('unsupported_grant_type');
  });

  it('refuses malformed requests with invalid_request', async () => {
    app = await startIssuerApp();
    const auth = { Authorization: basic('support-console', CONSOLE_SECRET) };
    const missingGrant = await requestToken(app.url, {}, auth);
    expect(missingGrant.status).toBe(400);
    expect(((await missingGrant.json()) as OAuthErrorBody).error).toBe('invalid_request');

    const json = await fetch(`${app.url}/dev/oauth/token`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(GRANT),
    });
    expect(json.status).toBe(400);
    expect(((await json.json()) as OAuthErrorBody).error).toBe('invalid_request');

    const repeated = await fetch(`${app.url}/dev/oauth/token`, {
      method: 'POST',
      headers: auth,
      body: new URLSearchParams([
        ['grant_type', 'client_credentials'],
        ['grant_type', 'client_credentials'],
      ]),
    });
    expect(repeated.status).toBe(400);
    expect(((await repeated.json()) as OAuthErrorBody).error).toBe('invalid_request');
  });

  it('keeps client secrets and issued tokens out of the logs', async () => {
    app = await startIssuerApp();
    const viaBasic = await requestToken(app.url, GRANT, {
      Authorization: basic('support-console', CONSOLE_SECRET),
    });
    const viaForm = await requestToken(app.url, {
      ...GRANT,
      client_id: 'ipaas-flow',
      client_secret: 'dev-only-ipaas-flow-secret',
    });
    const bad = await requestToken(app.url, {
      ...GRANT,
      client_id: 'finance-app',
      client_secret: 'dev-only-wrong-secret',
    });
    const tokens = [viaBasic, viaForm].map(async (res) => {
      return ((await res.json()) as TokenResponse).access_token;
    });
    await bad.text();
    const logs = app.logs.text();
    expect(logs).toContain('request completed');
    for (const secret of [
      CONSOLE_SECRET,
      'dev-only-ipaas-flow-secret',
      'dev-only-wrong-secret',
      Buffer.from(`support-console:${CONSOLE_SECRET}`).toString('base64'),
      ...(await Promise.all(tokens)),
    ]) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('dev issuer is off unless asked for (S2-12)', () => {
  it('is disabled by default and refused in production', () => {
    expect(devIssuerEnabled(loadConfig({ NODE_ENV: 'test' }))).toBe(false);
    expect(devIssuerEnabled(loadConfig({ NODE_ENV: 'test', DEV_ISSUER: 'true' }))).toBe(true);
    expect(() => loadConfig({ NODE_ENV: 'production', DEV_ISSUER: 'true' })).toThrow(/DEV_ISSUER/);
  });

  it('returns 404 problems for the issuer routes when the router is not mounted', async () => {
    app = await startIssuerApp({ mountIssuer: false });
    const token = await requestToken(app.url, GRANT, {
      Authorization: basic('support-console', CONSOLE_SECRET),
    });
    expect(token.status).toBe(404);
    expect(token.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    expect(((await token.json()) as { type: string }).type).toBe(
      'https://support-platform.example/problems/not-found',
    );
    const jwks = await fetch(`${app.url}/dev/.well-known/jwks.json`);
    expect(jwks.status).toBe(404);
  });
});

describe('dev client config', () => {
  it('seeds the four documented clients with obviously fake secrets', () => {
    expect(CLIENTS.map((client) => client.clientId)).toEqual([
      'support-console',
      'finance-app',
      'ipaas-flow',
      'support-copilot',
    ]);
    for (const client of CLIENTS) expect(client.secret).toMatch(/^dev-only-/);
  });
});
