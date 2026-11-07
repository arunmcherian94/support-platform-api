import { describe, expect, it } from 'vitest';
import {
  canonicalFormat,
  loadCrosswalk,
  normalizeAccountId,
  parseCrosswalk,
} from '../../../src/adapters/entitlement/ids.js';

describe('account ID normalisation', () => {
  const crosswalk = loadCrosswalk();

  it('loads the fixture crosswalk', () => {
    expect([...crosswalk]).toEqual([['ACC-77', 'ACC-007']]);
  });

  it('applies the crosswalk before formatting: ACC-77 is ACC-007, not ACC-077', () => {
    expect(normalizeAccountId('ACC-77', crosswalk)).toBe('ACC-007');
    expect(normalizeAccountId('ACC-77', new Map())).toBe('ACC-077');
  });

  it('normalises formatting variants', () => {
    expect(normalizeAccountId('acc-7', crosswalk)).toBe('ACC-007');
    expect(normalizeAccountId('ACC07', crosswalk)).toBe('ACC-007');
    expect(normalizeAccountId(' ACC-012 ', crosswalk)).toBe('ACC-012');
    expect(canonicalFormat('ACC-1234')).toBe('ACC-1234');
  });

  it('rejects anything else, including names', () => {
    for (const bad of ['', 'Acme Corp', '007', 'ACC-', 'ACC-7a', 'CUST-007', 'ACC--7', 'ACC 7']) {
      expect(normalizeAccountId(bad, crosswalk)).toBeNull();
    }
  });

  it('refuses a malformed crosswalk instead of silently dropping aliases', () => {
    expect(() => parseCrosswalk('from,to\nACC-77,ACC-007\n')).toThrow(/header/);
    expect(() => parseCrosswalk('source_id,canonical_id\nACC-77,Acme\n')).toThrow(/row 2/);
    expect(parseCrosswalk('source_id,canonical_id\nX-1,acc-9\n').get('X-1')).toBe('ACC-009');
  });
});
