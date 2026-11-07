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
 * Query values after validation. The validator restores Express's raw query
 * object after checking it, so values are strings (or string arrays when a
 * parameter repeats) and must be converted here. They already passed the
 * contract's schema, so conversion can't fail on valid input.
 */
export function queryList(req: Request, name: string): string[] | undefined {
  const value: unknown = (req.query as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  const items: unknown[] = Array.isArray(value) ? value : [value];
  return items.filter((item): item is string => typeof item === 'string');
}

export function queryString(req: Request, name: string): string | undefined {
  return queryList(req, name)?.[0];
}

export function queryInt(req: Request, name: string): number | undefined {
  const value = queryString(req, name);
  return value === undefined ? undefined : Number.parseInt(value, 10);
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
