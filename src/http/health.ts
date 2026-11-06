import type { RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';

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
 * Liveness and readiness (openapi.yaml `getLiveness`, `getReadiness`).
 * Readiness depends on the database only for now; the read path adds the
 * entitlement snapshot as a required check and reports the upstreams.
 */
export function healthHandlers(
  db: DatabaseSync,
  isDraining: () => boolean = () => false,
): Record<string, RequestHandler> {
  return {
    getLiveness: (_req, res) => {
      res.json({ status: 'ok' });
    },
    getReadiness: (_req, res) => {
      const database = databaseStatus(db);
      // Shutting down: report not-ready so load balancers stop routing here first.
      const ready = database === 'ok' && !isDraining();
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : 'unavailable',
        checks: {
          database,
          // Not wired yet: reported, not required (read path).
          entitlementSnapshot: 'unavailable',
          caseSystem: 'unavailable',
          usageWarehouse: 'unavailable',
        },
        unmatchedAccountIds: [],
      });
    },
  };
}
