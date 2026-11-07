/**
 * The adapters wired into the real server, against the mock upstreams
 * (S3-7, S3-8, S3-12, S3-13). The read endpoints arrive in the next PR, so a
 * test handler makes the upstream call inside a real request.
 */
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { toAppError, UpstreamError } from '../../src/adapters/errors.js';
import { fixedClock } from '../../src/clock.js';
import { AppError } from '../../src/http/problems.js';
import type { RunningServer } from '../../src/server.js';
import { captureLogs, FIXTURE_NOW, startRecordingMocks, startServerWithAuth } from './helpers.js';

let running: RunningServer | undefined;
let auth: { authorization: string } = { authorization: '' };
let mocks: Awaited<ReturnType<typeof startRecordingMocks>> | undefined;
afterEach(async () => {
  await running?.shutdown();
  await mocks?.close();
  running = undefined;
  mocks = undefined;
});

interface Readiness {
  status: string;
  checks: Record<string, string>;
  unmatchedAccountIds: string[];
}

/** Starts mocks plus the real server; `getCase` reads the case through the adapter. */
async function start(
  setup?: (m: NonNullable<typeof mocks>) => void,
): Promise<{ logs: ReturnType<typeof captureLogs> }> {
  mocks = await startRecordingMocks();
  setup?.(mocks);
  const logs = captureLogs();
  ({ running, auth } = await startServerWithAuth(logs.logger, {
    env: { MOCKS_URL: mocks.url },
    clock: fixedClock(FIXTURE_NOW),
    handlers: {
      getCase: async (req: Request, res: Response, next: NextFunction) => {
        try {
          const record = await running?.upstreams.cases.get(
            String(
              (req as unknown as { openapi: { pathParams: Record<string, string> } }).openapi
                .pathParams.caseId,
            ),
          );
          res.set('X-Test-Etag', record?.etag ?? '');
          res.status(204).end();
        } catch (error) {
          if (error instanceof UpstreamError && error.kind === 'not_found') {
            next(new AppError('not-found', 'No such case.'));
          } else if (error instanceof UpstreamError) {
            next(toAppError(error));
          } else next(error);
        }
      },
    },
  }));
  return { logs };
}

const readiness = async (): Promise<{ status: number; body: Readiness }> => {
  const res = await fetch(`${running?.url ?? ''}/readyz`);
  return { status: res.status, body: (await res.json()) as Readiness };
};

describe('readiness with real upstreams (S3-12)', () => {
  it('is ready once the entitlement snapshot loads, reporting each upstream', async () => {
    await start();
    const { status, body } = await readiness();
    expect(status).toBe(200);
    expect(body.checks).toEqual({
      database: 'ok',
      entitlementSnapshot: 'ok',
      caseSystem: 'ok',
      usageWarehouse: 'ok',
    });
  });

  it('is not ready while the snapshot has never loaded, and recovers on the next poll', async () => {
    await start((m) => m.mock.faults.update('entitlement', { forceStatus: 503 }));
    const { status, body } = await readiness();
    expect(status).toBe(503);
    expect(body.checks.entitlementSnapshot).toBe('unavailable');
    expect(running?.upstreams.entitlement.current()).toMatchObject({
      usable: false,
      reason: 'never_loaded',
    });
  });

  it('lists unmatched account IDs reported during reads', async () => {
    await start();
    running?.upstreams.entitlement.reportUnmatched('ACC-099');
    expect((await readiness()).body.unmatchedAccountIds).toEqual(['ACC-099']);
  });
});

describe('correlation reaches the upstream (S3-13)', () => {
  it('sends X-Request-Id and a child traceparent on upstream calls', async () => {
    await start();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const res = await fetch(`${running?.url ?? ''}/v1/cases/CS-10231`, {
      headers: {
        ...auth,
        'X-Request-Id': 'req-upstream-1',
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      },
    });
    expect(res.status).toBe(204);
    const call = mocks?.seen.find((s) => s.path === '/cases/CS-10231');
    expect(call?.headers['x-request-id']).toBe('req-upstream-1');
    const traceparent = String(call?.headers.traceparent);
    expect(traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    expect(traceparent).not.toContain('00f067aa0ba902b7');
  });
});

describe('breaker end to end against the mock (S3-7, S3-8)', () => {
  it('maps exhausted 5xx to 502, then opens: 503 with Retry-After, logged and in readiness', async () => {
    const { logs } = await start((m) => m.mock.faults.update('cases', { forceStatus: 500 }));
    const call = () => fetch(`${running?.url ?? ''}/v1/cases/CS-10231`, { headers: auth });

    const first = await call(); // 3 attempts, all 500
    expect(first.status).toBe(502);
    expect(((await first.json()) as { type: string }).type).toMatch(/upstream-error$/);

    const second = await call(); // attempts 4 and 5 open the breaker
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBe('10');

    const callsBefore = mocks?.seen.filter((s) => s.path === '/cases/CS-10231').length;
    const third = await call(); // refused without calling upstream
    expect(third.status).toBe(503);
    expect(mocks?.seen.filter((s) => s.path === '/cases/CS-10231').length).toBe(callsBefore);

    expect((await readiness()).body.checks.caseSystem).toBe('unavailable');
    // Still ready: an upstream outage must not take the replica out of rotation.
    expect((await readiness()).status).toBe(200);
    expect(logs.lines().some((l) => l.upstream === 'case_system' && l.breaker === 'open')).toBe(
      true,
    );
    // No upstream body in the response.
    expect(await third.text()).not.toMatch(/errorCode|INTERNAL/);
  });

  it('never opens on 404s: an unknown case is an answer, not an outage', async () => {
    await start();
    for (let i = 0; i < 8; i++) {
      expect(
        (await fetch(`${running?.url ?? ''}/v1/cases/CS-99999`, { headers: auth })).status,
      ).toBe(404);
    }
    expect((await readiness()).body.checks.caseSystem).toBe('ok');
    expect((await fetch(`${running?.url ?? ''}/v1/cases/CS-10231`, { headers: auth })).status).toBe(
      204,
    );
  });
});
