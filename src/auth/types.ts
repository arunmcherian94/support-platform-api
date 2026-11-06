import type { RequestHandler } from 'express';
import type { AppError } from '../http/problems.js';
import type { RequestIdentity } from '../observability/logger.js';

/** The verified caller, set on `res.locals.identity` by the security handler. */
export interface Identity extends RequestIdentity {
  /** The user whose authority is used (token `sub`). */
  sub: string;
  /** The OAuth client that obtained the token (`client_id`). */
  clientId: string;
  scopes: string[];
  /** The agent acting for the user (`act.sub`), for delegated tokens. */
  agent?: string;
}

/**
 * Handler for the contract's `oauth2` security scheme, called by
 * express-openapi-validator with the operation's required scopes. Returns true
 * when the caller may proceed. On failure it sets `res.locals.authProblem`
 * (the validator rebuilds thrown errors, losing problem type and headers), then
 * throws or returns false.
 */
export type SecurityHandler = (
  req: Parameters<RequestHandler>[0],
  scopes: string[],
) => Promise<boolean>;

export interface AuthLocals {
  identity?: Identity;
  authProblem?: AppError;
}
