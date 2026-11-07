import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../../src/clock.js';
import { verifyWebhook, type VerifyResult } from '../../src/events/verify.js';
import { openDatabase } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';

export const NOW = '2026-11-06T12:00:00Z';
export const KEY = Buffer.alloc(32, 7);
export const SECRET = `whsec_${KEY.toString('base64')}`;

export function migratedDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}

export interface Received {
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  verdict: VerifyResult;
}

export interface TestReceiver {
  url: string;
  received: Received[];
  /** Status and body for the next requests (default 200, empty). */
  respond(status: number, body?: string, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

/**
 * A minimal webhook receiver: reads the raw body, runs `verifyWebhook` against the
 * shared clock and records the verdict. It dedupes accepted IDs like a real receiver.
 */
export async function startReceiver(clock: Clock, secret = SECRET): Promise<TestReceiver> {
  const received: Received[] = [];
  const processed = new Set<string>();
  let status = 200;
  let body = '';
  let extraHeaders: Record<string, string> = {};
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const id = header(req.headers, 'webhook-id');
      const verdict = verifyWebhook(
        {
          id,
          timestamp: header(req.headers, 'webhook-timestamp'),
          signature: header(req.headers, 'webhook-signature'),
          rawBody,
        },
        secret,
        clock.now(),
        processed,
      );
      // Like a real receiver, an ID counts as processed only once it was acknowledged.
      if (verdict.ok && id !== undefined && status >= 200 && status < 300) processed.add(id);
      received.push({ headers: req.headers, rawBody, verdict });
      res.writeHead(status, extraHeaders);
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/hooks`,
    received,
    respond(nextStatus, nextBody = '', headers = {}) {
      status = nextStatus;
      body = nextBody;
      extraHeaders = headers;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface DeliveryRow {
  id: string;
  subscription_id: string;
  payload: string;
  attempt: number;
  status: string;
  next_attempt_at: string | null;
  last_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
}

export function deliveryRow(db: DatabaseSync, id: string): DeliveryRow {
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id);
  if (row === undefined) throw new Error(`no delivery ${id}`);
  return row as unknown as DeliveryRow;
}

export function subscriptionRow(
  db: DatabaseSync,
  id = 'sub_default',
): { url: string; active: number; disabled_reason: string | null; secret_ref: string } {
  const row = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(id);
  if (row === undefined) throw new Error(`no subscription ${id}`);
  return row as unknown as {
    url: string;
    active: number;
    disabled_reason: string | null;
    secret_ref: string;
  };
}
