/**
 * Configuration from the environment, validated once at start-up (S2-9).
 * A bad value stops the process with a message naming the variable.
 */
export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  dbPath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Strict: a response violating the contract becomes a 500. Log: logged and sent. */
  responseValidation: 'strict' | 'log';
  /** Mounts the dev token issuer (dev-only; refused in production). */
  devIssuer: boolean;
  issuerUrl: string;
  audience: string;
  upstreams: { cases: string; entitlement: string; warehouse: string };
  rateLimit: { clientPerMinute: number; agentPerMinute: number };
  /** On shutdown, how long readiness reports 503 before the listener closes. */
  shutdownReadinessDelayMs: number;
  /** Total time for one request's upstream calls, retries included (S3 §2.3). */
  requestBudgetMs: number;
  /** How often the entitlement feeds are polled (ADR-0003). */
  entitlementRefreshSeconds: number;
  /** The single case.escalated subscription, if any (S4 §2.2). */
  webhook?: { url: string; secret: string };
  webhookDispatchIntervalMs: number;
}

export class ConfigError extends Error {
  constructor(variable: string, problem: string) {
    super(`Invalid configuration: ${variable} ${problem}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === '' ? fallback : value;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const value = read(env, name, fallback);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(name, `must be one of ${allowed.join(', ')} (got "${value}")`);
  }
  return value as T;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name, String(fallback));
  if (!/^\d+$/.test(raw)) throw new ConfigError(name, `must be an integer (got "${raw}")`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ConfigError(name, `must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = read(env, name, String(fallback));
  if (raw !== 'true' && raw !== 'false') {
    throw new ConfigError(name, `must be true or false (got "${raw}")`);
  }
  return raw === 'true';
}

function url(env: Env, name: string, fallback: string): string {
  const raw = read(env, name, fallback);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new ConfigError(name, `must be an http(s) URL (got "${raw}")`);
  }
  return raw.replace(/\/$/, '');
}

export function loadConfig(env: Env = process.env): Config {
  const nodeEnv = oneOf(env, 'NODE_ENV', ['development', 'test', 'production'], 'development');
  const devIssuer = bool(env, 'DEV_ISSUER', false);
  if (devIssuer && nodeEnv === 'production') {
    throw new ConfigError('DEV_ISSUER', 'must not be true when NODE_ENV=production');
  }
  // 0 asks the OS for a free port (tests).
  const port = integer(env, 'PORT', 8080, 0, 65535);
  const mocks = url(env, 'MOCKS_URL', 'http://127.0.0.1:8081');
  const now = env.NOW;
  if (now !== undefined && now !== '' && Number.isNaN(Date.parse(now))) {
    throw new ConfigError('NOW', `must be an RFC 3339 timestamp (got "${now}")`);
  }
  if (devIssuer && port === 0 && read(env, 'ISSUER_URL', '') === '') {
    // The default issuer URL embeds the port; with an OS-chosen port it can't be known.
    throw new ConfigError('ISSUER_URL', 'is required when DEV_ISSUER=true and PORT=0');
  }
  if (nodeEnv === 'production') {
    // No silent fallback to a local issuer: production must name its identity provider.
    for (const name of ['ISSUER_URL', 'AUDIENCE']) {
      if (read(env, name, '') === '')
        throw new ConfigError(name, 'is required when NODE_ENV=production');
    }
  }
  const webhookUrl = read(env, 'WEBHOOK_URL', '');
  let webhook: { url: string; secret: string } | undefined;
  if (webhookUrl !== '') {
    const secret = read(env, 'WEBHOOK_SECRET', '');
    // Standard Webhooks secret: whsec_ + base64 of at least 24 bytes.
    const match = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret);
    if (match?.[1] === undefined || Buffer.from(match[1], 'base64').length < 24) {
      throw new ConfigError(
        'WEBHOOK_SECRET',
        'must be whsec_ + base64 (24+ bytes) when WEBHOOK_URL is set',
      );
    }
    webhook = { url: url(env, 'WEBHOOK_URL', webhookUrl), secret };
  }
  return {
    nodeEnv,
    port,
    dbPath: read(env, 'DB_PATH', 'data/platform.db'),
    logLevel: oneOf(
      env,
      'LOG_LEVEL',
      ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      'info',
    ),
    responseValidation: oneOf(env, 'RESPONSE_VALIDATION', ['strict', 'log'], 'strict'),
    devIssuer,
    issuerUrl: url(env, 'ISSUER_URL', `http://127.0.0.1:${port}/dev`),
    audience: read(env, 'AUDIENCE', 'support-platform-api'),
    upstreams: {
      cases: url(env, 'CASES_URL', mocks),
      entitlement: url(env, 'ENTITLEMENT_URL', mocks),
      warehouse: url(env, 'WAREHOUSE_URL', mocks),
    },
    shutdownReadinessDelayMs: integer(env, 'SHUTDOWN_READINESS_DELAY_MS', 0, 0, 60_000),
    requestBudgetMs: integer(env, 'REQUEST_BUDGET_MS', 10_000, 100, 120_000),
    entitlementRefreshSeconds: integer(env, 'ENTITLEMENT_REFRESH_SECONDS', 900, 1, 86_400),
    ...(webhook === undefined ? {} : { webhook }),
    webhookDispatchIntervalMs: integer(env, 'WEBHOOK_DISPATCH_INTERVAL_MS', 1000, 50, 60_000),
    rateLimit: {
      clientPerMinute: integer(env, 'RATE_LIMIT_CLIENT_PER_MINUTE', 100, 1, 100_000),
      agentPerMinute: integer(env, 'RATE_LIMIT_AGENT_PER_MINUTE', 30, 1, 100_000),
    },
  };
}
