/**
 * The MCP server's only way to reach data: the REST API, with a delegated
 * token for the user (S5 §2.2–2.3). The API makes every access decision.
 */
import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from '../../src/auth/dev-issuer.js';
import type { Clock } from '../../src/clock.js';

export interface AgentIdentity {
  sub: string;
  agent: string;
  clientId: string;
  scopes: string[];
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: unknown;
  /** The X-Request-Id sent: the audit row's correlation ID, matching the API's request log. */
  requestId: string;
}

export interface ApiClientOptions {
  apiUrl: string;
  tokenUrl: string;
  userToken: string;
  agentClientId: string;
  agentClientSecret: string;
  clock: Clock;
}

/** Exchange again when the delegated token has less than this left. */
const REFRESH_MARGIN_SEC = 60;

export class ExchangeError extends Error {}

export class ApiClient {
  private token: { value: string; exp: number; identity: AgentIdentity } | undefined;

  constructor(private readonly options: ApiClientOptions) {}

  /** The identity of the current delegated token (exchanging first if needed). */
  async identity(): Promise<AgentIdentity> {
    return (await this.delegated()).identity;
  }

  /** The last known identity, without a network call; for audit rows on failure paths. */
  knownIdentity(): AgentIdentity | undefined {
    return this.token?.identity;
  }

  private async delegated(): Promise<{ value: string; identity: AgentIdentity }> {
    const now = Math.floor(this.options.clock.now().getTime() / 1000);
    if (this.token !== undefined && this.token.exp - now > REFRESH_MARGIN_SEC) return this.token;
    const basic = Buffer.from(
      `${encodeURIComponent(this.options.agentClientId)}:${encodeURIComponent(this.options.agentClientSecret)}`,
    ).toString('base64');
    const res = await fetch(this.options.tokenUrl, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}` },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: this.options.userToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
    };
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new ExchangeError(`token exchange failed: ${body.error ?? String(res.status)}`);
    }
    const claims = decodeJwt(body.access_token);
    const act = claims.act as { sub?: unknown } | undefined;
    const identity: AgentIdentity = {
      sub: String(claims.sub),
      agent: typeof act?.sub === 'string' ? act.sub : this.options.agentClientId,
      clientId: String(claims.client_id),
      scopes: (typeof claims.scope === 'string' ? claims.scope : '')
        .split(' ')
        .filter((scope) => scope !== ''),
    };
    this.token = { value: body.access_token, exp: claims.exp ?? now, identity };
    return this.token;
  }

  async call(
    method: 'GET' | 'POST',
    path: string,
    options: {
      query?: Record<string, string | number | string[] | undefined>;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ApiResponse> {
    const { value } = await this.delegated();
    const url = new URL(path, this.options.apiUrl);
    for (const [key, raw] of Object.entries(options.query ?? {})) {
      if (raw === undefined) continue;
      for (const item of Array.isArray(raw) ? raw : [raw])
        url.searchParams.append(key, String(item));
    }
    const requestId = randomUUID();
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${value}`,
        'x-request-id': requestId,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      // Not JSON: treated as no body; the status code still decides the outcome.
    }
    return { status: res.status, headers: res.headers, body, requestId };
  }
}
