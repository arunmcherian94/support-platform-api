import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';
import { createSecurityHandler } from '../../src/auth/security-handler.js';
import type { AuthLocals, Identity } from '../../src/auth/types.js';
import {
  createVerifier,
  InvalidTokenError,
  IssuerUnavailableError,
  type Verifier,
} from '../../src/auth/verify.js';
import { AppError } from '../../src/http/problems.js';
import { FIXTURE_NOW } from '../http/helpers.js';

const config = loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:' });
const clock = fixedClock(FIXTURE_NOW);
const iat = Math.floor(Date.parse(FIXTURE_NOW) / 1000);
const claims = {
  iss: config.issuerUrl,
  aud: config.audience,
  sub: 'jdoe',
  client_id: 'support-console',
  scope: 'cases:read',
  iat,
  exp: iat + 900,
};

describe('verifier', () => {
  it('pins RS256 even when the key set does not name an algorithm', async () => {
    // Many identity providers publish JWKS entries without `alg`; then only the
    // verifier's own allow-list stops a token in another RSA algorithm.
    const { privateKey, publicKey } = await generateKeyPair('PS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1' };
    const verifier = createVerifier({ config, clock, jwks: createLocalJWKSet({ keys: [jwk] }) });
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'PS256', kid: 'k1' })
      .sign(privateKey);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('maps a verified token to an Identity', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1' };
    const verifier = createVerifier({ config, clock, jwks: createLocalJWKSet({ keys: [jwk] }) });
    const token = await new SignJWT({ ...claims, scope: undefined, act: { sub: 'copilot' } })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(privateKey);
    await expect(verifier.verify(token)).resolves.toEqual({
      sub: 'jdoe',
      clientId: 'support-console',
      scopes: [],
      agent: 'copilot',
    });
  });

  it('reports an unreachable key set as IssuerUnavailableError, not a bad token', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    const offline = loadConfig({
      NODE_ENV: 'test',
      ISSUER_URL: `http://127.0.0.1:${port}/dev`,
    });
    const verifier = createVerifier({ config: offline, clock });
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ ...claims, iss: offline.issuerUrl })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(privateKey);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(IssuerUnavailableError);
  });
});

function fakeRequest(authorization: string | undefined): { req: Request; locals: AuthLocals } {
  const locals: AuthLocals = {};
  const req = {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
    res: { locals },
  } as unknown as Request;
  return { req, locals };
}

const verifierReturning = (identity: Identity): Verifier => ({
  verify: () => Promise.resolve(identity),
});

describe('security handler', () => {
  it('requires every scope the operation lists', async () => {
    const handler = createSecurityHandler(
      verifierReturning({ sub: 'jdoe', clientId: 'c', scopes: ['cases:read'] }),
    );
    const { req, locals } = fakeRequest('Bearer abc');
    await expect(handler(req, ['cases:read', 'cases:comment'])).rejects.toMatchObject({
      status: 403,
    });
    expect(locals.authProblem?.problem).toBe('insufficient-scope');
    expect(locals.authProblem?.detail).toBe('This operation requires the cases:comment scope.');
    expect(locals.authProblem?.options.headers?.['WWW-Authenticate']).toBe(
      'Bearer error="insufficient_scope", scope="cases:read cases:comment"',
    );
    expect(locals.identity?.sub).toBe('jdoe');
  });

  it('accepts a valid token for an operation with no scopes', async () => {
    const identity = { sub: 'jdoe', clientId: 'c', scopes: [] };
    const handler = createSecurityHandler(verifierReturning(identity));
    const { req, locals } = fakeRequest('Bearer abc');
    await expect(handler(req, [])).resolves.toBe(true);
    expect(locals.identity).toEqual(identity);
    expect(locals.authProblem).toBeUndefined();
  });

  it('turns an unavailable identity provider into a 503 upstream-unavailable', async () => {
    const handler = createSecurityHandler({
      verify: () => Promise.reject(new IssuerUnavailableError('ERR_JWKS_TIMEOUT')),
    });
    const { req, locals } = fakeRequest('Bearer abc');
    await expect(handler(req, ['cases:read'])).rejects.toMatchObject({ status: 503 });
    expect(locals.authProblem).toBeInstanceOf(AppError);
    expect(locals.authProblem?.problem).toBe('upstream-unavailable');
    expect(locals.authProblem?.detail).toBe('The identity provider is unavailable.');
    expect(locals.authProblem?.options.headers).toEqual({ 'Retry-After': '5' });
    expect(locals.identity).toBeUndefined();
  });

  it('turns any other verifier failure into 401 without the reason', async () => {
    const handler = createSecurityHandler({
      verify: () => Promise.reject(new InvalidTokenError('ERR_JWT_EXPIRED')),
    });
    const { req, locals } = fakeRequest('Bearer abc');
    await expect(handler(req, [])).rejects.toMatchObject({ status: 401 });
    expect(locals.authProblem?.problem).toBe('unauthorized');
    expect(locals.authProblem?.detail).not.toContain('ERR_');
  });
});
