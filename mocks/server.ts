import express, { type Express, type Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { systemClock, type Clock } from '../src/clock.js';
import { FaultInjector, faultsFromEnv, isUpstream, parseFaultUpdate } from './faults.js';
import { casesRouter } from './upstreams/cases.js';
import { entitlementRouter } from './upstreams/entitlement.js';
import { warehouseRouter } from './upstreams/warehouse.js';

/** What every upstream route group receives. */
export interface UpstreamDeps {
  clock: Clock;
}

/** A route group plus a hook to restore its seeded state. */
export interface UpstreamModule {
  router: Router;
  reset(): void;
}

export interface MockServerOptions {
  clock?: Clock;
  faults?: FaultInjector;
}

export interface MockApp {
  app: Express;
  faults: FaultInjector;
  reset(): void;
}

/**
 * One process serving the three mocked upstreams (ADR-0002), each behind its
 * own fault injection, plus the admin endpoints used by tests and demos.
 */
export function createMockApp(options: MockServerOptions = {}): MockApp {
  const clock = options.clock ?? systemClock();
  const faults = options.faults ?? new FaultInjector();
  const modules = {
    cases: casesRouter({ clock }),
    entitlement: entitlementRouter({ clock }),
    warehouse: warehouseRouter({ clock }),
  };
  const reset = (): void => {
    faults.reset();
    for (const module of Object.values(modules)) module.reset();
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/__admin/faults', (_req, res) => {
    res.json(faults.snapshot());
  });
  app.post('/__admin/faults', (req, res) => {
    const body: unknown = req.body;
    const upstream =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).upstream
        : undefined;
    if (!isUpstream(upstream)) {
      res.status(400).json({ error: 'upstream must be one of cases, entitlement, warehouse' });
      return;
    }
    try {
      res.json(faults.update(upstream, parseFaultUpdate(body)));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  app.post('/__admin/reset', (_req, res) => {
    reset();
    res.status(204).end();
  });

  // Faults are scoped by path prefix, so each upstream fails independently.
  // Routers declare full paths.
  app.use('/cases', faults.middleware('cases'));
  app.use(['/exports', '/feeds'], faults.middleware('entitlement'));
  app.use('/api/v2', faults.middleware('warehouse'));
  app.use(modules.cases.router, modules.entitlement.router, modules.warehouse.router);

  return { app, faults, reset };
}

/** Starts the mock server; port 0 picks a free port (tests). */
export async function startMockServer(
  port: number,
  options: MockServerOptions = {},
): Promise<{ server: Server; url: string; mock: MockApp }> {
  const mock = createMockApp(options);
  const server = await new Promise<Server>((resolve) => {
    const s = mock.app.listen(port, () => {
      resolve(s);
    });
  });
  const { port: bound } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${bound}`, mock };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT ?? 8081);
  const faults = new FaultInjector(faultsFromEnv(process.env.MOCK_FAULTS));
  const { url } = await startMockServer(port, { faults });
  console.log(`mock upstreams listening on ${url} (NOW=${process.env.NOW ?? 'system time'})`);
}
