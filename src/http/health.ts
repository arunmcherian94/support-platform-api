import type { RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { Upstreams } from '../adapters/index.js';

type CheckStatus = 'ok' | 'degraded' | 'unavailable';

function databaseStatus(db: DatabaseSync): CheckStatus {
  try {
    db.prepare('SELECT 1').get();
    return 'ok';
  } catch {
    return 'unavailable';
  }
}

/**
 * Liveness and readiness (openapi.yaml `getLiveness`, `getReadiness`; S3 §2.7).
 * Readiness fails only on the database or an unusable entitlement snapshot.
 * The case system and warehouse are reported from breaker state, never
 * probed, and never fail readiness: an upstream outage must not take every
 * replica out of rotation.
 */
export function healthHandlers(
  db: DatabaseSync,
  isDraining: () => boolean = () => false,
  upstreams?: Upstreams,
): Record<string, RequestHandler> {
  return {
    getLiveness: (_req, res) => {
      res.json({ status: 'ok' });
    },
    getReadiness: (_req, res) => {
      const database = databaseStatus(db);
      const entitlementSnapshot: CheckStatus =
        upstreams?.entitlement.current().usable === true ? 'ok' : 'unavailable';
      // Shutting down: report not-ready so load balancers stop routing here first.
      const ready = database === 'ok' && entitlementSnapshot === 'ok' && !isDraining();
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : 'unavailable',
        checks: {
          database,
          entitlementSnapshot,
          caseSystem: upstreams?.clients.cases.health() ?? 'unavailable',
          usageWarehouse: upstreams?.clients.warehouse.health() ?? 'unavailable',
        },
        unmatchedAccountIds: upstreams?.entitlement.unmatchedAccountIds() ?? [],
      });
    },
  };
}
