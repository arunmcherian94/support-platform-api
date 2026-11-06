import { Router } from 'express';
import type { UpstreamDeps, UpstreamModule } from '../server.js';

// Stub: replaced by the cases slice.
export function casesRouter(_deps: UpstreamDeps): UpstreamModule {
  return { router: Router(), reset: () => undefined };
}
