/**
 * DEV-ONLY token issuer. It stands in for a real identity provider so the API
 * can verify tokens exactly as a production resource server would (JWKS URL,
 * pinned algorithm, iss/aud/exp/nbf checks). It must never run in production:
 * the caller mounts the router only when `config.devIssuer` is true, and
 * config refuses DEV_ISSUER=true with NODE_ENV=production (S2-12).
 *
 * - An RS256 key pair is generated at start-up; keys live in memory only.
 * - `GET  /dev/.well-known/jwks.json` publishes the public key.
 * - `POST /dev/oauth/token` implements the client_credentials grant
 *   (RFC 6749 §4.4) for the fake clients in config/dev-clients.json.
 * - The authorization-code flow named in the contract is not built.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express, { type Request, type Response } from 'express';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';

export const TOKEN_LIFETIME_SEC = 900;
const REALM = 'dev-issuer';

export interface DevClient {
  clientId: string;
  secret: string;
  /** Fixed user for user simulation; defaults to the client id. */
  sub?: string;
  scopes: string[];
}

export interface MintOptions {
  sub: string;
  clientId: string;
  scopes: string[];
  /** The agent acting for `sub` (RFC 8693 `act` claim). */
  act?: { sub: string };
  expiresInSec?: number;
  /** Claims merged over the defaults (tests use this to craft bad tokens). */
  overrides?: JWTPayload;
}

export interface DevIssuer {
  router: express.Router;
  mint(options: MintOptions): Promise<string>;
  jwks: JSONWebKeySet;
}

/** True when the dev issuer may be mounted. Config already refuses it in production. */
export function devIssuerEnabled(config: Config): boolean {
  return config.devIssuer;
}

const DEFAULT_CLIENTS_FILE = new URL('../../config/dev-clients.json', import.meta.url);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');
}

/** Reads and validates the dev client list; a malformed file stops start-up. */
export function loadDevClients(file: URL | string = DEFAULT_CLIENTS_FILE): DevClient[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = (parsed as { clients?: unknown } | null)?.clients;
  if (!Array.isArray(list)) throw new Error('dev clients file: "clients" must be an array');
  const seen = new Set<string>();
  return list.map((entry: unknown, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const { clientId, secret, sub, scopes } = item;
    if (typeof clientId !== 'string' || clientId === '' || seen.has(clientId)) {
      throw new Error(`dev clients file: clients[${index}].clientId must be a unique string`);
    }
    if (typeof secret !== 'string' || secret === '') {
      throw new Error(`dev clients file: clients[${index}].secret must be a string`);
    }
    if (sub !== undefined && (typeof sub !== 'string' || sub === '')) {
      throw new Error(`dev clients file: clients[${index}].sub must be a string`);
    }
    if (!isStringArray(scopes)) {
      throw new Error(`dev clients file: clients[${index}].scopes must be an array of strings`);
    }
    seen.add(clientId);
    return { clientId, secret, scopes, ...(sub === undefined ? {} : { sub }) };
  });
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time secret check. Comparing SHA-256 digests gives equal-length
 * buffers, so neither the content nor the length of the secret leaks via timing.
 */
function secretMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

class OAuthError extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly code:
      'invalid_request' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_scope',
    readonly description: string,
  ) {
    super(description);
  }
}

/** RFC 6749 §2.3.1: Basic credentials are form-urlencoded before base64. */
function parseBasic(header: string): { id: string; secret: string } {
  const match = /^Basic +([A-Za-z0-9+/]+=*)$/i.exec(header);
  if (match?.[1] === undefined) {
    throw new OAuthError(401, 'invalid_client', 'Client authentication failed.');
  }
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) throw new OAuthError(401, 'invalid_client', 'Client authentication failed.');
  try {
    const unescape = (part: string): string => decodeURIComponent(part.replace(/\+/g, ' '));
    return { id: unescape(decoded.slice(0, colon)), secret: unescape(decoded.slice(colon + 1)) };
  } catch {
    throw new OAuthError(401, 'invalid_client', 'Client authentication failed.');
  }
}

/** A single string form parameter; repeats are malformed (RFC 6749 §3.1). */
function param(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new OAuthError(400, 'invalid_request', `The ${name} parameter must appear once.`);
  }
  return value;
}

export async function createDevIssuer(deps: {
  config: Config;
  clock: Clock;
  clients: DevClient[];
}): Promise<DevIssuer> {
  const { config, clock } = deps;
  const clients = new Map(deps.clients.map((client) => [client.clientId, client]));
  const kid = randomUUID();
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }],
  };
  // Compared against when the client id is unknown, so both paths cost the same.
  const unknownClientSecret = randomUUID();

  async function mint(options: MintOptions): Promise<string> {
    // iat/exp come from the injected clock; jose's relative setters would read the system time.
    const iat = Math.floor(clock.now().getTime() / 1000);
    const payload: JWTPayload = {
      iss: config.issuerUrl,
      aud: config.audience,
      sub: options.sub,
      client_id: options.clientId,
      scope: options.scopes.join(' '),
      iat,
      exp: iat + (options.expiresInSec ?? TOKEN_LIFETIME_SEC),
      jti: randomUUID(),
      ...(options.act === undefined ? {} : { act: { sub: options.act.sub } }),
      ...options.overrides,
    };
    return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).sign(privateKey);
  }

  function authenticate(req: Request, body: Record<string, unknown>): DevClient {
    const header = req.get('authorization');
    const formId = param(body, 'client_id');
    const formSecret = param(body, 'client_secret');
    let credentials: { id: string; secret: string };
    if (header !== undefined) {
      if (formSecret !== undefined) {
        throw new OAuthError(400, 'invalid_request', 'Use one client authentication method.');
      }
      credentials = parseBasic(header);
      if (formId !== undefined && formId !== credentials.id) {
        throw new OAuthError(400, 'invalid_request', 'client_id does not match the credentials.');
      }
    } else if (formId !== undefined && formSecret !== undefined) {
      credentials = { id: formId, secret: formSecret };
    } else {
      throw new OAuthError(401, 'invalid_client', 'Client authentication is required.');
    }
    const client = clients.get(credentials.id);
    const matches = secretMatches(credentials.secret, client?.secret ?? unknownClientSecret);
    if (client === undefined || !matches) {
      throw new OAuthError(401, 'invalid_client', 'Client authentication failed.');
    }
    return client;
  }

  function grantedScopes(client: DevClient, requested: string | undefined): string[] {
    if (requested === undefined) return client.scopes;
    const scopes = [...new Set(requested.split(' ').filter((scope) => scope !== ''))];
    if (scopes.length === 0 || scopes.some((scope) => !client.scopes.includes(scope))) {
      throw new OAuthError(400, 'invalid_scope', 'The requested scope is not allowed.');
    }
    return scopes;
  }

  async function token(req: Request, res: Response): Promise<void> {
    // RFC 6749 §5.1: token responses must not be cached.
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    try {
      if (!req.is('application/x-www-form-urlencoded')) {
        throw new OAuthError(400, 'invalid_request', 'Use application/x-www-form-urlencoded.');
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grantType = param(body, 'grant_type');
      if (grantType === undefined) {
        throw new OAuthError(400, 'invalid_request', 'grant_type is required.');
      }
      if (grantType !== 'client_credentials') {
        throw new OAuthError(
          400,
          'unsupported_grant_type',
          'Only client_credentials is supported.',
        );
      }
      const client = authenticate(req, body);
      const scopes = grantedScopes(client, param(body, 'scope'));
      const accessToken = await mint({
        sub: client.sub ?? client.clientId,
        clientId: client.clientId,
        scopes,
      });
      // The request log then records which client obtained a token (never the secret).
      res.locals.identity = { clientId: client.clientId, sub: client.sub ?? client.clientId };
      res.status(200).json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_LIFETIME_SEC,
        scope: scopes.join(' '),
      });
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.status === 401) res.set('WWW-Authenticate', `Basic realm="${REALM}"`);
      res.status(error.status).json({ error: error.code, error_description: error.description });
    }
  }

  const router = express.Router();
  router.get('/dev/.well-known/jwks.json', (_req, res) => {
    res.json(jwks);
  });
  router.post('/dev/oauth/token', token);
  return { router, mint, jwks };
}
