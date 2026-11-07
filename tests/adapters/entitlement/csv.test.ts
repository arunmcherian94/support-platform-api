import { describe, expect, it } from 'vitest';
import {
  parseAccountsCsv,
  parseArr,
  parseCsv,
  parseIsoDate,
} from '../../../src/adapters/entitlement/csv.js';

const HEADER = 'account_id,name,support_tier,contract_end,arr_usd';

describe('parseCsv (RFC 4180)', () => {
  it('handles quoted fields with embedded commas, quotes and line breaks', () => {
    const text = 'a,"b, with comma","say ""hi""","two\nlines"\r\nx,y,z,w\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b, with comma', 'say "hi"', 'two\nlines'],
      ['x', 'y', 'z', 'w'],
    ]);
  });

  it('accepts LF, CRLF, no trailing newline and skips blank lines', () => {
    expect(parseCsv('a,b\n\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('rejects an unterminated quote instead of guessing where the field ends', () => {
    expect(() => parseCsv('a,"open\nb,c\n')).toThrow(/unterminated/);
  });
});

describe('field parsers', () => {
  it('turns ARR into a two-decimal string without floats', () => {
    expect(parseArr('480000')).toBe('480000.00');
    expect(parseArr('1234.5')).toBe('1234.50');
    expect(parseArr('0.07')).toBe('0.07');
    expect(parseArr('007')).toBe('7.00');
    // Beyond float precision: still exact.
    expect(parseArr('90071992547409931.99')).toBe('90071992547409931.99');
    for (const bad of ['', 'abc', '-5', '1.234', '1e6', '1,000', '12.']) {
      expect(parseArr(bad)).toBeNull();
    }
  });

  it('accepts only real YYYY-MM-DD dates', () => {
    expect(parseIsoDate('2027-01-15')).toBe('2027-01-15');
    for (const bad of ['2027-02-30', '2027-13-01', '15/01/2027', '2027-1-5', '']) {
      expect(parseIsoDate(bad)).toBeNull();
    }
  });
});

describe('parseAccountsCsv', () => {
  it('parses valid rows, lowercasing the tier and keeping quoted names', () => {
    const { rows, events } = parseAccountsCsv(
      `${HEADER}\nACC-001,"Smith, Jones & Co",Platinum,2027-01-15,480000\n`,
    );
    expect(events).toEqual([]);
    expect(rows).toEqual([
      {
        sourceId: 'ACC-001',
        name: 'Smith, Jones & Co',
        supportTier: 'platinum',
        contractEnd: '2027-01-15',
        arr: { amount: '480000.00', currency: 'USD' },
        line: 2,
      },
    ]);
  });

  it('skips malformed rows and reports each one without the name or ARR', () => {
    const text = [
      HEADER,
      'ACC-001,Alpha,Gold,2027-01-15,100',
      'ACC-002,Beta,Gold,2027-01-15', // too few columns
      'ACC-003,Gamma,Diamond,2027-01-15,100', // unknown tier
      'ACC-004,Delta,Gold,2027-02-30,100', // bad date
      'ACC-005,Epsilon,Gold,2027-01-15,lots', // non-numeric ARR
      'ACC-006,Zeta,Silver,2027-01-15,1234.5',
    ].join('\n');
    const { rows, events } = parseAccountsCsv(text);
    expect(rows.map((row) => row.sourceId)).toEqual(['ACC-001', 'ACC-006']);
    expect(rows[1]?.arr.amount).toBe('1234.50');
    expect(events.map((event) => [event.kind, event.line, event.accountId])).toEqual([
      ['malformed_row', 3, undefined],
      ['malformed_row', 4, 'ACC-003'],
      ['malformed_row', 5, 'ACC-004'],
      ['malformed_row', 6, 'ACC-005'],
    ]);
    const serialised = JSON.stringify(events);
    for (const secret of ['Beta', 'Gamma', 'Delta', 'Epsilon', 'lots']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('rejects an export whose header is missing or reordered', () => {
    expect(() => parseAccountsCsv('ACC-001,Alpha,Gold,2027-01-15,100\n')).toThrow(/header/);
    expect(() => parseAccountsCsv('account_id,support_tier,name,contract_end,arr_usd\n')).toThrow(
      /header/,
    );
    expect(() => parseAccountsCsv('')).toThrow(/header/);
  });

  it('tolerates a byte order mark before the header', () => {
    const { rows } = parseAccountsCsv(
      `${String.fromCharCode(0xfeff)}${HEADER}\nACC-001,Alpha,Gold,2027-01-15,100\n`,
    );
    expect(rows).toHaveLength(1);
  });
});
