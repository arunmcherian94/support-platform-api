import { describe, expect, it } from 'vitest';
import { parseEntitlementsXml } from '../../../src/adapters/entitlement/xml.js';

describe('parseEntitlementsXml', () => {
  it('parses a single account (not collapsed into an object)', () => {
    const feed = parseEntitlementsXml(
      '<entitlements generatedAt="2026-11-06T11:00:00Z"><account id="ACC-007"><tier>Platinum</tier><renewal>2027-01-15</renewal></account></entitlements>',
    );
    expect(feed.generatedAt).toBe('2026-11-06T11:00:00Z');
    expect(feed.rows).toEqual([
      { sourceId: 'ACC-007', supportTier: 'platinum', renewal: '2027-01-15', position: 1 },
    ]);
    expect(feed.events).toEqual([]);
  });

  it('parses many accounts and keeps IDs and dates as strings', () => {
    const feed = parseEntitlementsXml(`<?xml version="1.0"?>
      <entitlements generatedAt="2026-11-06T11:00:00Z">
        <account id="ACC-030"><tier>Platinum</tier><renewal>2027-01-31</renewal></account>
        <account id="042"><tier>gold</tier><renewal>2027-01-10</renewal></account>
      </entitlements>`);
    expect(feed.rows.map((row) => [row.sourceId, row.supportTier, row.renewal])).toEqual([
      ['ACC-030', 'platinum', '2027-01-31'],
      ['042', 'gold', '2027-01-10'],
    ]);
  });

  it('handles an empty feed', () => {
    expect(parseEntitlementsXml('<entitlements generatedAt="2026-11-06T11:00:00Z"/>').rows).toEqual(
      [],
    );
    expect(parseEntitlementsXml('<entitlements></entitlements>')).toEqual({
      generatedAt: null,
      rows: [],
      events: [],
    });
  });

  it('does not expand DOCTYPE entities; the poisoned value fails validation', () => {
    const feed = parseEntitlementsXml(`<?xml version="1.0"?>
      <!DOCTYPE e [<!ENTITY t "Platinum">]>
      <entitlements generatedAt="2026-11-06T11:00:00Z">
        <account id="ACC-001"><tier>&t;</tier><renewal>2027-01-15</renewal></account>
      </entitlements>`);
    expect(feed.rows).toEqual([]);
    expect(feed.events).toMatchObject([
      { kind: 'malformed_row', accountId: 'ACC-001', reason: 'unknown or missing tier' },
    ]);
  });

  it('skips bad accounts and reports them', () => {
    const feed = parseEntitlementsXml(`<entitlements generatedAt="2026-11-06T11:00:00Z">
        <account><tier>Gold</tier><renewal>2027-01-15</renewal></account>
        <account id="ACC-002"><tier>Gold</tier><renewal>soon</renewal></account>
        <account id="ACC-003"/>
        <account id="ACC-004"><tier>Silver</tier><renewal>2027-03-01</renewal></account>
      </entitlements>`);
    expect(feed.rows.map((row) => row.sourceId)).toEqual(['ACC-004']);
    expect(feed.events.map((event) => [event.position, event.accountId])).toEqual([
      [1, undefined],
      [2, 'ACC-002'],
      [3, 'ACC-003'],
    ]);
  });

  it('treats an unparseable generatedAt as absent', () => {
    expect(parseEntitlementsXml('<entitlements generatedAt="yesterday"/>').generatedAt).toBeNull();
  });

  it('rejects documents that are not the feed', () => {
    expect(() => parseEntitlementsXml('<accounts/>')).toThrow(/root/);
    expect(() => parseEntitlementsXml('not xml at all')).toThrow();
    expect(() => parseEntitlementsXml('<entitlements><account')).toThrow();
  });
});
