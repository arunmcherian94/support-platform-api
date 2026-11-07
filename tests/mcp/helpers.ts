/**
 * An MCP client wired in-process to the server, which calls the real API
 * (dev issuer, contract validation) in front of the mock upstreams.
 */
import type { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { fixedClock, type Clock, type TestClock } from '../../src/clock.js';
import type { RunningServer } from '../../src/server.js';
import { ApiClient } from '../../mcp/server/api-client.js';
import { createMcpServer } from '../../mcp/server/tools.js';
import { migratedDb } from '../events/helpers.js';
import {
  captureLogs,
  FIXTURE_NOW,
  startRecordingMocks,
  startServerWithAuth,
  waitForReady,
} from '../http/helpers.js';

export const ALL_USER_SCOPES = ['customers:read', 'cases:read', 'cases:comment', 'cases:escalate'];

export interface Harness {
  client: Client;
  running: RunningServer;
  /** The MCP side's store (audit rows, pending actions). */
  db: DatabaseSync;
  clock: TestClock;
  userToken(sub: string, scopes: string[], clientId?: string): Promise<string>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  close(): Promise<void>;
}

export interface ToolCall {
  isError: boolean;
  data: Record<string, unknown>;
}

export async function startHarness(
  options: {
    sub?: string;
    scopes?: string[];
    env?: Record<string, string>;
    sessionCallLimit?: number;
    maxResponseBytes?: number;
    wallClock?: Clock;
  } = {},
): Promise<Harness> {
  const mocks = await startRecordingMocks();
  const clock = fixedClock(FIXTURE_NOW);
  const { running } = await startServerWithAuth(captureLogs().logger, {
    env: { MOCKS_URL: mocks.url, ...options.env },
    clock,
  });
  await waitForReady(running.url);
  const issuer = running.issuer;
  if (issuer === undefined) throw new Error('dev issuer not mounted');
  const userToken = (sub: string, scopes: string[], clientId = 'support-console') =>
    issuer.mint({ sub, clientId, scopes });

  const db = migratedDb();
  const api = new ApiClient({
    apiUrl: running.url,
    tokenUrl: `${running.url}/dev/oauth/token`,
    userToken: await userToken(options.sub ?? 'jdoe', options.scopes ?? ALL_USER_SCOPES),
    agentClientId: 'support-copilot',
    agentClientSecret: 'dev-only-support-copilot-secret',
    clock,
  });
  const server = createMcpServer({
    api,
    db,
    clock,
    logger: captureLogs().logger,
    ...(options.sessionCallLimit === undefined
      ? {}
      : { sessionCallLimit: options.sessionCallLimit }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.wallClock === undefined ? {} : { wallClock: options.wallClock }),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(clientSide);

  return {
    client,
    running,
    db,
    clock,
    userToken,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const first = result.content[0];
      const text = first !== undefined && first.type === 'text' ? first.text : '{}';
      return {
        isError: result.isError === true,
        data: (result.structuredContent ?? JSON.parse(text)) as Record<string, unknown>,
      };
    },
    async close() {
      await client.close();
      await server.close();
      await running.shutdown();
      await mocks.close();
    },
  };
}

export interface AuditRecord {
  actor_sub: string;
  actor_agent: string | null;
  actor_client: string;
  action: string;
  resource_id: string;
  args_redacted: string | null;
  outcome: string;
  correlation_id: string;
}

export function auditRows(db: DatabaseSync): AuditRecord[] {
  return db.prepare('SELECT * FROM audit_log ORDER BY id').all() as unknown as AuditRecord[];
}
