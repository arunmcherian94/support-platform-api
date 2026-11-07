/**
 * RFC 8693 token exchange on the dev issuer (S5-2): the agent gets a token for
 * the user, never broader than the user, and never a delegation of a delegation.
 */
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from '../../src/auth/dev-issuer.js';
import { fixedClock } from '../../src/clock.js';
import type { RunningServer } from '../../src/server.js';
import {
  captureLogs,
  FIXTURE_NOW,
  startRecordingMocks,
  startServerWithAuth,
  waitForReady,
} from '../http/helpers.js';

let running: RunningServer | undefined;
let mocks: Awaited<ReturnType<typeof startRecordingMocks>> | undefined;
afterEach(async () => {
  await running?.shutdown();
  await mocks?.close();
  running = undefined;
  mocks = undefined;
});

async function start(): Promise<RunningServer> {
  mocks = await startRecordingMocks();
  ({ running } = await startServerWithAuth(captureLogs().logger, {
    env: { MOCKS_URL: mocks.url },
    clock: fixedClock(FIXTURE_NOW),
  }));
  return running;
}

const COPILOT = { id: 'support-copilot', secret: 'dev-only-support-copilot-secret' };
const basic = (id: string, secret: string): string =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

function exchange(
  server: RunningServer,
  subjectToken: string,
  options: { client?: { id: string; secret: string }; extra?: Record<string, string> } = {},
): Promise<Response> {
  const client = options.client ?? COPILOT;
  return fetch(`${server.url}/dev/oauth/token`, {
    method: 'POST',
    headers: { authorization: basic(client.id, client.secret) },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      ...options.extra,
    }),
  });
}

async function userToken(
  server: RunningServer,
  sub: string,
  scopes: string[],
  expiresInSec?: number,
): Promise<string> {
  if (server.issuer === undefined) throw new Error('no issuer');
  return server.issuer.mint({
    sub,
    clientId: 'support-console',
    scopes,
    ...(expiresInSec === undefined ? {} : { expiresInSec }),
  });
}

describe('token exchange (S5-2)', () => {
  it('issues sub = user, act.sub = agent, scopes = user ∩ agent', async () => {
    const server = await start();
    const res = await exchange(
      server,
      await userToken(server, 'jdoe', ['customers:read', 'cases:read', 'cases:comment']),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issued_token_type).toBe(ACCESS_TOKEN_TYPE);
    expect(body.scope).toBe('customers:read cases:read cases:comment');
    const claims = decodeJwt(body.access_token as string);
    expect(claims.sub).toBe('jdoe');
    expect(claims.act).toEqual({ sub: 'support-copilot' });
    expect(claims.client_id).toBe('support-copilot');
    // jdoe had no cases:escalate, so the agent doesn't get it either.
    expect(claims.scope).not.toContain('cases:escalate');
  });

  it("drops finance:read: a finance user's agent never sees ARR", async () => {
    const server = await start();
    const res = await exchange(
      server,
      await userToken(server, 'fbaker', ['customers:read', 'cases:read', 'finance:read']),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; scope: string };
    expect(body.scope).toBe('customers:read cases:read');
    await waitForReady(server.url);
    const customer = await fetch(`${server.url}/v1/customers/ACC-007`, {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(customer.status).toBe(200);
    expect(await customer.json()).not.toHaveProperty('arr');
  });

  it('is accepted by the API, which records the agent', async () => {
    const server = await start();
    const res = await exchange(server, await userToken(server, 'jdoe', ['cases:read']));
    const { access_token: token } = (await res.json()) as { access_token: string };
    await waitForReady(server.url);
    const cases = await fetch(`${server.url}/v1/cases?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cases.status).toBe(200);
  });

  it('refuses an already-delegated subject token', async () => {
    const server = await start();
    const first = await exchange(server, await userToken(server, 'jdoe', ['cases:read']));
    const { access_token: delegated } = (await first.json()) as { access_token: string };
    const res = await exchange(server, delegated);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('refuses a wrong client secret', async () => {
    const server = await start();
    const res = await exchange(server, await userToken(server, 'jdoe', ['cases:read']), {
      client: { id: 'support-copilot', secret: 'wrong' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
  });

  it('refuses a token it did not sign, and an expired one', async () => {
    const server = await start();
    const forged = await exchange(server, 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.');
    expect(((await forged.json()) as { error: string }).error).toBe('invalid_grant');
    const expired = await exchange(server, await userToken(server, 'jdoe', ['cases:read'], -60));
    expect(((await expired.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('never outlives the subject token', async () => {
    const server = await start();
    const res = await exchange(server, await userToken(server, 'jdoe', ['cases:read'], 120));
    expect(((await res.json()) as { expires_in: number }).expires_in).toBe(120);
  });

  it('refuses a requested scope outside the intersection', async () => {
    const server = await start();
    const res = await exchange(server, await userToken(server, 'jdoe', ['cases:read']), {
      extra: { scope: 'cases:read cases:escalate' },
    });
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
  });

  it('requires the access-token subject type', async () => {
    const server = await start();
    const res = await exchange(server, await userToken(server, 'jdoe', ['cases:read']), {
      extra: { subject_token_type: 'urn:ietf:params:oauth:token-type:id_token' },
    });
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
  });
});
