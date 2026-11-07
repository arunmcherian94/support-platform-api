import type { SupportTier } from '../../ports/entitlement.js';
import type { DataQualityEvent } from './snapshot.js';

/** One record of a CSV file and the line it starts on (1-based), for data-quality events. */
export interface CsvRecord {
  line: number;
  fields: string[];
}

/**
 * Minimal RFC 4180 parser: quoted fields, `""` escapes, commas and line breaks
 * inside quotes, CRLF or LF, optional trailing newline. Blank lines are skipped.
 * An unterminated quote throws: it swallows the rest of the file, so no row
 * after it can be trusted and the whole export is rejected.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = (): void => {
    fields.push(field);
    // A blank line is one empty field; it carries no data.
    if (!(fields.length === 1 && fields[0] === '')) records.push({ line: recordLine, fields });
    fields = [];
    field = '';
  };

  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line++;
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += char;
    }
  }
  if (inQuotes) throw new Error(`unterminated quoted field starting on line ${recordLine}`);
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

/** Fields only, for callers that don't report line numbers. */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map((record) => record.fields);
}

/** A valid row of the ERP accounts export, before ID normalisation. */
export interface CsvAccountRow {
  /** The ID as exported (e.g. `ACC-77`); normalised in the snapshot. */
  sourceId: string;
  name: string;
  supportTier: SupportTier;
  /** `YYYY-MM-DD`. */
  contractEnd: string;
  arr: { amount: string; currency: 'USD' };
  line: number;
}

/** Drops a UTF-8 byte order mark, which spreadsheet exports often add. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export const CSV_COLUMNS = ['account_id', 'name', 'support_tier', 'contract_end', 'arr_usd'];

const TIERS: readonly SupportTier[] = ['platinum', 'gold', 'silver'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Non-negative decimal with at most two fraction digits: no rounding, no exponents. */
const MONEY = /^(\d+)(?:\.(\d{1,2}))?$/;

export function parseTier(value: string): SupportTier | null {
  const tier = value.trim().toLowerCase();
  return (TIERS as readonly string[]).includes(tier) ? (tier as SupportTier) : null;
}

/** `YYYY-MM-DD` that is a real calendar date (rejects 2027-02-30). */
export function parseIsoDate(value: string): string | null {
  const trimmed = value.trim();
  const match = DATE.exec(trimmed);
  if (match === null) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const valid =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return valid ? trimmed : null;
}

/**
 * ARR as a decimal string with two fraction digits, built from the text so no
 * float ever touches it: `480000` → `480000.00`, `1234.5` → `1234.50`.
 */
export function parseArr(value: string): string | null {
  const match = MONEY.exec(value.trim());
  if (match === null) return null;
  const whole = (match[1] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * Parses the accounts export. The header must name exactly the expected
 * columns (a renamed or reordered column would silently shift fields, so the
 * export is rejected). Malformed rows are skipped and reported, never fatal.
 * Events carry the source ID and the reason, never the name or ARR.
 */
export function parseAccountsCsv(text: string): {
  rows: CsvAccountRow[];
  events: DataQualityEvent[];
} {
  const [header, ...records] = parseCsvRecords(stripBom(text));
  const names = header?.fields.map((name) => name.trim().toLowerCase());
  if (names?.join(',') !== CSV_COLUMNS.join(',')) {
    throw new Error(`accounts export header must be ${CSV_COLUMNS.join(',')}`);
  }

  const rows: CsvAccountRow[] = [];
  const events: DataQualityEvent[] = [];
  const malformed = (line: number, reason: string, accountId?: string): void => {
    events.push({
      kind: 'malformed_row',
      source: 'entitlement_export',
      line,
      reason,
      ...(accountId === undefined || accountId === '' ? {} : { accountId }),
    });
  };

  for (const { line, fields } of records) {
    if (fields.length !== CSV_COLUMNS.length) {
      malformed(line, `expected ${CSV_COLUMNS.length} columns, got ${fields.length}`);
      continue;
    }
    const [rawId, rawName, rawTier, rawEnd, rawArr] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    const sourceId = rawId.trim();
    const name = rawName.trim();
    const supportTier = parseTier(rawTier);
    const contractEnd = parseIsoDate(rawEnd);
    const amount = parseArr(rawArr);
    if (sourceId === '') malformed(line, 'empty account_id');
    else if (name === '') malformed(line, 'empty name', sourceId);
    else if (supportTier === null) malformed(line, 'unknown support_tier', sourceId);
    else if (contractEnd === null) malformed(line, 'contract_end is not YYYY-MM-DD', sourceId);
    else if (amount === null) malformed(line, 'arr_usd is not a decimal amount', sourceId);
    else {
      rows.push({
        sourceId,
        name,
        supportTier,
        contractEnd,
        arr: { amount, currency: 'USD' },
        line,
      });
    }
  }
  return { rows, events };
}
