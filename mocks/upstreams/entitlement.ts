import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Router, type Request, type Response } from 'express';
import type { UpstreamDeps, UpstreamModule } from '../server.js';

const fixtureDir = new URL('../fixtures/entitlement/', import.meta.url);

interface Export {
  body: Buffer;
  contentType: string;
  etag: string;
  lastModified: Date;
  extraHeaders: Record<string, string>;
}

function strongEtag(bytes: Buffer): string {
  return `"${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"`;
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
      etag: strongEtag(csvBytes),
      lastModified: new Date(exportedAt),
      extraHeaders: { 'X-Export-Timestamp': exportedAt },
    },
    xml: {
      body: xmlBytes,
      contentType: 'application/xml; charset=utf-8',
      etag: strongEtag(xmlBytes),
      lastModified: new Date(generatedAt),
      extraHeaders: {},
    },
  };
}

/** RFC 9110 §13.1-13.2: If-None-Match decides when present; else If-Modified-Since. */
function notModified(req: Request, entry: Export): boolean {
  const inm = req.get('If-None-Match');
  if (inm !== undefined) {
    const tags = inm.split(',').map((t) => t.trim());
    return tags.includes('*') || tags.includes(entry.etag);
  }
  const ims = req.get('If-Modified-Since');
  if (ims === undefined) return false;
  const since = Date.parse(ims);
  if (Number.isNaN(since)) return false;
  return Math.floor(entry.lastModified.getTime() / 1000) <= Math.floor(since / 1000);
}

function serve(req: Request, res: Response, entry: Export): void {
  res.set({
    ETag: entry.etag,
    'Last-Modified': entry.lastModified.toUTCString(),
    ...entry.extraHeaders,
  });
  if (notModified(req, entry)) {
    res.status(304).end();
    return;
  }
  // end() with the raw bytes: no Express ETag/freshness handling, bytes unchanged.
  res.status(200).set('Content-Type', entry.contentType).end(entry.body);
}

/** Mock ERP exports: static fixtures with validators for cheap conditional polling (ADR-0003). */
export function entitlementRouter(_deps: UpstreamDeps): UpstreamModule {
  const { csv, xml } = load();
  const router = Router();
  router.get('/exports/accounts.csv', (req, res) => {
    serve(req, res, csv);
  });
  router.get('/feeds/entitlements.xml', (req, res) => {
    serve(req, res, xml);
  });
  return { router, reset: () => undefined };
}
