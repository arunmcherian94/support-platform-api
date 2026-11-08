import type { NextFunction, Request, Response } from 'express';

/** The three mocked upstreams; each has independent fault settings (S1-5). */
export const UPSTREAMS = ['cases', 'entitlement', 'warehouse'] as const;
export type Upstream = (typeof UPSTREAMS)[number];

export interface FaultConfig {
  /** Added delay before every response, in milliseconds. */
  latencyMs: number;
  /** Force this status on every request (e.g. 429, 503). Null = off. */
  forceStatus: number | null;
  /** `Retry-After` seconds sent with a forced 429 or 503. */
  retryAfterSeconds: number;
  /** Drop the connection without a response. */
  down: boolean;
}

export const DEFAULT_FAULTS: FaultConfig = {
  latencyMs: 0,
  forceStatus: null,
  retryAfterSeconds: 1,
  down: false,
};

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

  constructor(private readonly initial: Partial<Record<Upstream, Partial<FaultConfig>>> = {}) {
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

  /** Restores start-up settings (env). */
  reset(): void {
    for (const upstream of UPSTREAMS) {
      this.faults.set(upstream, { ...DEFAULT_FAULTS, ...this.initial[upstream] });
    }
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
