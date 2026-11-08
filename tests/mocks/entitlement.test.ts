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

const get = (path: string): Promise<Response> => fetch(`${h.url}${path}`);

describe('mock entitlement exports (S1-3)', () => {
  describe('accounts.csv', () => {
    it('serves the fixture bytes with export metadata', async () => {
      const res = await get('/exports/accounts.csv');
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(csvFile);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('x-export-timestamp')).toBe('2026-11-06T02:00:00Z');
    });

    it('preserves the ACC-77 quirk row', async () => {
      const text = await (await get('/exports/accounts.csv')).text();
      expect(text).toContain('ACC-77');
    });
  });

  describe('entitlements.xml', () => {
    it('serves the fixture bytes', async () => {
      const res = await get('/feeds/entitlements.xml');
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(xmlFile);
      expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(res.headers.get('x-export-timestamp')).toBeNull();
    });
  });
});
