import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useMockServer } from './helpers.js';

const h = useMockServer();

const csvFile = readFileSync(
  new URL('../../mocks/fixtures/entitlement/accounts.csv', import.meta.url),
);
const xmlFile = readFileSync(
  new URL('../../mocks/fixtures/entitlement/entitlements.xml', import.meta.url),
);
const csvModified = new Date('2026-11-06T02:00:00Z').toUTCString();
const xmlModified = new Date('2026-11-06T11:00:00Z').toUTCString();

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${h.url}${path}`, { headers });

describe('mock entitlement exports (S1-3)', () => {
  describe('accounts.csv', () => {
    it('serves the fixture bytes with export metadata', async () => {
      const res = await get('/exports/accounts.csv');
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(csvFile);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('x-export-timestamp')).toBe('2026-11-06T02:00:00Z');
      expect(res.headers.get('last-modified')).toBe(csvModified);
      expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/);
    });

    it('preserves the ACC-77 quirk row', async () => {
      const text = await (await get('/exports/accounts.csv')).text();
      expect(text).toContain('ACC-77');
    });

    it('returns 304 without a body for a matching If-None-Match', async () => {
      const etag = (await get('/exports/accounts.csv')).headers.get('etag') ?? '';
      const res = await get('/exports/accounts.csv', { 'If-None-Match': etag });
      expect(res.status).toBe(304);
      expect(res.headers.get('etag')).toBe(etag);
      expect(res.headers.get('last-modified')).toBe(csvModified);
      expect(await res.text()).toBe('');
    });

    it('matches a tag inside a list and the wildcard', async () => {
      const etag = (await get('/exports/accounts.csv')).headers.get('etag') ?? '';
      const list = await get('/exports/accounts.csv', { 'If-None-Match': `"other", ${etag}` });
      expect(list.status).toBe(304);
      const star = await get('/exports/accounts.csv', { 'If-None-Match': '*' });
      expect(star.status).toBe(304);
    });

    it('lets If-None-Match take precedence over If-Modified-Since', async () => {
      const res = await get('/exports/accounts.csv', {
        'If-None-Match': '"different"',
        'If-Modified-Since': csvModified,
      });
      expect(res.status).toBe(200);
    });

    it('returns 304 when If-Modified-Since equals or follows Last-Modified', async () => {
      const equal = await get('/exports/accounts.csv', { 'If-Modified-Since': csvModified });
      expect(equal.status).toBe(304);
      const later = await get('/exports/accounts.csv', {
        'If-Modified-Since': new Date('2026-11-07T00:00:00Z').toUTCString(),
      });
      expect(later.status).toBe(304);
    });

    it('returns 200 when If-Modified-Since is earlier or unparseable', async () => {
      const earlier = await get('/exports/accounts.csv', {
        'If-Modified-Since': new Date('2026-11-06T01:59:59Z').toUTCString(),
      });
      expect(earlier.status).toBe(200);
      const junk = await get('/exports/accounts.csv', { 'If-Modified-Since': 'not a date' });
      expect(junk.status).toBe(200);
    });
  });

  describe('entitlements.xml', () => {
    it('serves the fixture bytes with Last-Modified from generatedAt', async () => {
      const res = await get('/feeds/entitlements.xml');
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(xmlFile);
      expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(res.headers.get('last-modified')).toBe(xmlModified);
      expect(res.headers.get('x-export-timestamp')).toBeNull();
    });

    it('has its own ETag, distinct from the CSV', async () => {
      const xml = (await get('/feeds/entitlements.xml')).headers.get('etag');
      const csv = (await get('/exports/accounts.csv')).headers.get('etag');
      expect(xml).toMatch(/^"[0-9a-f]{16}"$/);
      expect(xml).not.toBe(csv);
    });

    it('supports conditional GET', async () => {
      const etag = (await get('/feeds/entitlements.xml')).headers.get('etag') ?? '';
      const byTag = await get('/feeds/entitlements.xml', { 'If-None-Match': etag });
      expect(byTag.status).toBe(304);
      expect(await byTag.text()).toBe('');
      const bySince = await get('/feeds/entitlements.xml', { 'If-Modified-Since': xmlModified });
      expect(bySince.status).toBe(304);
      const stale = await get('/feeds/entitlements.xml', {
        'If-Modified-Since': new Date('2026-11-06T10:00:00Z').toUTCString(),
      });
      expect(stale.status).toBe(200);
    });
  });
});
