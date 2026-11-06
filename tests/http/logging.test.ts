import { afterEach, describe, expect, it } from 'vitest';
import { maskPersonalData } from '../../src/observability/logger.js';
import { captureLogs, startTestApp, type TestApp } from './helpers.js';

// Sensitive values from the fixtures and the auth flow (S2-11).
const EMAIL = 'jane.doe@acme.example';
const PHONE = '+1-415-555-0142';
const ARR = '480000';
const CLIENT_SECRET = 'dev-secret-do-not-log-7f3a';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJqZG9lIn0.c2lnbmF0dXJl';

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('no secrets or personal data in logs (S2-11)', () => {
  it('keeps bodies, credentials and personal data out of request logs', async () => {
    app = await startTestApp({
      handlers: {
        // A failing write path: the error handler logs, the body must not appear.
        addCaseComment: () => {
          throw new Error(`upstream rejected the comment`);
        },
      },
    });
    await fetch(`${app.url}/v1/cases/CS-10231/comments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        cookie: `session=${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': '"8e03978e-40d5-43e8-bc93-6894a57f9324"',
      },
      body: JSON.stringify({ body: `Call ${PHONE} or mail ${EMAIL}; ARR ${ARR}` }),
    });
    // A credential in a form body, as the token endpoint receives it.
    await fetch(`${app.url}/dev/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=support-console&client_secret=${CLIENT_SECRET}`,
    });

    const text = app.logs.text();
    expect(text.length).toBeGreaterThan(0);
    for (const value of [EMAIL, PHONE, ARR, CLIENT_SECRET, TOKEN]) {
      expect(text).not.toContain(value);
    }
  });

  it('redacts secret fields if code logs them by mistake', () => {
    const logs = captureLogs();
    logs.logger.info(
      {
        headers: { authorization: `Bearer ${TOKEN}`, cookie: 'session=abc' },
        form: { client_secret: CLIENT_SECRET },
        nested: { deeper: { password: 'hunter2', token: TOKEN } },
      },
      'oops',
    );
    const text = logs.text();
    for (const value of [TOKEN, CLIENT_SECRET, 'hunter2', 'session=abc']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('[redacted]');
  });

  it('masks email and phone in free text as a backstop', () => {
    const logs = captureLogs();
    logs.logger.warn({ detail: `customer ${EMAIL}` }, `call ${PHONE} back`);
    const text = logs.text();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(PHONE);
    expect(text).toContain('[email]');
    expect(text).toContain('[phone]');
    // No false positives on the data we log legitimately.
    for (const safe of [
      'CS-10231 opened 2026-10-24T08:12:00Z',
      'apiCalls 1203331',
      'trace 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    ]) {
      expect(maskPersonalData(safe)).toBe(safe);
    }
    for (const phone of ['+14155550142', '(415) 555-0142', '415.555.0142']) {
      expect(maskPersonalData(`call ${phone}`)).toBe('call [phone]');
    }
  });
});
