import { Router } from 'express';
import type { UpstreamDeps, UpstreamModule } from '../server.js';

// Stub: replaced by the entitlement slice.
export function entitlementRouter(_deps: UpstreamDeps): UpstreamModule {
  return { router: Router(), reset: () => undefined };
}
