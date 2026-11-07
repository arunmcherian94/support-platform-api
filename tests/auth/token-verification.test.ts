import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { base64url, exportSPKI, generateKeyPair, importJWK, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock, type TestClock } from '../../src/clock.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDevIssuer, loadDevClients, type DevIssuer } from '../../src/auth/dev-issuer.js';
import { createSecurityHandler } from '../../src/auth/security-handler.js';
import type { Identity } from '../../src/auth/types.js';
import { createVerifier } from '../../src/auth/verify.js';
import { createApp, type OperationHandlers } from '../../src/http/app.js';
import { openDatabase } from '../../src/store/db.js';
import { captureLogs, FIXTURE_NOW, VALID_CASE } from '../http/helpers.js';

interface AuthApp {
  url: string;
  config: Config;
  clock: TestClock;
  issuer: DevIssuer;
  logs: ReturnType<typeof captureLogs>;
  close(): Promise<void>;
}

/**
 * The server listens first so the issuer URL can name its real port: the
 * verifier then fetches keys from the issuer's JWKS URL over HTTP, exactly as a
 * resource server in front of a real identity provider would.
 */
async function startAuthApp(handlers: OperationHandlers = {}): Promise<AuthApp> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_PATH: ':memory:',
    DEV_ISSUER: 'true',
    ISSUER_URL: `${url}/dev`,
  });
  const clock = fixedClock(FIXTURE_NOW);
  const logs = captureLogs();
  const issuer = await createDevIssuer({ config, clock, clients: loadDevClients() });
  const app = createApp({
    config,
    clock,
    logger: logs.logger,
    db: openDatabase(':memory:'),
    preValidation: [issuer.router],
    securityHandler: createSecurityHandler(createVerifier({ config, clock })),
    handlers: {
      getCase: (_req, res) => {
        res.json(VALID_CASE);
      },
      ...handlers,
    },
  });
  server.on('request', app);
  return {
    url,
    config,
    clock,
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

let app: AuthApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Problem {
  type: string;
  status: number;
  detail: string;
}

const PROBLEM = 'https://support-platform.example/problems/';

async function tokenFor(url: string, clientId: string, scope?: string): Promise<string> {
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope !== undefined) form.set('scope', scope);
  const res = await fetch(`${url}/dev/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:dev-only-${clientId}-secret`).toString('base64')}`,
    },
    body: form,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

function getCase(url: string, authorization?: string): Promise<Response> {
  return fetch(`${url}/v1/cases/CS-10231`, {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

async function expectUnauthorized(res: Response, challenge: string): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe(challenge);
  expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  const body = (await res.json()) as Problem;
  expect(body.type).toBe(`${PROBLEM}unauthorized`);
}

const INVALID = 'Bearer error="invalid_token"';

function claimsFor(config: Config, clock: TestClock): Record<string, unknown> {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return {
    iss: config.issuerUrl,
    aud: config.audience,
    sub: 'jdoe',
    client_id: 'support-console',
    scope: 'cases:read',
    iat,
    exp: iat + 900,
  };
}

describe('token verification through the issuer JWKS URL (S2-5)', () => {
  it('accepts a token from the token endpoint', async () => {
    app = await startAuthApp();
    const token = await tokenFor(app.url, 'support-console');
    const res = await getCase(app.url, `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('CS-10231');
  });

  it('accepts the scheme name in any case', async () => {
    app = await startAuthApp();
    const token = await tokenFor(app.url, 'support-console');
    expect((await getCase(app.url, `bearer ${token}`)).status).toBe(200);
  });

  it('rejects a missing Authorization header with a bare Bearer challenge', async () => {
    app = await startAuthApp();
    await expectUnauthorized(await getCase(app.url), 'Bearer');
  });

  it('treats another scheme as no bearer credentials', async () => {
    app = await startAuthApp();
    await expectUnauthorized(await getCase(app.url, 'Basic dXNlcjpwYXNz'), 'Bearer');
  });

  it('rejects a malformed bearer header', async () => {
    app = await startAuthApp();
    await expectUnauthorized(await getCase(app.url, 'Bearer'), INVALID);
    await expectUnauthorized(await getCase(app.url, 'Bearer one two'), INVALID);
  });

  it('rejects a garbage token', async () => {
    app = await startAuthApp();
    await expectUnauthorized(await getCase(app.url, 'Bearer not-a-jwt'), INVALID);
  });

  it('rejects a wrong issuer', async () => {
    app = await startAuthApp();
    const token = await app.issuer.mint({
      sub: 'jdoe',
      clientId: 'support-console',
      scopes: ['cases:read'],
      overrides: { iss: 'https://attacker.example/dev' },
    });
    await expectUnauthorized(await getCase(app.url, `Bearer ${token}`), INVALID);
  });

  it('rejects a wrong audience', async () => {
    app = await startAuthApp();
    const token = await app.issuer.mint({
      sub: 'jdoe',
      clientId: 'support-console',
      scopes: ['cases:read'],
      overrides: { aud: 'some-other-api' },
    });
    await expectUnauthorized(await getCase(app.url, `Bearer ${token}`), INVALID);
  });

  it('rejects an expired token once past the 30s tolerance', async () => {
    app = await startAuthApp();
    const token = await tokenFor(app.url, 'support-console');
    app.clock.advance((900 + 29) * 1000);
    expect((await getCase(app.url, `Bearer ${token}`)).status).toBe(200);
    app.clock.advance(2 * 1000);
    await expectUnauthorized(await getCase(app.url, `Bearer ${token}`), INVALID);
  });

  it('rejects a token that is not yet valid', async () => {
    app = await startAuthApp();
    const nbf = Math.floor(app.clock.now().getTime() / 1000) + 120;
    const token = await app.issuer.mint({
      sub: 'jdoe',
      clientId: 'support-console',
      scopes: ['cases:read'],
      overrides: { nbf },
    });
    await expectUnauthorized(await getCase(app.url, `Bearer ${token}`), INVALID);
  });

  it('rejects an unsigned token (alg: none)', async () => {
    app = await startAuthApp();
    const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = base64url.encode(JSON.stringify(claimsFor(app.config, app.clock)));
    await expectUnauthorized(await getCase(app.url, `Bearer ${header}.${payload}.`), INVALID);
  });

  it('rejects HS256 signed with the RSA public key as the HMAC secret (key confusion)', async () => {
    app = await startAuthApp();
    const jwk = app.issuer.jwks.keys[0];
    expect(jwk).toBeDefined();
    const publicKey = await importJWK({ ...jwk, alg: 'RS256' }, 'RS256');
    const pem = await exportSPKI(publicKey as CryptoKey);
    const token = await new SignJWT(claimsFor(app.config, app.clock))
      .setProtectedHeader({ alg: 'HS256', kid: jwk?.kid ?? '' })
      .sign(new TextEncoder().encode(pem));
    await expectUnauthorized(await getCase(app.url, `Bearer ${token}`), INVALID);
  });

  it('rejects a tampered payload carrying the original signature', async () => {
    app = await startAuthApp();
    const token = await tokenFor(app.url, 'ipaas-flow');
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(new TextDecoder().decode(base64url.decode(payload ?? ''))) as Record<
      string,
      unknown
    >;
    const forged = base64url.encode(
      JSON.stringify({ ...claims, scope: 'cases:read finance:read' }),
    );
    await expectUnauthorized(
      await getCase(app.url, `Bearer ${header ?? ''}.${forged}.${signature ?? ''}`),
      INVALID,
    );
  });

  it('rejects a token signed by a key the issuer does not publish', async () => {
    app = await startAuthApp();
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT(claimsFor(app.config, app.clock))
      .setProtectedHeader({ alg: 'RS256', kid: app.issuer.jwks.keys[0]?.kid ?? '' })
      .sign(privateKey);
    await expectUnauthorized(await getCase(app.url, `Bearer ${token}`), INVALID);
  });

  it('rejects a token without client_id', async () => {
    app = await startAuthApp();
    const token = await app.issuer.mint({
      sub: 'jdoe',
      clientId: 'support-console',
      scopes: ['cases:read'],
      overrides: { client_id: undefined },
    });
    await expectUnauthorized(await getCase(app.url, `Bearer ${token}`), INVALID);
  });

  it('never echoes the verifier reason to the client', async () => {
    app = await startAuthApp();
    const token = await app.issuer.mint({
      sub: 'jdoe',
      clientId: 'support-console',
      scopes: ['cases:read'],
      overrides: { aud: 'some-other-api' },
    });
    const body = (await (await getCase(app.url, `Bearer ${token}`)).json()) as Problem;
    expect(body.detail).toBe('The access token is invalid or has expired.');
    expect(JSON.stringify(body)).not.toMatch(/aud|ERR_|claim/i);
  });

  it('leaves operations without security open', async () => {
    app = await startAuthApp();
    expect((await fetch(`${app.url}/healthz`)).status).toBe(200);
  });
});

describe('scopes come from the contract (S2-6)', () => {
  async function expectInsufficientScope(res: Response, scope: string): Promise<void> {
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer error="insufficient_scope", scope="${scope}"`,
    );
    const body = (await res.json()) as Problem;
    expect(body.type).toBe(`${PROBLEM}insufficient-scope`);
    expect(body.detail).toBe(`This operation requires the ${scope} scope.`);
  }

  it('refuses getCustomer to the iPaaS client (no customers:read)', async () => {
    app = await startAuthApp();
    const token = await tokenFor(app.url, 'ipaas-flow');
    const res = await fetch(`${app.url}/v1/customers/ACC-007`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectInsufficientScope(res, 'customers:read');
  });

  it('refuses addCaseComment to the iPaaS client (no cases:comment)', async () => {
    app = await startAuthApp();
    const token = await tokenFor(app.url, 'ipaas-flow');
    const res = await fetch(`${app.url}/v1/cases/CS-10231/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': '0b9c2f6e-6f1a-4d55-9d43-7f3e6a1c2b10',
      },
      body: JSON.stringify({ body: 'Checked the node logs.' }),
    });
    await expectInsufficientScope(res, 'cases:comment');
  });

  it('requires cases:read for getCase', async () => {
    app = await startAuthApp();
    const token = await tokenFor(app.url, 'finance-app', 'customers:read');
    await expectInsufficientScope(await getCase(app.url, `Bearer ${token}`), 'cases:read');
  });

  it('logs who was refused', async () => {
    app = await startAuthApp();
    const token = await tokenFor(app.url, 'ipaas-flow');
    await fetch(`${app.url}/v1/customers/ACC-007`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const line = app.logs.lines().find((entry) => entry.status === 403);
    expect(line?.clientId).toBe('ipaas-flow');
    expect(line?.sub).toBe('ipaas-flow');
  });
});

describe('identity on res.locals', () => {
  it('exposes sub, client, scopes and the acting agent', async () => {
    let seen: Identity | undefined;
    app = await startAuthApp({
      getCase: (_req, res) => {
        seen = (res.locals as { identity?: Identity }).identity;
        res.json(VALID_CASE);
      },
    });
    const token = await app.issuer.mint({
      sub: 'jdoe',
      clientId: 'support-copilot',
      scopes: ['cases:read', 'cases:comment'],
      act: { sub: 'support-copilot-agent' },
    });
    expect((await getCase(app.url, `Bearer ${token}`)).status).toBe(200);
    expect(seen).toEqual({
      sub: 'jdoe',
      clientId: 'support-copilot',
      scopes: ['cases:read', 'cases:comment'],
      agent: 'support-copilot-agent',
    });
    const line = app.logs.lines().find((entry) => entry.route === '/v1/cases/{caseId}');
    expect(line?.agent).toBe('support-copilot-agent');
  });

  it('omits agent for a token without act', async () => {
    let seen: Identity | undefined;
    app = await startAuthApp({
      getCase: (_req, res) => {
        seen = (res.locals as { identity?: Identity }).identity;
        res.json(VALID_CASE);
      },
    });
    const token = await tokenFor(app.url, 'ipaas-flow');
    expect((await getCase(app.url, `Bearer ${token}`)).status).toBe(200);
    expect(seen).toEqual({ sub: 'ipaas-flow', clientId: 'ipaas-flow', scopes: ['cases:read'] });
  });
});
