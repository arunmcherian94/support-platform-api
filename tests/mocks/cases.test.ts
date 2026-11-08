import { describe, expect, it } from 'vitest';
import { useMockServer } from './helpers.js';

const h = useMockServer();

describe('case system read (S1-2)', () => {
  it('preserves the mixed casing and returns a quoted ETag', async () => {
    const res = await fetch(`${h.url}/cases/CS-10231`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"3"');
    const record = (await res.json()) as Record<string, unknown>;
    expect(record).toMatchObject({
      Status: 'open',
      IsEscalated: false,
      openedAt: '2026-10-24T08:12:00Z',
      accountId: 'ACC-007',
    });
    expect(Array.isArray(record.Comments)).toBe(true);
    expect(record).not.toHaveProperty('status');
    expect(record).not.toHaveProperty('comments');
  });
});
