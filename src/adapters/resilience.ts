import {
  CircuitState,
  ConsecutiveBreaker,
  circuitBreaker,
  fullJitterGenerator,
  handleWhen,
  isBrokenCircuitError,
  isIsolatedCircuitError,
  isTaskCancelledError,
  retry,
  timeout,
  TimeoutStrategy,
  type CircuitBreakerPolicy,
  type IBackoff,
  type IBackoffFactory,
  type IRetryBackoffContext,
} from 'cockatiel';
import type { Clock } from '../clock.js';
import type { Logger } from '../observability/logger.js';
import { currentDeadline } from './deadline.js';
import {
  DEFAULT_RETRY_AFTER_SEC,
  UpstreamError,
  type FailureKind,
  type Upstream,
} from './errors.js';

/**
 * Resilience policy for one upstream (S3 §2.3). Constants, not env: they are
 * design decisions, reviewed with the code (S3 §2.8).
 */
export interface UpstreamPolicy {
  /** Timeout for one attempt, in milliseconds. */
  attemptTimeoutMs: number;
  /** Retries after the first attempt. */
  maxRetries: number;
  /** Whether the upstream sits behind a circuit breaker. */
  breaker: boolean;
}

export const POLICIES: Record<Upstream, UpstreamPolicy> = {
  case_system: { attemptTimeoutMs: 3000, maxRetries: 2, breaker: true },
  usage_warehouse: { attemptTimeoutMs: 1500, maxRetries: 1, breaker: true },
  // Background poll, not on the request path: the last good snapshot is the fallback.
  entitlement: { attemptTimeoutMs: 5000, maxRetries: 2, breaker: false },
};

/** Consecutive counted failures that open the breaker. */
export const BREAKER_THRESHOLD = 5;
/** Time an open breaker waits before letting one probe through. */
export const HALF_OPEN_AFTER_MS = 10_000;
/**
 * Retry-After for an open breaker. An upper bound: cockatiel doesn't expose
 * when the breaker opened, so the time left can't be computed.
 */
export const CIRCUIT_OPEN_RETRY_AFTER_SEC = HALF_OPEN_AFTER_MS / 1000;
/** Exponential backoff with full jitter: random in [0, min(cap, initial × 2^n)). */
export const BACKOFF = { initialDelayMs: 100, maxDelayMs: 1000 } as const;
/**
 * Longest Retry-After we wait for outside a request (no deadline, e.g. the
 * background poll). Beyond it the call gives up as `throttled`: the poll keeps
 * its snapshot and tries again on its next tick.
 */
export const MAX_UNBUDGETED_RETRY_AFTER_MS = 10_000;

/** Failures that say the upstream is unhealthy (or the platform's shared quota is spent). */
const COUNTED: ReadonlySet<FailureKind> = new Set([
  'timeout',
  'unavailable',
  'server_error',
  'throttled',
]);

/**
 * Whether a failure counts toward the breaker. Timeouts, network errors, 5xx
 * and 429 do (429: the upstream quota is the platform's, shared by every
 * caller). A 404 is an answer and any other 4xx is our bug: neither may open a
 * circuit against a healthy upstream, so the breaker doesn't handle them.
 */
export function countsTowardBreaker(error: unknown): boolean {
  return error instanceof UpstreamError && COUNTED.has(error.kind);
}

/** Backoff before retry number `retryIndex` (0 for the first retry). */
export function backoffDelayMs(retryIndex: number): number {
  const [delay] = fullJitterGenerator(retryIndex, {
    generator: fullJitterGenerator,
    initialDelay: BACKOFF.initialDelayMs,
    maxDelay: BACKOFF.maxDelayMs,
    exponent: 2,
  });
  return delay;
}

/**
 * Parses Retry-After: delta-seconds or an HTTP-date (RFC 9110 §10.2.3), the
 * latter against the injected clock. Undefined when absent or unparseable.
 */
export function parseRetryAfterSec(value: string | null, clock: Clock): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // Only HTTP-date shapes: Date.parse accepts far more than RFC 9110 allows.
  if (!/^[A-Za-z]{3},? /.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - clock.now().getTime()) / 1000));
}

export type BreakerHealth = 'ok' | 'degraded' | 'unavailable';

/** What the resilient wrapper passes to each attempt. */
export interface AttemptContext {
  /** Aborted when the attempt times out. */
  signal: AbortSignal;
  /** 1-based attempt number. */
  attempt: number;
}

export interface Resilience {
  /**
   * Runs `attempt` behind retry (outside), breaker, and a per-attempt timeout
   * (innermost). `attempt` must throw UpstreamError for every failure it
   * classifies. Everything that escapes is an UpstreamError.
   */
  execute<T>(
    attempt: (context: AttemptContext) => Promise<T>,
    options: { retryable: boolean; path: string },
  ): Promise<T>;
  health(): BreakerHealth;
}

const STATE_NAMES: Record<CircuitState, string> = {
  [CircuitState.Closed]: 'closed',
  [CircuitState.Open]: 'open',
  [CircuitState.HalfOpen]: 'half-open',
  [CircuitState.Isolated]: 'isolated',
};

function createBreaker(upstream: Upstream, logger: Logger): CircuitBreakerPolicy {
  const breaker = circuitBreaker(handleWhen(countsTowardBreaker), {
    breaker: new ConsecutiveBreaker(BREAKER_THRESHOLD),
    halfOpenAfter: HALF_OPEN_AFTER_MS,
  });
  let previous = CircuitState.Closed;
  breaker.onStateChange((state) => {
    const fields = { upstream, breaker: STATE_NAMES[state], from: STATE_NAMES[previous] };
    previous = state;
    if (state === CircuitState.Open) logger.warn(fields, 'upstream circuit opened');
    else logger.info(fields, 'upstream circuit state changed');
  });
  return breaker;
}

/** Per-call retry plan: the predicate decides the next delay, the backoff reads it. */
interface RetryPlan {
  retriesDone: number;
  nextDelayMs: number;
}

class PlannedBackoff implements IBackoffFactory<IRetryBackoffContext<unknown>> {
  constructor(private readonly plan: RetryPlan) {}

  next(): IBackoff<IRetryBackoffContext<unknown>> {
    return { duration: this.plan.nextDelayMs, next: () => this.next() };
  }
}

export function createResilience(options: {
  upstream: Upstream;
  policy: UpstreamPolicy;
  logger: Logger;
}): Resilience {
  const { upstream, policy, logger } = options;
  const breaker = options.policy.breaker ? createBreaker(upstream, logger) : undefined;

  /**
   * Decides whether to retry after `error`, and how long to wait first. A retry
   * starts only if its wait plus a full attempt timeout fits the time left.
   */
  function shouldRetry(error: unknown, plan: RetryPlan): boolean {
    if (!countsTowardBreaker(error)) return false;
    const failure = error as UpstreamError;
    const delayMs =
      failure.kind === 'throttled'
        ? (failure.info.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC) * 1000
        : backoffDelayMs(plan.retriesDone);
    const deadline = currentDeadline();
    if (deadline === undefined) {
      if (failure.kind === 'throttled' && delayMs > MAX_UNBUDGETED_RETRY_AFTER_MS) return false;
    } else if (deadline.remainingMs() < delayMs + policy.attemptTimeoutMs) {
      return false;
    }
    plan.nextDelayMs = delayMs;
    plan.retriesDone += 1;
    return true;
  }

  function logFailure(error: unknown, attempt: number, path: string): void {
    if (!(error instanceof UpstreamError)) return;
    const fields = {
      upstream,
      kind: error.kind,
      attempt,
      path,
      ...(error.info.status === undefined ? {} : { status: error.info.status }),
      ...(error.info.code === undefined ? {} : { code: error.info.code }),
    };
    // A 404 is an answer, not a fault.
    if (error.kind === 'not_found') logger.debug(fields, 'upstream attempt failed');
    else logger.warn(fields, 'upstream attempt failed');
  }

  async function runAttempt<T>(
    attempt: (context: AttemptContext) => Promise<T>,
    attemptNo: number,
    path: string,
  ): Promise<T> {
    const remaining = currentDeadline()?.remainingMs();
    if (remaining !== undefined && remaining <= 0) {
      throw new UpstreamError(upstream, 'budget_exhausted');
    }
    const timeoutMs = Math.min(policy.attemptTimeoutMs, remaining ?? Infinity);
    // A timeout cut short by the budget is the budget's fault, not the upstream's:
    // it is not counted and not retried.
    const clipped = timeoutMs < policy.attemptTimeoutMs;
    const timed = timeout(timeoutMs, TimeoutStrategy.Aggressive);
    const once = async (): Promise<T> => {
      try {
        return await timed.execute(({ signal }) => attempt({ signal, attempt: attemptNo }));
      } catch (error) {
        const failure = isTaskCancelledError(error)
          ? new UpstreamError(upstream, clipped ? 'budget_exhausted' : 'timeout', { cause: error })
          : error;
        logFailure(failure, attemptNo, path);
        throw failure;
      }
    };
    return breaker === undefined ? once() : breaker.execute(once);
  }

  return {
    async execute(attempt, { retryable, path }) {
      const plan: RetryPlan = { retriesDone: 0, nextDelayMs: 0 };
      const retries = retry(
        handleWhen((error) => shouldRetry(error, plan)),
        { maxAttempts: retryable ? policy.maxRetries : 0, backoff: new PlannedBackoff(plan) },
      );
      try {
        return await retries.execute(({ attempt: index }) => runAttempt(attempt, index + 1, path));
      } catch (error) {
        if (isBrokenCircuitError(error) || isIsolatedCircuitError(error)) {
          throw new UpstreamError(upstream, 'circuit_open', {
            retryAfterSec: CIRCUIT_OPEN_RETRY_AFTER_SEC,
            cause: error,
          });
        }
        throw error;
      }
    },

    health() {
      if (breaker === undefined) return 'ok';
      switch (breaker.state) {
        case CircuitState.Closed:
          return 'ok';
        case CircuitState.HalfOpen:
          return 'degraded';
        case CircuitState.Open:
        case CircuitState.Isolated:
          return 'unavailable';
      }
    },
  };
}
