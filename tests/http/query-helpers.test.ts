import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { queryInt, queryList, queryString } from '../../src/http/handlers/shared.js';

const req = (query: Record<string, unknown>) => ({ query }) as unknown as Request;

describe('query helpers after validation', () => {
  it('reads integers the validator coerced to numbers (renewalWithinDays, limit)', () => {
    expect(queryInt(req({ renewalWithinDays: 90 }), 'renewalWithinDays')).toBe(90);
    expect(queryInt(req({ limit: '25' }), 'limit')).toBe(25);
    expect(queryInt(req({}), 'limit')).toBeUndefined();
  });

  it('throws rather than reading a wrongly typed value as absent', () => {
    expect(() => queryInt(req({ limit: 'x' }), 'limit')).toThrow(/not an integer/);
    expect(() => queryList(req({ status: { a: 1 } }), 'status')).toThrow(/unexpected type/);
  });

  it('reads single and repeated values as lists', () => {
    expect(queryList(req({ status: 'open' }), 'status')).toEqual(['open']);
    expect(queryList(req({ status: ['open', 'closed'] }), 'status')).toEqual(['open', 'closed']);
    expect(queryString(req({ sort: 'openedAt' }), 'sort')).toBe('openedAt');
  });
});
