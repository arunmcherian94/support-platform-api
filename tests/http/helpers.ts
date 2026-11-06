import { Writable } from 'node:stream';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixedClock } from '../../src/clock.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createApp, type OperationHandlers } from '../../src/http/app.js';
import { createLogger, type Logger } from '../../src/observability/logger.js';
import { openDatabase } from '../../src/store/db.js';

export const FIXTURE_NOW = '2026-11-06T12:00:00Z';

/** Collects pino output so tests can assert on log lines. */
export function captureLogs(): {
  logger: Logger;
  text: () => string;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger('info', stream);
  const text = (): string => chunks.join('');
  return {
    logger,
    text,
    lines: () =>
      text()
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export interface TestApp {
  url: string;
  logs: ReturnType<typeof captureLogs>;
  close(): Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', DB_PATH: ':memory:', ...overrides });
}

export async function startTestApp(
  options: { handlers?: OperationHandlers; env?: Record<string, string> } = {},
): Promise<TestApp> {
  const logs = captureLogs();
  const app = createApp({
    config: testConfig(options.env),
    clock: fixedClock(FIXTURE_NOW),
    logger: logs.logger,
    db: openDatabase(':memory:'),
    ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A case that satisfies the contract's `CaseDetail` schema. */
export const VALID_CASE = {
  id: 'CS-10231',
  accountId: 'ACC-007',
  account: { name: 'Acme Corp', supportTier: 'platinum', renewalDate: '2027-01-15' },
  subject: 'Backup failing on node 3',
  status: 'open',
  priority: 'P1',
  openedAt: '2026-10-24T08:12:00Z',
  escalation: null,
  comments: [],
  commentCount: 0,
};
