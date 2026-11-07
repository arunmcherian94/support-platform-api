import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/http/problems.js';
import { startServer } from '../../src/server.js';
import {
  captureLogs,
  startServerWithAuth,
  startTestApp,
  testConfig,
  type TestApp,
} from './helpers.js';

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('logs keep our own identifiers intact', () => {
  it('never masks generated correlation IDs', async () => {
    app = await startTestApp();
    for (let i = 0; i < 200; i++) {
      const id = randomUUID();
      await fetch(`${app.url}/healthz`, { headers: { 'X-Request-Id': id } });
      const line = app.logs.lines().at(-1);
      expect(line?.correlationId).toBe(id);
    }
  });

  it('does not mask phone-like runs inside UUIDs or trace IDs in free text', () => {
    const logs = captureLogs();
    const id = 'a12ea856-ee98-4bc2-9849-88893e3e31ea';
    logs.logger.info(
      { upstreamRequestId: id },
      `trace 00-1234567890abcdef1234567890abcdef-1234567890abcdef-01`,
    );
    expect(logs.text()).toContain(id);
    expect(logs.text()).not.toContain('[phone]');
  });
});

describe('problems are always problem+json', () => {
  it('sends a problem for a status the operation does not declare', async () => {
    app = await startTestApp({
      handlers: {
        getCase: () => {
          throw new AppError('precondition-failed'); // 412 isn't declared on getCase
        },
      },
    });
    const res = await fetch(`${app.url}/v1/cases/CS-10231`);
    expect(res.status).toBe(412);
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const text = await res.text();
    expect(text).not.toMatch(/<html|at .*\.ts/i);
  });

  it('maps malformed JSON to 400 validation-failed', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/v1/cases/CS-10231/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': '"k"' },
      body: '{"body":"x", ',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type: string }).type).toMatch(/validation-failed$/);
    expect(app.logs.lines().some((line) => line.level === 'error')).toBe(false);
  });

  it('maps an oversized body to 400 validation-failed', async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/v1/cases/CS-10231/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': '"k"' },
      body: JSON.stringify({ body: 'x'.repeat(70_000) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/too large/);
  });
});

describe('secrets and personal data in error objects and odd keys', () => {
  it('masks personal data in error stacks', () => {
    const logs = captureLogs();
    logs.logger.error(
      { err: new Error('user jane.doe@acme.example at +1-415-555-0142 not found') },
      'x',
    );
    expect(logs.text()).not.toContain('jane.doe@acme.example');
    expect(logs.text()).not.toContain('+1-415-555-0142');
    expect(logs.lines()[0]).toMatchObject({ err: { type: 'Error' } });
  });

  it('redacts secret keys in any case and at any depth', () => {
    const logs = captureLogs();
    logs.logger.info(
      {
        headers: { Authorization: 'Bearer SECRETCAP', 'X-Api-Key': 'k1', 'Set-Cookie': 's=1' },
        a: { b: { c: { d: { e: { token: 'DEEPTOKEN', refresh_token: 'R1', id_token: 'I1' } } } } },
      },
      'x',
    );
    for (const value of ['SECRETCAP', 'k1', 's=1', 'DEEPTOKEN', 'R1', 'I1']) {
      expect(logs.text()).not.toContain(value);
    }
  });
});

describe('server lifecycle', () => {
  it('fails start-up when the port is taken', async () => {
    const first = await startServer(testConfig({ PORT: '0' }), captureLogs().logger);
    const port = new URL(first.url).port;
    await expect(startServer(testConfig({ PORT: port }), captureLogs().logger)).rejects.toThrow(
      /EADDRINUSE/,
    );
    await first.shutdown();
  });

  it('cuts off requests that outlast the drain deadline, then closes the database', async () => {
    const logs = captureLogs();
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { running, auth } = await startServerWithAuth(logs.logger, {
      handlers: {
        getCase: async () => {
          entered();
          await new Promise(() => undefined); // never finishes
        },
      },
    });
    const hung = fetch(`${running.url}/v1/cases/CS-10231`, { headers: auth }).catch(
      (error: unknown) => error,
    );
    await reached;
    await running.shutdown(100);
    expect(await hung).toBeInstanceOf(Error);
    expect(() => running.db.prepare('SELECT 1')).toThrow();
    expect(
      logs
        .lines()
        .some((line) => line.msg === 'drain deadline reached: closing remaining connections'),
    ).toBe(true);
  });
});
