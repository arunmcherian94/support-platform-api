import type {
  CaseComment,
  CaseDetailRecord,
  CaseEscalation,
  CasePage,
  CaseQuery,
  CaseRecord,
  CaseStatus,
  CaseSystem,
  EscalationReason,
  Priority,
} from '../ports/cases.js';
import { UpstreamError } from './errors.js';
import type { UpstreamClient } from './types.js';

const STATUSES: readonly CaseStatus[] = ['open', 'in_progress', 'closed'];
const PRIORITIES: readonly Priority[] = ['P1', 'P2', 'P3', 'P4'];
const REASONS: readonly EscalationReason[] = [
  'sla_risk',
  'customer_impact',
  'renewal_risk',
  'security',
  'other',
];

function bad(cause?: unknown): UpstreamError {
  return new UpstreamError('case_system', 'bad_response', cause === undefined ? {} : { cause });
}

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(raw: Raw, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string') throw bad(`${key} is not a string`);
  return value;
}

/** A string, or undefined when the upstream sent null or nothing. */
function optStr(raw: Raw, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw bad(`${key} is not a string`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  const match = allowed.find((a) => a === value);
  if (match === undefined) throw bad(`unknown ${what}`);
  return match;
}

function parseEscalation(raw: Raw): CaseEscalation | null {
  const flag = raw.IsEscalated;
  if (typeof flag !== 'boolean') throw bad('IsEscalated is not a boolean');
  if (!flag) return null;
  const note = optStr(raw, 'EscalationNote');
  const agent = optStr(raw, 'EscalatedByAgent');
  const approvedBy = optStr(raw, 'EscalationApprovedBy');
  return {
    reason: oneOf<EscalationReason>(str(raw, 'EscalationReason'), REASONS, 'escalation reason'),
    ...(note === undefined ? {} : { note }),
    escalatedAt: str(raw, 'EscalatedAt'),
    escalatedBy: {
      user: str(raw, 'EscalatedBy'),
      ...(agent === undefined ? {} : { agent }),
      ...(approvedBy === undefined ? {} : { approvedBy }),
    },
  };
}

function etagFor(id: string, version: number): string {
  return `"${Buffer.from(`${id}:${String(version)}`, 'utf8').toString('base64url')}"`;
}

function parseRecord(raw: unknown): CaseRecord {
  if (!isRaw(raw)) throw bad('case is not an object');
  const id = str(raw, 'id');
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) throw bad('version');
  return {
    id,
    accountId: str(raw, 'accountId'),
    subject: str(raw, 'subject'),
    status: oneOf<CaseStatus>(str(raw, 'Status'), STATUSES, 'status'),
    priority: oneOf<Priority>(str(raw, 'priority'), PRIORITIES, 'priority'),
    openedAt: str(raw, 'openedAt'),
    escalation: parseEscalation(raw),
    version,
    etag: etagFor(id, version),
  };
}

function parseComment(raw: unknown): CaseComment {
  if (!isRaw(raw)) throw bad('comment is not an object');
  return {
    id: str(raw, 'id'),
    author: str(raw, 'author'),
    body: str(raw, 'body'),
    createdAt: str(raw, 'at'),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw bad(error);
  }
}

function parseDetail(raw: unknown): CaseDetailRecord {
  const record = parseRecord(raw);
  const comments = (raw as Raw).Comments;
  if (!Array.isArray(comments)) throw bad('Comments is not an array');
  const parsed = (comments as unknown[]).map(parseComment);
  // Oldest first; the sort is stable, so equal timestamps keep the upstream order.
  parsed.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { ...record, comments: parsed };
}

function searchPath(query: CaseQuery): string {
  const params: [string, string][] = [];
  if (query.status !== undefined) params.push(['status', query.status.join(',')]);
  if (query.priority !== undefined) params.push(['priority', query.priority.join(',')]);
  if (query.accountIds !== undefined) params.push(['accountId', query.accountIds.join(',')]);
  if (query.openedAfter !== undefined) params.push(['openedAfter', query.openedAfter]);
  if (query.openedBefore !== undefined) params.push(['openedBefore', query.openedBefore]);
  params.push(['sort', `${query.sort.descending ? '-' : ''}${query.sort.field}`]);
  if (query.after !== undefined) {
    params.push(['afterValue', query.after.value], ['afterId', query.after.id]);
  }
  params.push(['pageSize', String(query.limit + 1)]);
  // Each list item is encoded on its own; the comma is the upstream's list separator.
  const encoded = params.map(
    ([key, value]) => `${key}=${value.split(',').map(encodeURIComponent).join(',')}`,
  );
  return `/cases?${encoded.join('&')}`;
}

export function createCaseSystem(client: UpstreamClient): CaseSystem {
  return {
    async search(query: CaseQuery): Promise<CasePage> {
      // Only the first upstream page is used; keyset paging replaces nextRecordsUrl.
      const response = await client.request({ path: searchPath(query) });
      const body = parseJson(response.text);
      if (!isRaw(body) || !Array.isArray(body.records)) throw bad('records is not an array');
      const records = (body.records as unknown[]).map(parseRecord);
      return { records: records.slice(0, query.limit), hasMore: records.length > query.limit };
    },

    async get(caseId: string): Promise<CaseDetailRecord> {
      const response = await client.request({ path: `/cases/${encodeURIComponent(caseId)}` });
      return parseDetail(parseJson(response.text));
    },
  };
}
