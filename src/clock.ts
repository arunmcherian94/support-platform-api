/**
 * The only place that reads the system time (S1-6). Everything else takes a
 * `Clock`, so time-window logic is deterministic in tests and demos.
 * ESLint bans `Date.now()` and argument-less `new Date()` outside this file.
 */
export interface Clock {
  now(): Date;
}

/** A clock tests can set and move. */
export interface TestClock extends Clock {
  set(at: Date | string): void;
  advance(ms: number): void;
}

export function fixedClock(at: Date | string): TestClock {
  let current = new Date(at).getTime();
  return {
    now: () => new Date(current),
    set: (next) => {
      current = new Date(next).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/**
 * Wall clock for processes. With `NOW` set (RFC 3339), the clock starts at that
 * instant and then advances in real time, so fixture-relative answers are
 * reproducible while retries, TTLs and timestamps still move forward.
 * Restart the processes for a fresh run: after an hour of uptime, the 47-hour
 * near-miss case in the fixtures crosses 48 hours.
 */
export function systemClock(env: NodeJS.ProcessEnv = process.env): Clock {
  const anchor = env.NOW;
  if (anchor === undefined || anchor === '') {
    return { now: () => new Date(Date.now()) };
  }
  const anchorMs = Date.parse(anchor);
  if (Number.isNaN(anchorMs)) {
    throw new Error(`NOW is not a valid RFC 3339 timestamp: ${anchor}`);
  }
  const startedMs = Date.now();
  return { now: () => new Date(anchorMs + (Date.now() - startedMs)) };
}
