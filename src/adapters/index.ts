import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { CaseSystem } from '../ports/cases.js';
import type { EntitlementSource } from '../ports/entitlement.js';
import type { UsageWarehouse } from '../ports/usage.js';
import { createCaseSystem } from './cases.js';
import { createEntitlementSource } from './entitlement/source.js';
import { createUpstreamClient } from './http.js';
import type { UpstreamClient } from './types.js';
import { createUsageWarehouse } from './warehouse.js';

/** The three upstreams behind their ports, plus the clients readiness reports on. */
export interface Upstreams {
  cases: CaseSystem;
  warehouse: UsageWarehouse;
  entitlement: EntitlementSource;
  clients: { cases: UpstreamClient; warehouse: UpstreamClient };
}

/** Builds each adapter on its own resilient client (one breaker per upstream, S3 §2.3). */
export function createUpstreams(deps: { config: Config; clock: Clock; logger: Logger }): Upstreams {
  const { config, clock, logger } = deps;
  const client = (upstream: UpstreamClient['upstream'], baseUrl: string): UpstreamClient =>
    createUpstreamClient({ upstream, baseUrl, logger, clock });
  const casesClient = client('case_system', config.upstreams.cases);
  const warehouseClient = client('usage_warehouse', config.upstreams.warehouse);
  return {
    cases: createCaseSystem(casesClient),
    warehouse: createUsageWarehouse(warehouseClient),
    entitlement: createEntitlementSource({
      client: client('entitlement', config.upstreams.entitlement),
      clock,
      logger,
      refreshSeconds: config.entitlementRefreshSeconds,
    }),
    clients: { cases: casesClient, warehouse: warehouseClient },
  };
}
