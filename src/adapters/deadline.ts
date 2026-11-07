import { performance } from 'node:perf_hooks';
import { currentContext } from '../observability/context.js';

/**
 * The time left for one request (S3 §2.3). Elapsed time is measured with the
 * monotonic clock: this is a duration, not business time, so the injected
 * Clock (which can be fixed in tests) is the wrong tool.
 */
export interface Deadline {
  remainingMs(): number;
}

export function createDeadline(budgetMs: number): Deadline {
  const end = performance.now() + budgetMs;
  return { remainingMs: () => Math.max(0, end - performance.now()) };
}

/** The current request's deadline, or undefined outside a request (e.g. background polling). */
export function currentDeadline(): Deadline | undefined {
  return currentContext()?.deadline;
}
