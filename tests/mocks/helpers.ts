import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { fixedClock, type TestClock } from '../../src/clock.js';
import { startMockServer, type MockApp } from '../../mocks/server.js';

/** The fixture clock from S1 §4. */
export const FIXTURE_NOW = '2026-11-06T12:00:00Z';

export interface MockHarness {
  url: string;
  clock: TestClock;
  mock: MockApp;
}

/**
 * Starts the mock server on a free port for the current test file, with the
 * fixture clock, and resets faults and seeded data after each test.
 */
export function useMockServer(): MockHarness {
  const harness = { clock: fixedClock(FIXTURE_NOW) } as MockHarness;
  let server: Server | undefined;
  beforeAll(async () => {
    const started = await startMockServer(0, { clock: harness.clock });
    server = started.server;
    harness.url = started.url;
    harness.mock = started.mock;
  });
  afterEach(() => {
    harness.mock.reset();
    harness.clock.set(FIXTURE_NOW);
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return harness;
}
