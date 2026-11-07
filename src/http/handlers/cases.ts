import type { RequestHandler } from 'express';
import type { ReadDeps } from './shared.js';

/** Placeholder replaced by listCases (slice D). */
export function listCasesHandler(_deps: ReadDeps): RequestHandler {
  return (_req, _res, next) => {
    next(new Error('operation not implemented'));
  };
}
