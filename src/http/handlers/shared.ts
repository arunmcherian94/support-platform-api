import type { Request, Response } from 'express';
import type { Upstreams } from '../../adapters/index.js';
import { toAppError, UpstreamError } from '../../adapters/errors.js';
import type { Identity } from '../../auth/types.js';
import type { Clock } from '../../clock.js';
import type { Logger } from '../../observability/logger.js';
import { AppError } from '../problems.js';

/** What every read handler needs. */
export interface ReadDeps {
  upstreams: Upstreams;
  clock: Clock;
  logger: Logger;
}

interface OpenApiRequest {
  openapi?: { pathParams?: Record<string, string> };
}

/**
 * A path parameter as validated by the contract. Handlers run from a
 * catch-all dispatcher, so `req.params` is empty; the validator puts path
 * parameters on `req.openapi.pathParams`.
 */
export function pathParam(req: Request, name: string): string {
  const value = (req as unknown as OpenApiRequest).openapi?.pathParams?.[name];
  if (value === undefined) throw new Error(`missing path parameter: ${name}`);
  return value;
}

/**
 * Query values after validation. The validator coerces them to the contract's
 * types (integers become numbers, defaults are filled in, a repeated
 * parameter is an array), so these helpers accept the coerced value and, for
 * safety, its string form. A value of the wrong type after validation is a
 * server bug and throws, rather than reading as absent: a dropped filter
 * would silently widen a search.
 */
function rawQuery(req: Request, name: string): unknown {
  return (req.query as Record<string, unknown>)[name];
}

export function queryList(req: Request, name: string): string[] | undefined {
  const value = rawQuery(req, name);
  if (value === undefined) return undefined;
  const items: unknown[] = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item === 'number') return String(item);
    throw new Error(`query parameter ${name} has an unexpected type after validation`);
  });
}

export function queryString(req: Request, name: string): string | undefined {
  return queryList(req, name)?.[0];
}

export function queryInt(req: Request, name: string): number | undefined {
  const value = rawQuery(req, name);
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new Error(`query parameter ${name} is not an integer after validation`);
  }
  return parsed;
}

/** The verified caller. Every read operation requires a token, so absence is a server bug. */
export function identityOf(res: Response): Identity {
  const identity = (res.locals as { identity?: Identity }).identity;
  if (identity === undefined) throw new Error('no verified identity on an authenticated route');
  return identity;
}

/** Maps a required upstream's failure to its problem; other errors pass through unchanged. */
export function upstreamProblem(error: unknown): unknown {
  return error instanceof UpstreamError ? toAppError(error) : error;
}

export const entitlementStale = (): AppError =>
  new AppError('entitlement-stale', 'Entitlement data is unavailable or older than 48 hours.');
