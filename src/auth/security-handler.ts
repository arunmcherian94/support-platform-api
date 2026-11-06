/**
 * The handler for the contract's `oauth2` scheme. express-openapi-validator
 * calls it with the operation's required scopes from openapi.yaml, so the
 * contract, not the code, says which scope each operation needs (S2-6).
 *
 * The validator rebuilds thrown errors from their `status` alone, so the real
 * problem (type, detail, WWW-Authenticate) is left on `res.locals.authProblem`
 * for the error handler.
 */
import type { Response } from 'express';
import { AppError } from '../http/problems.js';
import type { AuthLocals, SecurityHandler } from './types.js';
import { InvalidTokenError, IssuerUnavailableError, type Verifier } from './verify.js';

// RFC 6750 §2.1: b64token after one or more spaces; the scheme is case-insensitive.
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

function fail(res: Response, problem: AppError, status: number): never {
  (res.locals as AuthLocals).authProblem = problem;
  throw Object.assign(new Error(problem.problem), { status });
}

function unauthorized(res: Response, detail: string, challenge: string): never {
  fail(
    res,
    new AppError('unauthorized', detail, { headers: { 'WWW-Authenticate': challenge } }),
    401,
  );
}

export function createSecurityHandler(verifier: Verifier): SecurityHandler {
  return async (req, requiredScopes) => {
    const res = req.res;
    if (res === undefined) throw new Error('security handler called without a response');

    const header = req.get('authorization');
    // RFC 6750 §3.1: no credentials of this scheme → challenge without an error code.
    if (header === undefined || !/^bearer(\s|$)/i.test(header)) {
      unauthorized(res, 'A bearer token is required.', 'Bearer');
    }
    const token = BEARER.exec(header)?.[1];
    if (token === undefined) {
      unauthorized(
        res,
        'The Authorization header must be "Bearer <token>".',
        'Bearer error="invalid_token"',
      );
    }

    let identity;
    try {
      identity = await verifier.verify(token);
    } catch (error) {
      // Logged with the request (security monitoring), never sent to the client.
      (res.locals as AuthLocals).authFailure =
        error instanceof InvalidTokenError || error instanceof IssuerUnavailableError
          ? error.reason
          : 'unexpected';
      if (error instanceof IssuerUnavailableError) {
        fail(
          res,
          new AppError('upstream-unavailable', 'The identity provider is unavailable.', {
            headers: { 'Retry-After': '5' },
          }),
          503,
        );
      }
      // The verifier's reason stays server-side; clients get one generic message.
      unauthorized(
        res,
        'The access token is invalid or has expired.',
        'Bearer error="invalid_token"',
      );
    }

    // Set before the scope check, so a 403 is still logged with who was refused.
    (res.locals as AuthLocals).identity = identity;
    const missing = requiredScopes.filter((scope) => !identity.scopes.includes(scope));
    if (missing.length > 0) {
      const names = missing.join(', ');
      fail(
        res,
        new AppError(
          'insufficient-scope',
          `This operation requires the ${names} scope${missing.length > 1 ? 's' : ''}.`,
          {
            headers: {
              'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${requiredScopes.join(' ')}"`,
            },
          },
        ),
        403,
      );
    }
    return true;
  };
}
