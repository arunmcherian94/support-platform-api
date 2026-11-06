/**
 * Access-token verification, done the way a production resource server does
 * it: keys from the issuer's JWKS URL, the algorithm pinned to RS256, and
 * iss, aud, exp and nbf checked against the injected clock with 30s tolerance.
 * Switching identity providers changes config (issuer URL, audience), not code.
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import type { LocalJWKSet, RemoteJWKSet } from 'jose';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { Identity } from './types.js';

export const CLOCK_TOLERANCE_SEC = 30;

/** The token is not acceptable. `reason` is for logs, never for clients. */
export class InvalidTokenError extends Error {
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`invalid token: ${reason}`, options);
    this.name = 'InvalidTokenError';
  }
}

/** The issuer's key set could not be fetched; the token was not judged. */
export class IssuerUnavailableError extends Error {
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`identity provider unavailable: ${reason}`, options);
    this.name = 'IssuerUnavailableError';
  }
}

export interface Verifier {
  verify(token: string): Promise<Identity>;
}

/**
 * Key-set failures come from the remote getter: a timeout, a network error
 * (not a JOSEError at all), a non-200 or unparsable response (ERR_JOSE_GENERIC)
 * or a body that is not a key set. Everything else is a verdict on the token.
 */
function isKeySetFailure(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) return true;
  return ['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC', 'ERR_JWKS_INVALID'].includes(error.code);
}

function toIdentity(payload: JWTPayload): Identity {
  const { sub, client_id: clientId, scope, act } = payload;
  if (typeof sub !== 'string' || sub === '') throw new InvalidTokenError('sub');
  if (typeof clientId !== 'string' || clientId === '') throw new InvalidTokenError('client_id');
  if (scope !== undefined && typeof scope !== 'string') throw new InvalidTokenError('scope');
  let agent: string | undefined;
  if (act !== undefined) {
    const actSub = typeof act === 'object' && act !== null && 'sub' in act ? act.sub : undefined;
    if (typeof actSub !== 'string' || actSub === '') throw new InvalidTokenError('act');
    // Delegation chains (an actor acting for an actor) aren't designed yet; refuse
    // them rather than record only the outer actor.
    if (typeof act === 'object' && act !== null && 'act' in act) {
      throw new InvalidTokenError('act-chain');
    }
    agent = actSub;
  }
  return {
    sub,
    clientId,
    scopes: (scope ?? '').split(' ').filter((item) => item !== ''),
    ...(agent === undefined ? {} : { agent }),
  };
}

export function createVerifier(deps: {
  config: Config;
  clock: Clock;
  /** Defaults to the issuer's JWKS URL; tests may pass `createLocalJWKSet(...)`. */
  jwks?: LocalJWKSet | RemoteJWKSet;
}): Verifier {
  const { config, clock } = deps;
  const keySet =
    deps.jwks ??
    createRemoteJWKSet(new URL(`${config.issuerUrl}/.well-known/jwks.json`), {
      // Keys are refetched hourly or on an unknown kid (rotation). An identity
      // provider outage shorter than an hour doesn't stop verification of tokens
      // signed with known keys; a longer one gives 503 (stale-on-error deferred).
      cacheMaxAge: 60 * 60 * 1000,
      timeoutDuration: 2000,
    });

  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keySet, {
          algorithms: ['RS256'],
          issuer: config.issuerUrl,
          audience: config.audience,
          currentDate: clock.now(),
          clockTolerance: CLOCK_TOLERANCE_SEC,
          requiredClaims: ['sub', 'exp', 'iat', 'client_id'],
        }));
      } catch (error) {
        if (isKeySetFailure(error)) {
          const code = error instanceof errors.JOSEError ? error.code : 'fetch-failed';
          throw new IssuerUnavailableError(code, { cause: error });
        }
        throw new InvalidTokenError((error as errors.JOSEError).code, { cause: error });
      }
      return toIdentity(payload);
    },
  };
}
