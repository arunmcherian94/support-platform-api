import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Deadline } from '../adapters/deadline.js';

/** Per-request context, available anywhere in the call chain without passing it. */
export interface RequestContext {
  correlationId: string;
  /** W3C trace context, propagated to upstream calls. */
  traceparent: string;
  /** Time left for upstream calls in this request (S3 §2.3); set by deadlineMiddleware. */
  deadline?: Deadline;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
// version-traceid-parentid-flags; all-zero IDs are invalid per W3C Trace Context.
const TRACEPARENT = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

function newTraceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

/**
 * Accepts a well-formed inbound X-Request-Id or generates one; parses or
 * generates traceparent; echoes X-Request-Id on the response (S2-4).
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get('X-Request-Id');
  const correlationId = inbound !== undefined && REQUEST_ID.test(inbound) ? inbound : randomUUID();
  const inboundTrace = req.get('traceparent');
  const traceparent =
    inboundTrace !== undefined && TRACEPARENT.test(inboundTrace) ? inboundTrace : newTraceparent();
  res.set('X-Request-Id', correlationId);
  runWithContext({ correlationId, traceparent }, next);
}

/** Starts the request budget for upstream calls (S3 §2.3). Runs after correlationMiddleware. */
export function deadlineMiddleware(createDeadline: () => Deadline) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    const context = storage.getStore();
    if (context !== undefined) context.deadline = createDeadline();
    next();
  };
}
