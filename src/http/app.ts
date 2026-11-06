import express, { type Express, type RequestHandler } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { correlationMiddleware } from '../observability/context.js';
import { requestLogMiddleware, type Logger } from '../observability/logger.js';
import { healthHandlers } from './health.js';
import { AppError, errorHandler } from './problems.js';

export const API_SPEC_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

/** Operation handlers keyed by `operationId` from openapi.yaml. */
export type OperationHandlers = Partial<Record<string, RequestHandler>>;

export interface AppDeps {
  config: Config;
  clock: Clock;
  logger: Logger;
  db: DatabaseSync;
  handlers?: OperationHandlers;
  /** Routes mounted before the validator (e.g. the dev token issuer). */
  preValidation?: express.Router[];
}

interface OpenApiRequest {
  openapi?: { schema?: { operationId?: string } };
}

/**
 * The HTTP pipeline. Order matters:
 * correlation → request log → body parsing → pre-validation routes →
 * contract validation (requests, responses, security) → operation handlers → errors.
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const handlers: OperationHandlers = { ...healthHandlers(deps.db), ...deps.handlers };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(correlationMiddleware);
  app.use(requestLogMiddleware(logger));
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  for (const router of deps.preValidation ?? []) app.use(router);

  app.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: { allowUnknownQueryParameters: false },
      validateResponses:
        config.responseValidation === 'strict'
          ? true
          : {
              onError: (error, _body, req) => {
                logger.warn(
                  { err: error, route: req.path },
                  'response violates the contract (log mode)',
                );
              },
            },
      validateSecurity: false, // enabled with token verification (PR 4b)
      validateFormats: true,
      ajvFormats: { mode: 'full' },
    }),
  );

  app.use((req, res, next) => {
    const operationId = (req as unknown as OpenApiRequest).openapi?.schema?.operationId;
    const handler = operationId === undefined ? undefined : handlers[operationId];
    if (handler === undefined) {
      // No 501 in the contract; 500 is declared on every operation. Replaced as
      // operations are implemented.
      next(new Error(`operation not implemented: ${operationId ?? 'unknown'}`));
      return;
    }
    return handler(req, res, next);
  });

  app.use(errorHandler(logger));
  return app;
}

export { AppError };
