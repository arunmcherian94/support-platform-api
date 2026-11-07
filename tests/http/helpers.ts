import { Writable } from 'node:stream';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixedClock } from '../../src/clock.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createApp, type OperationHandlers } from '../../src/http/app.js';
import { createLogger, type Logger } from '../../src/observability/logger.js';
import type { RunningServer } from '../../src/server.js';
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

/** A free TCP port. The issuer URL embeds the port, so it must be known before start-up. */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/** Starts the real server with the dev issuer, plus a bearer header with every scope. */
export async function startServerWithAuth(
  logger: Logger,
  options: {
    handlers?: OperationHandlers;
    env?: Record<string, string>;
    clock?: import('../../src/clock.js').Clock;
  } = {},
): Promise<{ running: RunningServer; auth: { authorization: string } }> {
  const { startServer } = await import('../../src/server.js');
  const port = String(await freePort());
  const running = await startServer(
    testConfig({ PORT: port, DEV_ISSUER: 'true', ...options.env }),
    logger,
    {
      ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    },
  );
  if (running.issuer === undefined) throw new Error('dev issuer not mounted');
  const token = await running.issuer.mint({
    sub: 'jdoe',
    clientId: 'support-console',
    scopes: ['customers:read', 'cases:read', 'cases:comment', 'cases:escalate'],
  });
  return { running, auth: { authorization: `Bearer ${token}` } };
}

/** Mock upstreams for a real-server test, recording the headers of every upstream request. */
export async function startRecordingMocks(): Promise<{
  url: string;
  mock: import('../../mocks/server.js').MockApp;
  seen: { path: string; headers: Record<string, string | string[] | undefined> }[];
  close(): Promise<void>;
}> {
  const express = (await import('express')).default;
  const { createMockApp } = await import('../../mocks/server.js');
  const mock = createMockApp({ clock: fixedClock(FIXTURE_NOW) });
  const seen: { path: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const app = express();
  app.use((req, _res, next) => {
    seen.push({ path: req.path, headers: { ...req.headers } });
    next();
  });
  app.use(mock.app);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => {
      resolve(s);
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    mock,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Polls /readyz until it answers 200 (the entitlement snapshot loads in the background). */
export async function waitForReady(url: string, timeoutMs = 5000): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if ((await fetch(`${url}/readyz`)).status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`not ready after ${String(timeoutMs)} ms`);
}
