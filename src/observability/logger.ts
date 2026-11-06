import type { NextFunction, Request, Response } from 'express';
import { pino, type DestinationStream, type Logger } from 'pino';
import { currentContext } from './context.js';

export type { Logger };

const SECRET_FIELDS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api_key',
  'client_secret',
  'client_assertion',
  'assertion',
  'password',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
];
const SECRET_KEY = new RegExp(`^(${SECRET_FIELDS.join('|')})$`, 'i');

/** pino redaction paths: a first line of defence; `maskPersonalData` covers any depth and case. */
const REDACT_PATHS = SECRET_FIELDS.filter((field) => /^[a-z_]+$/.test(field)).flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
]);

/** Fields the platform sets itself: identifiers, never personal data, never masked. */
const OWN_FIELDS = new Set(['correlationId', 'traceparent', 'route', 'method', 'service']);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Candidate phone numbers, not embedded in a longer token (UUIDs, hex IDs, trace IDs):
// no word character or hyphen directly before or after. `maskPhone` decides.
const PHONE_CANDIDATE = /(?<![\w-])\+?\(?\d[\d\s().-]{7,}\d(?![\w-])/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, '').length;
  if (digits < 9 || ISO_DATE.test(match)) return match;
  // A leading + or separators make it phone-shaped; a bare run of digits may be an ID or count.
  return match.startsWith('+') || /[\s().-]/.test(match) ? '[phone]' : match;
}

function maskText(value: string): string {
  return value.replace(EMAIL, '[email]').replace(PHONE_CANDIDATE, maskPhone);
}

/**
 * Backstop for anything that reaches the logger: secret-named keys are redacted
 * at any depth and in any case, and emails and phone numbers are masked in free
 * text. Best-effort only: the primary rule is that bodies are never logged (S2 §2.3).
 */
export function maskPersonalData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskText(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => maskPersonalData(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      type: value.name,
      message: maskText(value.message),
      stack: value.stack === undefined ? undefined : maskText(value.stack),
      ...(value.cause === undefined ? {} : { cause: maskPersonalData(value.cause, depth + 1) }),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (SECRET_KEY.test(key)) return [key, '[redacted]'];
      if (depth === 0 && OWN_FIELDS.has(key)) return [key, item];
      return [key, maskPersonalData(item, depth + 1)];
    }),
  );
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'support-platform-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // Errors are serialised by maskPersonalData (masked message, stack and cause).
      serializers: { err: (error: unknown) => error },
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
