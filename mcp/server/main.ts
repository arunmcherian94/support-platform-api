/**
 * Starts the MCP server over stdio (`make mcp`). stdout carries the protocol,
 * so logs go to stderr.
 *
 * Dev shortcut (S5 §2.3): the user's token comes from USER_TOKEN, one user per
 * process. Over Streamable HTTP each request would carry its own token instead.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { systemClock } from '../../src/clock.js';
import { createLogger } from '../../src/observability/logger.js';
import { openDatabase } from '../../src/store/db.js';
import { migrate } from '../../src/store/migrate.js';
import { ApiClient } from './api-client.js';
import { createMcpServer } from './tools.js';

export interface McpEnv {
  apiUrl: string;
  tokenUrl: string;
  userToken: string;
  agentClientId: string;
  agentClientSecret: string;
  dbPath: string;
}

export function readMcpEnv(env: NodeJS.ProcessEnv = process.env): McpEnv {
  const userToken = env.USER_TOKEN ?? '';
  if (userToken === '')
    throw new Error('USER_TOKEN is required: the token of the user the agent acts for');
  const apiUrl = (env.API_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
  return {
    apiUrl,
    tokenUrl: env.TOKEN_URL ?? `${apiUrl}/dev/oauth/token`,
    userToken,
    agentClientId: env.AGENT_CLIENT_ID ?? 'support-copilot',
    // The dev-only, deliberately public secret from config/dev-clients.json.
    agentClientSecret: env.AGENT_CLIENT_SECRET ?? 'dev-only-support-copilot-secret',
    dbPath: env.DB_PATH ?? 'data/platform.db',
  };
}

async function main(): Promise<void> {
  const env = readMcpEnv();
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info', process.stderr);
  const clock = systemClock();
  const db = openDatabase(env.dbPath);
  migrate(db);
  const api = new ApiClient({ ...env, clock });
  // Exchange once up front: a bad token or client secret stops start-up.
  const who = await api.identity();
  logger.info({ sub: who.sub, agent: who.agent, scopes: who.scopes }, 'mcp server ready');
  // Pending-action expiry uses real time, never the NOW anchor (see ToolDeps.wallClock).
  const server = createMcpServer({ api, db, clock, logger, wallClock: systemClock({}) });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `mcp server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
