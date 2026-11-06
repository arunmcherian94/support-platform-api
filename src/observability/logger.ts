import type { NextFunction, Request, Response } from 'express';
import { pino, type DestinationStream, type Logger } from 'pino';
import { currentContext } from './context.js';

export type { Logger };

const SECRET_FIELDS = [
  'authorization',
  'cookie',
  'client_secret',
  'assertion',
  'password',
  'secret',
  'token',
  'access_token',
];

/** Redaction paths for secret fields at the top level and up to three levels deep. */
const REDACT_PATHS = SECRET_FIELDS.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
  `*.*.*.${field}`,
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// International or local phone numbers: an optional +, then 9+ digits with separators.
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;

/**
 * Backstop masking for personal data in free text that reaches the logger.
 * Best-effort only: the primary rule is that bodies are never logged (S2 §2.3).
 */
export function maskPersonalData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
  }
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => maskPersonalData(item, depth + 1));
  if (value instanceof Error) {
    return {
      type: value.name,
      message: maskPersonalData(value.message, depth + 1),
      stack: value.stack,
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, maskPersonalData(item, depth + 1)]),
  );
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'support-platform-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // Every line carries the request's correlation ID when there is one (S2-4).
      mixin: () => {
        const context = currentContext();
        return context === undefined ? {} : { correlationId: context.correlationId };
      },
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => maskPersonalData(object) as Record<string, unknown>,
      },
      hooks: {
        // Mask free-text messages too (the `log` formatter only sees the object).
        logMethod(args, method) {
          const masked = args.map((arg) => (typeof arg === 'string' ? maskPersonalData(arg) : arg));
          method.apply(this, masked as Parameters<typeof method>);
        },
      },
    },
    destination,
  );
}

/** Identity fields set by the auth layer (PR 4b), read here for request logs. */
export interface RequestIdentity {
  clientId?: string;
  sub?: string;
  agent?: string;
}

/**
 * One line per request with metadata only: method, route template, status,
 * latency and identity. Request and response bodies are never logged.
 */
export function requestLogMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    res.on('finish', () => {
      const identity = (res.locals.identity ?? {}) as RequestIdentity;
      const route = (req as Request & { openapi?: { openApiRoute?: string } }).openapi
        ?.openApiRoute;
      logger.info(
        {
          method: req.method,
          route: route ?? 'unmatched',
          status: res.statusCode,
          latencyMs: Math.round(performance.now() - started),
          clientId: identity.clientId,
          sub: identity.sub,
          agent: identity.agent,
        },
        'request completed',
      );
    });
    next();
  };
}
