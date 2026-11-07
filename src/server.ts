import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createDevIssuer,
  devIssuerEnabled,
  loadDevClients,
  type DevIssuer,
} from './auth/dev-issuer.js';
import { createSecurityHandler } from './auth/security-handler.js';
import { createVerifier } from './auth/verify.js';
import { createUpstreams, type Upstreams } from './adapters/index.js';
import { systemClock, type Clock } from './clock.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createApp, type OperationHandlers } from './http/app.js';
import { createRateLimiter } from './http/rate-limit.js';
import { createLogger, type Logger } from './observability/logger.js';
import { openDatabase } from './store/db.js';
import { migrate } from './store/migrate.js';

export interface RunningServer {
  server: Server;
  url: string;
  db: DatabaseSync;
  /** The dev token issuer, when DEV_ISSUER=true (tests use it to mint tokens). */
  issuer?: DevIssuer;
  upstreams: Upstreams;
  /**
   * Reports not-ready, waits `config.shutdownReadinessDelayMs` so load balancers
   * stop routing here, then stops accepting connections, drains in-flight
   * requests and closes the database. Requests still running after
   * `drainTimeoutMs` are cut off.
   */
  shutdown(drainTimeoutMs?: number): Promise<void>;
}

export async function startServer(
  config: Config,
  logger: Logger,
  options: { handlers?: OperationHandlers; clock?: Clock } = {},
): Promise<RunningServer> {
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDatabase(config.dbPath);
  const applied = migrate(db);
  if (applied.length > 0) logger.info({ migrations: applied }, 'migrations applied');

  const clock = options.clock ?? systemClock();
  const upstreams = createUpstreams({ config, clock, logger });
  // First load, then polling, in the background: start-up neither waits for nor
  // requires it, so liveness answers even when the ERP hangs. Until the first
  // load succeeds, readiness reports the snapshot unavailable (S3 §2.2).
  void upstreams.entitlement.start();
  // Dev-only issuer, mounted only on request; config refuses it in production (S2-12).
  const issuer = devIssuerEnabled(config)
    ? await createDevIssuer({ config, clock, clients: loadDevClients() })
    : undefined;

  let draining = false;
  const app = createApp({
    config,
    isDraining: () => draining,
    clock,
    logger,
    db,
    upstreams,
    ...(issuer === undefined ? {} : { preValidation: [issuer.router] }),
    // Verified against the issuer's JWKS URL, as a production resource server would.
    securityHandler: createSecurityHandler(createVerifier({ config, clock }), {
      rateLimit: createRateLimiter({
        clock,
        clientPerMinute: config.rateLimit.clientPerMinute,
        agentPerMinute: config.rateLimit.agentPerMinute,
      }).check,
    }),
    ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
  });
  const server = await new Promise<Server>((resolve, reject) => {
    // Express 5 passes listen errors (e.g. EADDRINUSE) to the callback.
    const s = app.listen(config.port, (error) => {
      if (error) {
        upstreams.entitlement.stop();
        db.close();
        reject(error);
      } else resolve(s);
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  let closing: Promise<void> | undefined;
  const closeAndDrain = (drainTimeoutMs: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      logger.info('draining in-flight requests');
      const deadline = setTimeout(() => {
        logger.warn('drain deadline reached: closing remaining connections');
        server.closeAllConnections();
      }, drainTimeoutMs);
      deadline.unref();
      server.close((error) => {
        clearTimeout(deadline);
        db.close();
        logger.info('shutdown complete');
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    });
  const shutdown = (drainTimeoutMs = 10_000): Promise<void> => {
    draining = true;
    upstreams.entitlement.stop();
    closing ??= (async () => {
      logger.info(
        { readinessDelayMs: config.shutdownReadinessDelayMs },
        'shutting down: readiness now 503',
      );
      await new Promise((resolve) => setTimeout(resolve, config.shutdownReadinessDelayMs));
      await closeAndDrain(drainTimeoutMs);
    })();
    return closing;
  };
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    db,
    upstreams,
    ...(issuer === undefined ? {} : { issuer }),
    shutdown,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  const running = await startServer(config, logger);
  logger.info({ url: running.url, devIssuer: config.devIssuer }, 'platform API listening');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void running.shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}
