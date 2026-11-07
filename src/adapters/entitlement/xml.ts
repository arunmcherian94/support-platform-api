import { XMLParser } from 'fast-xml-parser';
import type { SupportTier } from '../../ports/entitlement.js';
import { parseIsoDate, parseTier } from './csv.js';
import type { DataQualityEvent } from './snapshot.js';

/** A valid `<account>` of the entitlement feed, before ID normalisation. */
export interface XmlAccountRow {
  sourceId: string;
  supportTier: SupportTier;
  /** `YYYY-MM-DD`. */
  renewal: string;
  /** 1-based position among the `<account>` elements, for data-quality events. */
  position: number;
}

export interface ParsedFeed {
  /** The root's `generatedAt`, or null when absent or not a timestamp. */
  generatedAt: string | null;
  rows: XmlAccountRow[];
  events: DataQualityEvent[];
}

const ATTR = '@_';

/**
 * Options checked against fast-xml-parser 5.11.2's types:
 * - `processEntities: false`: no DOCTYPE or entity expansion (no billion-laughs,
 *   no external entities); `&x;` stays literal text and then fails validation.
 * - attributes kept, under a prefix so `id="…"` can't collide with an `<id>` child;
 * - values stay strings (`2027-01-15` and IDs must not become numbers);
 * - `account` is always an array, so one account and many parse the same way.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (tagName) => tagName === 'account',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parses the entitlement feed. A document without an `<entitlements>` root is
 * rejected as a whole (it is not the feed); a bad `<account>` is skipped and
 * reported, never fatal.
 */
export function parseEntitlementsXml(xml: string): ParsedFeed {
  const document: unknown = parser.parse(xml);
  const root = isRecord(document) ? document.entitlements : undefined;
  // An empty <entitlements/> parses to '' rather than an object.
  if (root === undefined || (!isRecord(root) && root !== '')) {
    throw new Error('feed has no <entitlements> root element');
  }
  const element = isRecord(root) ? root : {};

  const rawGeneratedAt = text(element[`${ATTR}generatedAt`]);
  const generatedAt =
    rawGeneratedAt !== null && !Number.isNaN(Date.parse(rawGeneratedAt)) ? rawGeneratedAt : null;

  const accounts = Array.isArray(element.account) ? (element.account as unknown[]) : [];
  const rows: XmlAccountRow[] = [];
  const events: DataQualityEvent[] = [];
  for (const [index, account] of accounts.entries()) {
    const position = index + 1;
    const malformed = (reason: string, accountId?: string): void => {
      events.push({
        kind: 'malformed_row',
        source: 'entitlement_feed',
        position,
        reason,
        ...(accountId === undefined ? {} : { accountId }),
      });
    };
    if (!isRecord(account)) {
      malformed('account has no id, tier or renewal');
      continue;
    }
    const sourceId = text(account[`${ATTR}id`])?.trim() ?? '';
    const rawTier = text(account.tier);
    const rawRenewal = text(account.renewal);
    const supportTier = rawTier === null ? null : parseTier(rawTier);
    const renewal = rawRenewal === null ? null : parseIsoDate(rawRenewal);
    if (sourceId === '') malformed('account has no id attribute');
    else if (supportTier === null) malformed('unknown or missing tier', sourceId);
    else if (renewal === null) malformed('renewal is not YYYY-MM-DD', sourceId);
    else rows.push({ sourceId, supportTier, renewal, position });
  }
  return { generatedAt, rows, events };
}
