import type { RequestHandler } from 'express';
import type { ReadDeps } from './shared.js';

/** Placeholder replaced by getCustomer (slice E). */
export function getCustomerHandler(_deps: ReadDeps): RequestHandler {
  return (_req, _res, next) => {
    next(new Error('operation not implemented'));
  };
}
