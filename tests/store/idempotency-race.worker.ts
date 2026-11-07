/**
 * Worker for the idempotency race test: opens its own connection to a shared
 * database file, waits at a barrier so both workers start together, then
 * claims every key and reports the ones it won.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { claim } from '../../src/store/idempotency.js';

const { path, keys, barrier } = workerData as {
  path: string;
  keys: number;
  barrier: SharedArrayBuffer;
};

// Not openDatabase(): it sets journal_mode before busy_timeout, so two
// connections opening at once can fail with SQLITE_BUSY. The test set up WAL
// already; here the busy timeout applies from the first statement.
const db = new DatabaseSync(path, { timeout: 5000 });
const gate = new Int32Array(barrier);
Atomics.add(gate, 0, 1);
// Spin until both workers are ready, so their claims overlap in time.
while (Atomics.load(gate, 0) < 2) {
  /* wait */
}

const now = new Date('2026-11-06T12:00:00Z');
const won: string[] = [];
for (let i = 0; i < keys; i += 1) {
  const key = `k${String(i)}`;
  const result = claim(db, {
    clientId: 'c',
    sub: 's',
    endpoint: 'addCaseComment:CS-1',
    key,
    requestHash: 'h',
    now,
  });
  if (result.kind === 'claimed') won.push(key);
}
db.close();
parentPort?.postMessage(won);
