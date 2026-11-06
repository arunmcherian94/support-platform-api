import type { NextFunction, Request, Response } from 'express';

/** The three mocked upstreams; each has independent fault settings (S1-5). */
export const UPSTREAMS = ['cases', 'entitlement', 'warehouse'] as const;
export type Upstream = (typeof UPSTREAMS)[number];

export interface FaultConfig {
  /** Added delay before every response, in milliseconds. */
  latencyMs: number;
  /** Share of requests (0–1) that fail with 500. Seeded, so runs are repeatable. */
  errorRate: number;
  /** Force this status on every request (e.g. 429, 503). Null = off. */
  forceStatus: number | null;
  /** `Retry-After` seconds sent with a forced 429 or 503. */
  retryAfterSeconds: number;
  /** Drop the connection without a response. */
  down: boolean;
}

export const DEFAULT_FAULTS: FaultConfig = {
  latencyMs: 0,
  errorRate: 0,
  forceStatus: null,
  retryAfterSeconds: 1,
  down: false,
};

/** Small seeded PRNG (mulberry32) so error-rate faults are deterministic. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isUpstream(value: unknown): value is Upstream {
  return typeof value === 'string' && (UPSTREAMS as readonly string[]).includes(value);
}

/** Validates a partial fault update from env or the admin endpoint. */
export function parseFaultUpdate(input: unknown): Partial<FaultConfig> {
  if (typeof input !== 'object' || input === null) {
    throw new Error('fault update must be an object');
  }
  const raw = input as Record<string, unknown>;
  const update: Partial<FaultConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'upstream':
        break;
      case 'latencyMs':
      case 'retryAfterSeconds':
        if (typeof value !== 'number' || value < 0) throw new Error(`${key} must be a number >= 0`);
        update[key] = value;
        break;
      case 'errorRate':
        if (typeof value !== 'number' || value < 0 || value > 1) {
          throw new Error('errorRate must be between 0 and 1');
        }
        update.errorRate = value;
        break;
      case 'forceStatus':
        if (value !== null && (typeof value !== 'number' || value < 100 || value > 599)) {
          throw new Error('forceStatus must be an HTTP status or null');
        }
        update.forceStatus = value;
        break;
      case 'down':
        if (typeof value !== 'boolean') throw new Error('down must be a boolean');
        update.down = value;
        break;
      default:
        throw new Error(`unknown fault setting: ${key}`);
    }
  }
  return update;
}

export class FaultInjector {
  private readonly faults = new Map<Upstream, FaultConfig>();
  private random: () => number;

  constructor(
    private readonly seed = 42,
    private readonly initial: Partial<Record<Upstream, Partial<FaultConfig>>> = {},
  ) {
    this.random = seededRandom(seed);
    this.reset();
  }

  get(upstream: Upstream): FaultConfig {
    const config = this.faults.get(upstream);
    if (config === undefined) throw new Error(`no fault config for ${upstream}`);
    return config;
  }

  update(upstream: Upstream, change: Partial<FaultConfig>): FaultConfig {
    const next = { ...this.get(upstream), ...change };
    this.faults.set(upstream, next);
    return next;
  }

  /** Restores start-up settings (env) and the PRNG seed. */
  reset(): void {
    for (const upstream of UPSTREAMS) {
      this.faults.set(upstream, { ...DEFAULT_FAULTS, ...this.initial[upstream] });
    }
    this.random = seededRandom(this.seed);
  }

  snapshot(): Record<Upstream, FaultConfig> {
    return {
      cases: this.get('cases'),
      entitlement: this.get('entitlement'),
      warehouse: this.get('warehouse'),
    };
  }

  /** Express middleware applying this upstream's faults before its routes. */
  middleware(upstream: Upstream) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const config = this.get(upstream);
      if (config.latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.latencyMs));
      }
      if (config.down) {
        req.socket.destroy();
        return;
      }
      if (config.forceStatus !== null) {
        if (config.forceStatus === 429 || config.forceStatus === 503) {
          res.set('Retry-After', String(config.retryAfterSeconds));
        }
        res
          .status(config.forceStatus)
          .json({ error: 'injected fault', status: config.forceStatus });
        return;
      }
      if (config.errorRate > 0 && this.random() < config.errorRate) {
        res.status(500).json({ error: 'injected fault', status: 500 });
        return;
      }
      next();
    };
  }
}

/** Reads `MOCK_FAULTS`, e.g. `{"warehouse":{"down":true}}`. */
export function faultsFromEnv(
  value: string | undefined,
): Partial<Record<Upstream, Partial<FaultConfig>>> {
  if (value === undefined || value === '') return {};
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('MOCK_FAULTS must be a JSON object');
  const result: Partial<Record<Upstream, Partial<FaultConfig>>> = {};
  for (const [key, update] of Object.entries(parsed)) {
    if (!isUpstream(key)) throw new Error(`MOCK_FAULTS: unknown upstream ${key}`);
    result[key] = parseFaultUpdate(update);
  }
  return result;
}
