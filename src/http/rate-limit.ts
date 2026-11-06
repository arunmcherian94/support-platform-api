/**
 * Rate limiting (S2 §2 item 6, S2-7): token buckets keyed by OAuth client and,
 * for delegated tokens, also by agent (`act.sub`). A request needs a token from
 * every applicable bucket; agents get their own, tighter budget so a looping
 * agent can't exhaust its user's client quota.
 *
 * Responses carry `RateLimit-Policy` and `RateLimit`
 * (draft-ietf-httpapi-ratelimit-headers-11) for the tighter bucket, so
 * well-behaved clients can pace themselves; refusals are 429 `rate-limited` with
 * `Retry-After`.
 *
 * Limits are in memory and per instance: N replicas allow N times the quota.
 * Distributed limiting (gateway or Redis) is deferred (DECISIONS.md).
 * Requests without an identity (health probes) pass through untouched;
 * unauthenticated floods are the gateway's job.
 */
import type { RequestHandler } from 'express';
import type { Clock } from '../clock.js';
import type { AuthLocals, Identity } from '../auth/types.js';
import { AppError } from './problems.js';

const WINDOW_SECONDS = 60;
const WINDOW_MS = WINDOW_SECONDS * 1000;

export type PolicyName = 'client' | 'agent';

export interface RateLimitOptions {
  clock: Clock;
  clientPerMinute: number;
  agentPerMinute: number;
  /** Sweep full (idle) buckets every this many requests. */
  sweepEvery?: number;
  /** Also sweep when a new bucket would take the map past this size. */
  maxBuckets?: number;
}

/** The outcome for one request, reported for the tighter applicable bucket. */
export interface RateLimitDecision {
  allowed: boolean;
  policy: PolicyName;
  quota: number;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until the reported bucket is full again. */
  resetSeconds: number;
  /** Seconds until a token is available (refusals only). */
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  take(identity: Identity): RateLimitDecision;
  /** Number of buckets held; for tests and metrics. */
  size(): number;
}

interface Bucket {
  tokens: number;
  updatedMs: number;
  capacity: number;
}

interface BucketView {
  policy: PolicyName;
  bucket: Bucket;
}

export function createTokenBuckets(options: RateLimitOptions): RateLimiter {
  const { clock, clientPerMinute, agentPerMinute } = options;
  const sweepEvery = options.sweepEvery ?? 1000;
  const maxBuckets = options.maxBuckets ?? 10_000;
  const buckets = new Map<string, Bucket>();
  let requests = 0;

  /** Brings a bucket up to date with continuous refill. */
  function refill(bucket: Bucket, nowMs: number): void {
    const elapsed = Math.max(0, nowMs - bucket.updatedMs);
    bucket.tokens = Math.min(
      bucket.capacity,
      bucket.tokens + (elapsed * bucket.capacity) / WINDOW_MS,
    );
    bucket.updatedMs = nowMs;
  }

  /**
   * Drops buckets that have refilled completely: a new bucket starts full, so
   * forgetting them changes no decision. Buckets still refilling are kept, so
   * the map is bounded by the clients and agents active in the last minute.
   */
  function sweep(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      refill(bucket, nowMs);
      if (bucket.tokens >= bucket.capacity) buckets.delete(key);
    }
  }

  function bucketFor(key: string, capacity: number, nowMs: number): Bucket {
    const existing = buckets.get(key);
    if (existing !== undefined) {
      refill(existing, nowMs);
      return existing;
    }
    if (buckets.size >= maxBuckets) sweep(nowMs);
    const created: Bucket = { tokens: capacity, updatedMs: nowMs, capacity };
    buckets.set(key, created);
    return created;
  }

  const secondsToFull = (bucket: Bucket): number =>
    Math.ceil(((bucket.capacity - bucket.tokens) * WINDOW_SECONDS) / bucket.capacity);
  const secondsToOneToken = (bucket: Bucket): number =>
    Math.max(1, Math.ceil(((1 - bucket.tokens) * WINDOW_SECONDS) / bucket.capacity));

  function report(view: BucketView, allowed: boolean): RateLimitDecision {
    const decision: RateLimitDecision = {
      allowed,
      policy: view.policy,
      quota: view.bucket.capacity,
      remaining: Math.floor(view.bucket.tokens),
      resetSeconds: secondsToFull(view.bucket),
    };
    if (!allowed) decision.retryAfterSeconds = secondsToOneToken(view.bucket);
    return decision;
  }

  return {
    take(identity) {
      const nowMs = clock.now().getTime();
      requests += 1;
      if (requests % sweepEvery === 0) sweep(nowMs);

      const views: BucketView[] = [
        {
          policy: 'client',
          bucket: bucketFor(`client:${identity.clientId}`, clientPerMinute, nowMs),
        },
      ];
      if (identity.agent !== undefined) {
        views.push({
          policy: 'agent',
          bucket: bucketFor(`agent:${identity.agent}`, agentPerMinute, nowMs),
        });
      }

      const refusing = views.filter((view) => view.bucket.tokens < 1);
      if (refusing.length > 0) {
        // Nothing is consumed; report the bucket the caller must wait longest for.
        const longest = refusing.reduce((a, b) =>
          secondsToOneToken(b.bucket) > secondsToOneToken(a.bucket) ? b : a,
        );
        return report(longest, false);
      }

      for (const view of views) view.bucket.tokens -= 1;
      // The tighter bucket has fewer whole tokens left; ties go to the agent.
      const tighter = views.reduce((a, b) =>
        Math.floor(b.bucket.tokens) <= Math.floor(a.bucket.tokens) ? b : a,
      );
      return report(tighter, true);
    },
    size: () => buckets.size,
  };
}

/** Express middleware; runs after authentication (`AppDeps.afterAuth`). */
export function createRateLimiter(
  options: RateLimitOptions,
): RequestHandler & { limiter: RateLimiter } {
  const limiter = createTokenBuckets(options);
  const middleware: RequestHandler = (_req, res, next) => {
    const identity = (res.locals as AuthLocals).identity;
    if (identity === undefined) {
      next();
      return;
    }
    const decision = limiter.take(identity);
    const name = `"${decision.policy}"`;
    res.set('RateLimit-Policy', `${name};q=${String(decision.quota)};w=${String(WINDOW_SECONDS)}`);
    res.set(
      'RateLimit',
      `${name};r=${String(decision.remaining)};t=${String(decision.resetSeconds)}`,
    );
    if (!decision.allowed) {
      next(
        new AppError(
          'rate-limited',
          `Quota of ${String(decision.quota)} requests per ${String(WINDOW_SECONDS)} seconds exceeded.`,
          { headers: { 'Retry-After': String(decision.retryAfterSeconds ?? 1) } },
        ),
      );
      return;
    }
    next();
  };
  return Object.assign(middleware, { limiter });
}
