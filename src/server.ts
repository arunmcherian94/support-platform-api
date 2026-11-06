import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from './clock.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createApp } from './http/app.js';
import { createLogger, type Logger } from './observability/logger.js';
import { openDatabase } from './store/db.js';
import { migrate } from './store/migrate.js';

export interface RunningServer {
  server: Server;
  url: string;
  /** Stops accepting connections, drains in-flight requests, closes the database. */
  shutdown(): Promise<void>;
}

export async function startServer(config: Config, logger: Logger): Promise<RunningServer> {
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDatabase(config.dbPath);
  const applied = migrate(db);
  if (applied.length > 0) logger.info({ migrations: applied }, 'migrations applied');

  const app = createApp({ config, clock: systemClock(), logger, db });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(config.port, () => {
      resolve(s);
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      logger.info('shutting down: draining in-flight requests');
      server.close((error) => {
        db.close();
        logger.info('shutdown complete');
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    });
    return closing;
  };
  return { server, url: `http://127.0.0.1:${port}`, shutdown };
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
