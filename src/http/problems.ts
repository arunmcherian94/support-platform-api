import type { NextFunction, Request, Response } from 'express';
import { currentContext } from '../observability/context.js';
import type { Logger } from '../observability/logger.js';

const BASE = 'https://support-platform.example/problems/';

/** Problem types from openapi.yaml (ADR-0005); the contract's enum is the source of truth. */
export const PROBLEMS = {
  'validation-failed': { status: 400, title: 'The request is invalid' },
  'invalid-cursor': { status: 400, title: 'The cursor is not valid for this request' },
  'idempotency-key-required': { status: 400, title: 'An Idempotency-Key header is required' },
  unauthorized: { status: 401, title: 'Authentication is required' },
  'insufficient-scope': { status: 403, title: 'The token lacks a required scope' },
  'not-found': { status: 404, title: 'Not found' },
  'request-in-progress': { status: 409, title: 'A request with this key is in progress' },
  'invalid-state': { status: 409, title: 'The case cannot be escalated in its current state' },
  'precondition-failed': { status: 412, title: 'The case has changed' },
  'idempotency-key-reused': {
    status: 422,
    title: 'This Idempotency-Key was used for a different request',
  },
  'escalation-not-allowed': { status: 422, title: 'Escalation is not allowed for this case' },
  'precondition-required': { status: 428, title: 'If-Match is required' },
  'rate-limited': { status: 429, title: 'Too many requests' },
  'internal-error': { status: 500, title: 'Internal error' },
  'upstream-error': { status: 502, title: 'An upstream system failed' },
  'upstream-unavailable': { status: 503, title: 'A required upstream system is unavailable' },
  'entitlement-stale': { status: 503, title: 'Entitlement data is unavailable' },
  'upstream-timeout': { status: 504, title: 'An upstream system timed out' },
} as const;

export type ProblemType = keyof typeof PROBLEMS;

export interface FieldError {
  pointer: string;
  detail: string;
}

/** An error that becomes a specific problem response. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly problem: ProblemType,
    readonly detail?: string,
    readonly options: {
      errors?: FieldError[];
      headers?: Record<string, string>;
      extensions?: Record<string, unknown>;
    } = {},
  ) {
    super(detail ?? PROBLEMS[problem].title);
    this.name = 'AppError';
    this.status = PROBLEMS[problem].status;
  }
}

interface ValidatorError {
  status: number;
  path?: string;
  errors?: { path: string; message: string }[];
}

function isValidatorError(error: unknown): error is ValidatorError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number' &&
    Array.isArray((error as { errors?: unknown }).errors)
  );
}

/**
 * Validator paths look like `/query/limit` or `/body/reason`; we report JSON
 * pointers prefixed with `#`. Messages describe the rule, never the input.
 */
function toFieldErrors(error: ValidatorError): FieldError[] {
  return (error.errors ?? []).map((item) => ({
    pointer: `#${item.path.replace(/^\./, '/').replace(/\./g, '/')}`,
    detail: item.message,
  }));
}

function sendProblem(req: Request, res: Response, error: AppError): void {
  const definition = PROBLEMS[error.problem];
  const body: Record<string, unknown> = {
    type: `${BASE}${error.problem}`,
    title: definition.title,
    status: definition.status,
    detail: error.detail ?? definition.title,
    instance: req.originalUrl.split('?')[0],
    correlationId: currentContext()?.correlationId ?? 'unknown',
    ...(error.options.errors === undefined ? {} : { errors: error.options.errors }),
    ...error.options.extensions,
  };
  res.set(error.options.headers ?? {});
  res.status(definition.status).type('application/problem+json').json(body);
}

/** Maps every error to an RFC 9457 problem (S2-3). Unknown errors never leak details. */
export function errorHandler(logger: Logger) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof AppError) {
      if (error.status >= 500)
        logger.error({ err: error, problem: error.problem }, 'request failed');
      sendProblem(req, res, error);
      return;
    }
    if (isValidatorError(error) && error.status === 400) {
      sendProblem(
        req,
        res,
        new AppError(
          'validation-failed',
          `${String(error.errors?.length ?? 0)} field(s) failed validation.`,
          {
            errors: toFieldErrors(error),
          },
        ),
      );
      return;
    }
    if (isValidatorError(error) && (error.status === 404 || error.status === 405)) {
      // Routes and methods outside the contract.
      sendProblem(req, res, new AppError('not-found', 'No such resource or method.'));
      return;
    }
    if (isValidatorError(error) && error.status === 415) {
      sendProblem(req, res, new AppError('validation-failed', 'Unsupported content type.'));
      return;
    }
    // Includes response-contract violations in strict mode: logged, never echoed.
    logger.error({ err: error }, 'unhandled error');
    sendProblem(
      req,
      res,
      new AppError(
        'internal-error',
        'The request failed unexpectedly. Quote the correlation ID when reporting it.',
      ),
    );
  };
}
