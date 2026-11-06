import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { systemClock } from './clock.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createApp, type OperationHandlers } from './http/app.js';
import { createLogger, type Logger } from './observability/logger.js';
import { openDatabase } from './store/db.js';
import { migrate } from './store/migrate.js';

export interface RunningServer {
  server: Server;
  url: string;
  db: DatabaseSync;
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
  options: { handlers?: OperationHandlers } = {},
): Promise<RunningServer> {
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDatabase(config.dbPath);
  const applied = migrate(db);
  if (applied.length > 0) logger.info({ migrations: applied }, 'migrations applied');

  let draining = false;
  const app = createApp({
    config,
    isDraining: () => draining,
    clock: systemClock(),
    logger,
    db,
    ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
  });
  const server = await new Promise<Server>((resolve, reject) => {
    // Express 5 passes listen errors (e.g. EADDRINUSE) to the callback.
    const s = app.listen(config.port, (error) => {
      if (error) {
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
  return { server, url: `http://127.0.0.1:${port}`, db, shutdown };
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
