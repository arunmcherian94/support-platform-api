import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Identity } from '../../src/auth/types.js';
import { fixedClock, type TestClock } from '../../src/clock.js';
import { createApp } from '../../src/http/app.js';
import { createRateLimiter, createTokenBuckets } from '../../src/http/rate-limit.js';
import { openDatabase } from '../../src/store/db.js';
import { captureLogs, FIXTURE_NOW, testConfig, VALID_CASE } from './helpers.js';

const LIMITS = { clientPerMinute: 100, agentPerMinute: 30 };

function identity(clientId: string, agent?: string): Identity {
  return {
    clientId,
    sub: 'user-1',
    scopes: ['cases:read'],
    ...(agent === undefined ? {} : { agent }),
  };
}

/** Parses `"name";k=v;k=v` (one structured-field list member). */
function parseHeader(value: string | null): { name: string; params: Record<string, number> } {
  expect(value).not.toBeNull();
  const [rawName = '', ...rest] = (value ?? '').split(';');
  const params: Record<string, number> = {};
  for (const part of rest) {
    const [key = '', raw = ''] = part.split('=');
    expect(raw).toMatch(/^\d+$/);
    params[key] = Number(raw);
  }
  expect(rawName).toMatch(/^"[a-z]+"$/);
  return { name: rawName.slice(1, -1), params };
}

describe('token buckets (unit)', () => {
  let clock: TestClock;
  const make = (extra: { sweepEvery?: number; maxBuckets?: number } = {}) => {
    clock = fixedClock(FIXTURE_NOW);
    return createTokenBuckets({ clock, ...LIMITS, ...extra });
  };

  it('allows 100 requests per client, then refuses with a Retry-After of at least 1s', () => {
    const limiter = make();
    for (let i = 1; i <= 100; i += 1) {
      const decision = limiter.take(identity('app'));
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(100 - i);
    }
    const refused = limiter.take(identity('app'));
    expect(refused).toMatchObject({ allowed: false, policy: 'client', quota: 100, remaining: 0 });
    expect(refused.retryAfterSeconds).toBe(1);
    expect(refused.resetSeconds).toBe(60);
  });

  it('keeps clients independent', () => {
    const limiter = make();
    for (let i = 0; i < 100; i += 1) limiter.take(identity('app'));
    expect(limiter.take(identity('app')).allowed).toBe(false);
    expect(limiter.take(identity('other'))).toMatchObject({ allowed: true, remaining: 99 });
  });

  it('refills continuously from the clock', () => {
    const limiter = make();
    for (let i = 0; i < 100; i += 1) limiter.take(identity('app'));
    clock.advance(30_000);
    // Half the window refills half the bucket: 50 tokens, one used now.
    expect(limiter.take(identity('app'))).toMatchObject({
      allowed: true,
      remaining: 49,
      resetSeconds: 31,
    });
    clock.advance(60_000);
    expect(limiter.take(identity('app'))).toMatchObject({ remaining: 99 });
  });

  it('gives an agent its own tighter bucket and reports it while it is tighter', () => {
    const limiter = make();
    const first = limiter.take(identity('app', 'copilot'));
    expect(first).toMatchObject({ allowed: true, policy: 'agent', quota: 30, remaining: 29 });
    for (let i = 0; i < 29; i += 1) limiter.take(identity('app', 'copilot'));
    const refused = limiter.take(identity('app', 'copilot'));
    expect(refused).toMatchObject({ allowed: false, policy: 'agent', quota: 30, remaining: 0 });
    // ceil(60/30) = 2 seconds for one agent token.
    expect(refused.retryAfterSeconds).toBe(2);
    // The client consumed 30 (not 31+): the refusal took nothing from it.
    expect(limiter.take(identity('app'))).toMatchObject({
      allowed: true,
      policy: 'client',
      remaining: 69,
    });
  });

  it('does not drain the client bucket while the agent bucket refuses', () => {
    const limiter = make();
    for (let i = 0; i < 30; i += 1) limiter.take(identity('app', 'copilot'));
    for (let i = 0; i < 50; i += 1) {
      expect(limiter.take(identity('app', 'copilot')).allowed).toBe(false);
    }
    expect(limiter.take(identity('app')).remaining).toBe(69);
  });

  it('does not drain the agent bucket while the client bucket refuses', () => {
    const limiter = make();
    for (let i = 0; i < 100; i += 1) limiter.take(identity('app'));
    const refused = limiter.take(identity('app', 'copilot'));
    expect(refused).toMatchObject({ allowed: false, policy: 'client' });
    expect(limiter.take(identity('other', 'copilot'))).toMatchObject({
      allowed: true,
      policy: 'agent',
      remaining: 29,
    });
  });

  it('keys the agent bucket by agent across clients', () => {
    const limiter = make();
    for (let i = 0; i < 30; i += 1) limiter.take(identity(`app-${String(i)}`, 'copilot'));
    expect(limiter.take(identity('fresh', 'copilot')).allowed).toBe(false);
    expect(limiter.take(identity('fresh', 'other-agent')).allowed).toBe(true);
  });

  it('evicts full, idle buckets so many client ids cannot grow the map without bound', () => {
    const limiter = make({ sweepEvery: 1_000_000, maxBuckets: 50 });
    for (let i = 0; i < 50; i += 1) limiter.take(identity(`c-${String(i)}`));
    expect(limiter.size()).toBe(50);
    clock.advance(100);
    // Still refilling: kept, because forgetting them would hand out fresh quota.
    limiter.take(identity('c-new-1'));
    expect(limiter.size()).toBe(51);
    clock.advance(60_000);
    limiter.take(identity('c-new-2'));
    expect(limiter.size()).toBe(1);
  });

  it('also sweeps periodically', () => {
    const limiter = make({ sweepEvery: 10, maxBuckets: 1_000_000 });
    for (let i = 0; i < 9; i += 1) limiter.take(identity(`c-${String(i)}`));
    expect(limiter.size()).toBe(9);
    clock.advance(60_000);
    limiter.take(identity('c-0'));
    expect(limiter.size()).toBe(1);
  });

  it('evicted buckets come back full, so eviction changes no decision', () => {
    const limiter = make({ sweepEvery: 1, maxBuckets: 1_000_000 });
    limiter.take(identity('app'));
    clock.advance(60_000);
    expect(limiter.take(identity('app')).remaining).toBe(99);
  });
});

describe('rate limiting over HTTP (S2-7)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) resolve();
      else
        server.close(() => {
          resolve();
        });
    });
    server = undefined;
  });

  async function start(clock: TestClock): Promise<string> {
    const limiter = createRateLimiter({ clock, ...LIMITS });
    // Test-only stand-in for the security handler: identity from test headers.
    const fakeAuth = express.Router().use((req, res, next) => {
      const clientId = req.get('x-test-client');
      if (clientId !== undefined) {
        res.locals.identity = identity(clientId, req.get('x-test-agent'));
      }
      next();
    });
    const app = createApp({
      config: testConfig(),
      clock,
      logger: captureLogs().logger,
      db: openDatabase(':memory:'),
      handlers: {
        getCase: (_req, res) => {
          res.json(VALID_CASE);
        },
      },
      preValidation: [fakeAuth],
      afterAuth: [limiter],
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => {
        resolve(s);
      });
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  const getCase = (url: string, client: string, agent?: string) =>
    fetch(`${url}/v1/cases/CS-10231`, {
      headers: {
        'x-test-client': client,
        ...(agent === undefined ? {} : { 'x-test-agent': agent }),
      },
    });

  it('passes 100 requests, refuses the 101st with a rate-limited problem, spares other clients', async () => {
    const url = await start(fixedClock(FIXTURE_NOW));
    for (let i = 1; i <= 100; i += 1) {
      const res = await getCase(url, 'app');
      expect(res.status).toBe(200);
      const policy = parseHeader(res.headers.get('RateLimit-Policy'));
      const limit = parseHeader(res.headers.get('RateLimit'));
      expect(policy).toEqual({ name: 'client', params: { q: 100, w: 60 } });
      expect(limit.name).toBe('client');
      expect(limit.params.r).toBe(100 - i);
    }

    const refused = await getCase(url, 'app');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const body = (await refused.json()) as { type: string; status: number; detail: string };
    expect(body.type).toBe('https://support-platform.example/problems/rate-limited');
    expect(body.status).toBe(429);
    expect(body.detail).toBe('Quota of 100 requests per 60 seconds exceeded.');
    expect(refused.headers.get('Retry-After')).toBe('1');
    expect(parseHeader(refused.headers.get('RateLimit'))).toEqual({
      name: 'client',
      params: { r: 0, t: 60 },
    });
    expect(parseHeader(refused.headers.get('RateLimit-Policy')).params.q).toBe(100);

    const other = await getCase(url, 'other');
    expect(other.status).toBe(200);
    expect(parseHeader(other.headers.get('RateLimit')).params.r).toBe(99);
  });

  it('limits an agent to 30 while the same client without the agent keeps capacity', async () => {
    const url = await start(fixedClock(FIXTURE_NOW));
    for (let i = 1; i <= 30; i += 1) {
      const res = await getCase(url, 'app', 'copilot');
      expect(res.status).toBe(200);
      expect(parseHeader(res.headers.get('RateLimit-Policy'))).toEqual({
        name: 'agent',
        params: { q: 30, w: 60 },
      });
      expect(parseHeader(res.headers.get('RateLimit')).name).toBe('agent');
    }
    for (let i = 0; i < 5; i += 1) {
      const refused = await getCase(url, 'app', 'copilot');
      expect(refused.status).toBe(429);
      expect(refused.headers.get('Retry-After')).toBe('2');
      expect(((await refused.json()) as { detail: string }).detail).toBe(
        'Quota of 30 requests per 60 seconds exceeded.',
      );
      expect(parseHeader(refused.headers.get('RateLimit'))).toMatchObject({
        name: 'agent',
        params: { r: 0 },
      });
    }
    const direct = await getCase(url, 'app');
    expect(direct.status).toBe(200);
    // 30 agent requests counted against the client; the 5 refusals did not.
    expect(parseHeader(direct.headers.get('RateLimit'))).toMatchObject({
      name: 'client',
      params: { r: 69 },
    });
  });

  it('refills as the test clock advances', async () => {
    const clock = fixedClock(FIXTURE_NOW);
    const url = await start(clock);
    for (let i = 0; i < 100; i += 1) await getCase(url, 'app');
    expect((await getCase(url, 'app')).status).toBe(429);
    clock.advance(30_000);
    const res = await getCase(url, 'app');
    expect(res.status).toBe(200);
    expect(parseHeader(res.headers.get('RateLimit'))).toEqual({
      name: 'client',
      params: { r: 49, t: 31 },
    });
  });

  it('leaves unauthenticated requests alone: no headers, no limit', async () => {
    const url = await start(fixedClock(FIXTURE_NOW));
    for (let i = 0; i < 120; i += 1) {
      const res = await fetch(`${url}/healthz`);
      expect(res.status).toBe(200);
      expect(res.headers.get('RateLimit')).toBeNull();
      expect(res.headers.get('RateLimit-Policy')).toBeNull();
    }
  });
});
