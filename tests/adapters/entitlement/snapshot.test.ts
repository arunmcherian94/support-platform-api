import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAccountsCsv } from '../../../src/adapters/entitlement/csv.js';
import { loadCrosswalk } from '../../../src/adapters/entitlement/ids.js';
import { buildSnapshot, type SnapshotInput } from '../../../src/adapters/entitlement/snapshot.js';
import { parseEntitlementsXml } from '../../../src/adapters/entitlement/xml.js';

const fixtures = new URL('../../../mocks/fixtures/entitlement/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, fixtures), 'utf8');

const manifest = JSON.parse(read('manifest.json')) as Record<string, { exportedAt: string }>;
const exportedAt = manifest['accounts.csv']?.exportedAt ?? '';
const csv = parseAccountsCsv(read('accounts.csv'));
const xml = parseEntitlementsXml(read('entitlements.xml'));
const crosswalk = loadCrosswalk();

function fixtureInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    csv: { rows: csv.rows, exportedAt },
    xml: { rows: xml.rows, generatedAt: xml.generatedAt ?? '' },
    crosswalk,
    ...overrides,
  };
}

describe('buildSnapshot against the fixtures (S1 §4 ground truth)', () => {
  const { accounts, xmlOnlyIds, events } = buildSnapshot(fixtureInput());
  const effective = (id: string) => {
    const account = accounts.get(id);
    return account && [account.supportTier, account.renewalDate];
  };

  it('fixture premises: the feed is newer than the export and both parse cleanly', () => {
    expect(exportedAt).toBe('2026-11-06T02:00:00Z');
    expect(xml.generatedAt).toBe('2026-11-06T11:00:00Z');
    expect(csv.events).toEqual([]);
    expect(xml.events).toEqual([]);
  });

  it('has exactly the six canonical accounts', () => {
    expect([...accounts.keys()]).toEqual([
      'ACC-007',
      'ACC-012',
      'ACC-015',
      'ACC-021',
      'ACC-030',
      'ACC-042',
    ]);
    expect(accounts.has('ACC-077')).toBe(false);
  });

  it('ACC-007 comes from CSV ACC-77 through the crosswalk', () => {
    expect(effective('ACC-007')).toEqual(['platinum', '2027-01-15']);
    expect(accounts.get('ACC-007')).toMatchObject({
      name: 'Acme Corp',
      inFeed: true,
      arr: { amount: '480000.00', currency: 'USD' },
    });
  });

  it('ACC-012 uses its latest contract, not the older Gold row', () => {
    expect(effective('ACC-012')).toEqual(['platinum', '2027-02-03']);
    expect(accounts.get('ACC-012')?.arr).toEqual({ amount: '350000.00', currency: 'USD' });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'duplicate_account', accountId: 'ACC-012', line: 3 }),
    );
  });

  it('ACC-015 is not in the feed, so both fields come from the export', () => {
    expect(accounts.get('ACC-015')).toMatchObject({
      supportTier: 'platinum',
      renewalDate: '2027-02-05',
      inFeed: false,
      tierSource: 'entitlement_export',
      renewalSource: 'entitlement_export',
    });
  });

  it('ACC-021 stays Gold / 2026-12-20', () => {
    expect(effective('ACC-021')).toEqual(['gold', '2026-12-20']);
  });

  it('ACC-030 takes its renewal from the newer feed', () => {
    expect(accounts.get('ACC-030')).toMatchObject({
      renewalDate: '2027-01-31',
      renewalSource: 'entitlement_feed',
      inFeed: true,
    });
  });

  it('ACC-042 takes its tier from the newer feed', () => {
    expect(accounts.get('ACC-042')).toMatchObject({
      supportTier: 'platinum',
      tierSource: 'entitlement_feed',
      renewalDate: '2027-01-10',
    });
  });

  it('reports each disagreement once, with the value served', () => {
    const disagreements = events.filter((event) => event.kind === 'source_disagreement');
    expect(disagreements).toEqual([
      expect.objectContaining({
        accountId: 'ACC-030',
        field: 'renewalDate',
        exportValue: '2027-06-30',
        feedValue: '2027-01-31',
        served: 'entitlement_feed',
      }),
      expect.objectContaining({
        accountId: 'ACC-042',
        field: 'supportTier',
        exportValue: 'gold',
        feedValue: 'platinum',
        served: 'entitlement_feed',
      }),
    ]);
  });

  it('has no unmatched feed accounts and never puts names or ARR in events', () => {
    expect(xmlOnlyIds).toEqual([]);
    const serialised = JSON.stringify(events);
    for (const row of csv.rows) {
      expect(serialised).not.toContain(row.name);
      expect(serialised).not.toContain(row.arr.amount);
    }
  });
});

describe('buildSnapshot precedence and edge cases', () => {
  it('an XML feed older than the export loses: the export wins tier and renewal', () => {
    const { accounts } = buildSnapshot(
      fixtureInput({ xml: { rows: xml.rows, generatedAt: '2026-11-05T23:00:00Z' } }),
    );
    expect(accounts.get('ACC-030')).toMatchObject({
      renewalDate: '2027-06-30',
      renewalSource: 'entitlement_export',
      inFeed: true,
    });
    expect(accounts.get('ACC-042')).toMatchObject({
      supportTier: 'gold',
      tierSource: 'entitlement_export',
    });
  });

  it('a feed exactly as old as the export does not win (strictly newer)', () => {
    const { accounts } = buildSnapshot(
      fixtureInput({ xml: { rows: xml.rows, generatedAt: exportedAt } }),
    );
    expect(accounts.get('ACC-042')?.tierSource).toBe('entitlement_export');
  });

  it('without a feed, every field comes from the export', () => {
    const { accounts, events } = buildSnapshot(fixtureInput({ xml: null }));
    expect(accounts.get('ACC-042')).toMatchObject({ supportTier: 'gold', inFeed: false });
    expect(accounts.get('ACC-030')?.renewalDate).toBe('2027-06-30');
    expect(events.some((event) => event.kind === 'source_disagreement')).toBe(false);
  });

  it('feed-only accounts are left out and reported as unmatched', () => {
    const extra = parseEntitlementsXml(
      `<entitlements generatedAt="2026-11-06T11:00:00Z">
        <account id="ACC-099"><tier>Gold</tier><renewal>2027-01-01</renewal></account>
        <account id="ACC-050"><tier>Gold</tier><renewal>2027-01-01</renewal></account>
      </entitlements>`,
    );
    const { accounts, xmlOnlyIds, events } = buildSnapshot(
      fixtureInput({ xml: { rows: extra.rows, generatedAt: '2026-11-06T11:00:00Z' } }),
    );
    expect(accounts.has('ACC-099')).toBe(false);
    expect(xmlOnlyIds).toEqual(['ACC-050', 'ACC-099']);
    expect(events.filter((event) => event.kind === 'xml_only_account')).toHaveLength(2);
  });

  it('skips and reports export rows whose ID is unrecognisable; never matches on name', () => {
    const { rows } = parseAccountsCsv(
      'account_id,name,support_tier,contract_end,arr_usd\n' +
        'Acme Corp,Acme Corp,Gold,2027-01-01,1\n' +
        'acc-7,Acme Corp,Gold,2027-01-01,1\n',
    );
    const { accounts, events } = buildSnapshot({
      csv: { rows, exportedAt },
      xml: null,
      crosswalk,
    });
    expect([...accounts.keys()]).toEqual(['ACC-007']);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'unknown_id', sourceId: 'Acme Corp', line: 2 }),
    );
  });

  it('treats a crosswalked ID and its canonical form as the same account', () => {
    const { rows } = parseAccountsCsv(
      'account_id,name,support_tier,contract_end,arr_usd\n' +
        'ACC-007,Acme Corp,Gold,2026-01-01,1\n' +
        'ACC-77,Acme Corp,Platinum,2027-01-15,2\n',
    );
    const { accounts, events } = buildSnapshot({ csv: { rows, exportedAt }, xml: null, crosswalk });
    expect(accounts.get('ACC-007')).toMatchObject({
      supportTier: 'platinum',
      arr: { amount: '2.00', currency: 'USD' },
    });
    expect(events.filter((event) => event.kind === 'duplicate_account')).toHaveLength(1);
  });
});
