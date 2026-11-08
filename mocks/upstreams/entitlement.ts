import { readFileSync } from 'node:fs';
import { Router, type Response } from 'express';
import type { UpstreamDeps, UpstreamModule } from '../server.js';

const fixtureDir = new URL('../fixtures/entitlement/', import.meta.url);

interface Export {
  body: Buffer;
  contentType: string;
  extraHeaders: Record<string, string>;
}

function load(): { csv: Export; xml: Export } {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureDir), 'utf8')) as Record<
    string,
    { exportedAt: string }
  >;
  const exportedAt = manifest['accounts.csv']?.exportedAt;
  if (exportedAt === undefined) throw new Error('manifest.json lacks accounts.csv exportedAt');
  const csvBytes = readFileSync(new URL('accounts.csv', fixtureDir));
  const xmlBytes = readFileSync(new URL('entitlements.xml', fixtureDir));
  const generatedAt = /<entitlements\b[^>]*\bgeneratedAt="([^"]+)"/.exec(
    xmlBytes.toString('utf8'),
  )?.[1];
  if (generatedAt === undefined) throw new Error('entitlements.xml lacks generatedAt');
  return {
    csv: {
      body: csvBytes,
      contentType: 'text/csv; charset=utf-8',
      extraHeaders: { 'X-Export-Timestamp': exportedAt },
    },
    xml: {
      body: xmlBytes,
      contentType: 'application/xml; charset=utf-8',
      extraHeaders: {},
    },
  };
}

function serve(res: Response, entry: Export): void {
  // end() with the raw bytes: no Express ETag/freshness handling, bytes unchanged.
  res.status(200).set(entry.extraHeaders).set('Content-Type', entry.contentType).end(entry.body);
}

/** Mock ERP exports: static fixture files; the CSV carries its export time in a header. */
export function entitlementRouter(_deps: UpstreamDeps): UpstreamModule {
  const { csv, xml } = load();
  const router = Router();
  router.get('/exports/accounts.csv', (_req, res) => {
    serve(res, csv);
  });
  router.get('/feeds/entitlements.xml', (_req, res) => {
    serve(res, xml);
  });
  return { router, reset: () => undefined };
}
