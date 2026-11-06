import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, VALID_CASE, type TestApp } from './helpers.js';

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Problem {
  type: string;
  status: number;
  detail?: string;
  correlationId: string;
  errors?: { pointer: string; detail: string }[];
}

describe('request validation (S2-2)', () => {
  it('rejects a request that violates the contract with validation-failed', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/v1/cases?priority=P9`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const body = (await res.json()) as Problem;
    expect(body.type).toBe('https://support-platform.example/problems/validation-failed');
    expect(body.errors?.[0]?.pointer).toBe('#/query/priority/0');
    // The detail states the rule, never the input value.
    expect(JSON.stringify(body.errors)).not.toContain('P9');
  });

  it('rejects unknown query parameters', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/v1/cases?colour=blue`);
    expect(res.status).toBe(400);
  });
});

describe('response validation (S2-2)', () => {
  const badCase = { ...VALID_CASE, status: 'escalated' }; // not in the CaseStatus enum

  it('strict mode turns a contract-violating response into a 500 and logs it', async () => {
    app = await startTestApp({
      handlers: {
        getCase: (_req, res) => {
          res.json(badCase);
        },
      },
    });
    const res = await fetch(`${app.url}/v1/cases/CS-10231`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Problem;
    expect(body.type).toBe('https://support-platform.example/problems/internal-error');
    expect(JSON.stringify(body)).not.toContain('escalated');
    expect(app.logs.lines().some((line) => line.level === 'error')).toBe(true);
  });

  it('log mode sends the response and logs the violation', async () => {
    app = await startTestApp({
      env: { RESPONSE_VALIDATION: 'log' },
      handlers: {
        getCase: (_req, res) => {
          res.json(badCase);
        },
      },
    });
    const res = await fetch(`${app.url}/v1/cases/CS-10231`);
    expect(res.status).toBe(200);
    expect(
      app.logs.lines().some((line) => line.msg === 'response violates the contract (log mode)'),
    ).toBe(true);
  });

  it('passes a valid response through', async () => {
    app = await startTestApp({
      handlers: {
        getCase: (_req, res) => {
          res.json(VALID_CASE);
        },
      },
    });
    const res = await fetch(`${app.url}/v1/cases/CS-10231`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VALID_CASE);
  });
});

describe('errors (S2-3)', () => {
  it('never leaks the message or stack of an unknown error', async () => {
    app = await startTestApp({
      handlers: {
        getCase: () => {
          throw new Error('db password is hunter2 at /srv/app/secret.ts:42');
        },
      },
    });
    const res = await fetch(`${app.url}/v1/cases/CS-10231`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('secret.ts');
    const body = JSON.parse(text) as Problem;
    expect(body.correlationId).toBe(res.headers.get('x-request-id'));
  });

  it('returns not-found problems for routes outside the contract', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/v2/anything`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).type).toMatch(/not-found$/);
  });

  it('answers operations without a handler with a contract-valid 500', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/v1/cases`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as Problem).type).toMatch(/internal-error$/);
  });
});

describe('correlation (S2-4)', () => {
  it('echoes a valid X-Request-Id and puts it on every log line', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/healthz`, { headers: { 'X-Request-Id': 'req-123.abc' } });
    expect(res.headers.get('x-request-id')).toBe('req-123.abc');
    const lines = app.logs.lines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.correlationId === 'req-123.abc')).toBe(true);
  });

  it('replaces an invalid X-Request-Id', async () => {
    app = await startTestApp();
    for (const bad of ['has spaces', 'x'.repeat(129), 'semi;colon']) {
      const res = await fetch(`${app.url}/healthz`, { headers: { 'X-Request-Id': bad } });
      const id = res.headers.get('x-request-id');
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('logs request metadata with the route template', async () => {
    app = await startTestApp({
      handlers: {
        getCase: (_req, res) => {
          res.json(VALID_CASE);
        },
      },
    });
    await fetch(`${app.url}/v1/cases/CS-10231`);
    const line = app.logs.lines().find((l) => l.msg === 'request completed');
    expect(line).toMatchObject({ method: 'GET', route: '/v1/cases/{caseId}', status: 200 });
    expect(typeof line?.latencyMs).toBe('number');
  });
});
