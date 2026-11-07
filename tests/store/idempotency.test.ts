/**
 * Idempotency-key store (S4 §2.1): the atomic claim, replay, mismatch,
 * in-flight, takeover of expired and abandoned rows, and release.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.js';
import {
  claim,
  complete,
  IN_FLIGHT_ABANDON_MS,
  KEY_TTL_MS,
  release,
  type Claim,
  type ClaimResult,
} from '../../src/store/idempotency.js';
import { migrate } from '../../src/store/migrate.js';

const T0 = new Date('2026-11-06T12:00:00Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);
const SCOPE = {
  clientId: 'support-console',
  sub: 'jdoe',
  endpoint: 'addCaseComment:CS-1',
  key: 'k1',
};
const RESPONSE = {
  status: 201,
  headers: { Location: '/v1/cases/CS-1/comments/CM-9' },
  body: { id: 'CM-9', author: 'jdoe', body: 'hi', createdAt: '2026-11-06T12:00:00Z' },
};

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

function claimed(result: ClaimResult): Claim {
  if (result.kind !== 'claimed') throw new Error(`expected claimed, got ${result.kind}`);
  return result.claim;
}

function rows(): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM idempotency_keys').all();
}

describe('claim and complete', () => {
  it('claims a new key as in flight, with a 24 h expiry from the injected clock', () => {
    const result = claim(db, { ...SCOPE, requestHash: 'h1', now: T0 });
    expect(result.kind).toBe('claimed');
    expect(rows()).toEqual([
      expect.objectContaining({
        status: 'in_flight',
        request_hash: 'h1',
        created_at: '2026-11-06T12:00:00.000Z',
        expires_at: '2026-11-07T12:00:00.000Z',
        response_body: null,
      }),
    ]);
  });

  it('replays the completed response for the same key and hash', () => {
    const held = claimed(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }));
    expect(complete(db, held, RESPONSE)).toBe(true);
    expect(claim(db, { ...SCOPE, requestHash: 'h1', now: at(1000) })).toEqual({
      kind: 'replay',
      ...RESPONSE,
    });
  });

  it('reports a different hash as a mismatch, both in flight and completed', () => {
    const held = claimed(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }));
    expect(claim(db, { ...SCOPE, requestHash: 'h2', now: T0 })).toEqual({ kind: 'mismatch' });
    complete(db, held, RESPONSE);
    expect(claim(db, { ...SCOPE, requestHash: 'h2', now: T0 })).toEqual({ kind: 'mismatch' });
  });

  it('makes a second claim on the same database see the first as in flight (no double claim)', () => {
    const first = claim(db, { ...SCOPE, requestHash: 'h1', now: T0 });
    const second = claim(db, { ...SCOPE, requestHash: 'h1', now: T0 });
    expect(first.kind).toBe('claimed');
    expect(second).toEqual({ kind: 'in_flight' });
    expect(rows()).toHaveLength(1);
  });

  it('scopes keys by client, user, endpoint and key', () => {
    claim(db, { ...SCOPE, requestHash: 'h1', now: T0 });
    for (const other of [
      { clientId: 'finance-app' },
      { sub: 'asmith' },
      { endpoint: 'addCaseComment:CS-2' },
      { key: 'k2' },
    ]) {
      expect(claim(db, { ...SCOPE, ...other, requestHash: 'h1', now: T0 }).kind).toBe('claimed');
    }
    expect(rows()).toHaveLength(5);
  });
});

describe('takeover', () => {
  it('keeps an in-flight row for 60 s, then lets a new claim take it over', () => {
    claimed(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }));
    expect(claim(db, { ...SCOPE, requestHash: 'h1', now: at(IN_FLIGHT_ABANDON_MS - 1) })).toEqual({
      kind: 'in_flight',
    });
    const taken = claimed(
      claim(db, { ...SCOPE, requestHash: 'h1', now: at(IN_FLIGHT_ABANDON_MS) }),
    );
    expect(taken.claimedAt).toBe(at(IN_FLIGHT_ABANDON_MS).toISOString());
    // A second caller in the same instant sees the new claim, not another takeover.
    expect(claim(db, { ...SCOPE, requestHash: 'h1', now: at(IN_FLIGHT_ABANDON_MS) })).toEqual({
      kind: 'in_flight',
    });
  });

  it('lets an abandoned row be taken over even with a different body', () => {
    claim(db, { ...SCOPE, requestHash: 'h1', now: T0 });
    expect(claim(db, { ...SCOPE, requestHash: 'h2', now: at(IN_FLIGHT_ABANDON_MS) }).kind).toBe(
      'claimed',
    );
  });

  it('stops the original holder completing or releasing once taken over', () => {
    const original = claimed(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }));
    const taker = claimed(
      claim(db, { ...SCOPE, requestHash: 'h1', now: at(IN_FLIGHT_ABANDON_MS) }),
    );
    expect(complete(db, original, RESPONSE)).toBe(false);
    release(db, original);
    expect(rows()).toHaveLength(1);
    expect(complete(db, taker, RESPONSE)).toBe(true);
  });

  it('treats an expired completed key as new: no replay, a fresh claim', () => {
    const held = claimed(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }));
    complete(db, held, RESPONSE);
    expect(claim(db, { ...SCOPE, requestHash: 'h1', now: at(KEY_TTL_MS - 1) }).kind).toBe('replay');
    expect(claim(db, { ...SCOPE, requestHash: 'h1', now: at(KEY_TTL_MS) }).kind).toBe('claimed');
    expect(rows()).toEqual([
      expect.objectContaining({ status: 'in_flight', response_body: null, response_status: null }),
    ]);
  });

  it('treats an expired key with a different body as new, not a mismatch', () => {
    const held = claimed(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }));
    complete(db, held, RESPONSE);
    expect(claim(db, { ...SCOPE, requestHash: 'h2', now: at(KEY_TTL_MS + 1000) }).kind).toBe(
      'claimed',
    );
  });
});

describe('release', () => {
  it('deletes the in-flight row so the same key can be claimed again', () => {
    const held = claimed(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }));
    release(db, held);
    expect(rows()).toHaveLength(0);
    expect(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }).kind).toBe('claimed');
  });

  it('never deletes a completed row', () => {
    const held = claimed(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }));
    complete(db, held, RESPONSE);
    release(db, held);
    expect(rows()).toHaveLength(1);
    expect(claim(db, { ...SCOPE, requestHash: 'h1', now: T0 }).kind).toBe('replay');
  });

  it('never deletes a row claimed for a different request hash', () => {
    claim(db, { ...SCOPE, requestHash: 'h1', now: T0 });
    release(db, { ...SCOPE, requestHash: 'h2', claimedAt: T0.toISOString() });
    expect(rows()).toHaveLength(1);
  });
});

describe('concurrent claims on separate connections', () => {
  /** Runs a worker that claims `keys` keys on the shared file and returns the keys it won. */
  function racer(path: string, keys: number, barrier: SharedArrayBuffer): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./idempotency-race.worker.ts', import.meta.url), {
        workerData: { path, keys, barrier },
        execArgv: ['--import', 'tsx'],
      });
      worker.once('message', (won: string[]) => {
        resolve(won);
      });
      worker.once('error', reject);
    });
  }

  it('never lets two connections both claim a key, even in parallel threads', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'idem-race-')), 'race.db');
    const setup = openDatabase(path);
    migrate(setup);
    setup.close();
    const keys = 3000;
    const barrier = new SharedArrayBuffer(4);
    const [a, b] = await Promise.all([racer(path, keys, barrier), racer(path, keys, barrier)]);
    const both = a.filter((key) => new Set(b).has(key));
    expect(both).toEqual([]);
    expect(a.length + b.length).toBe(keys);
  }, 30_000);
});
