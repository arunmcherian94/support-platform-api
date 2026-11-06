import { Router, type Response } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpstreamDeps, UpstreamModule } from '../server.js';

/**
 * Salesforce-like case system (S1-2). Records keep the upstream's mixed
 * casing on purpose; normalising is the adapter's job.
 */

interface CaseComment {
  id: string;
  author: string;
  body: string;
  at: string;
}

interface CaseRecord {
  id: string;
  accountId: string;
  priority: string;
  Status: string;
  openedAt: string;
  subject: string;
  version: number;
  IsEscalated: boolean;
  Comments: CaseComment[];
  [key: string]: unknown;
}

interface Filters {
  status?: string[];
  priority?: string[];
  accountId?: string;
  openedAfter?: string;
  openedBefore?: string;
}

interface Locator {
  offset: number;
  filters: Filters;
  pageSize: number;
}

const STATUSES = ['open', 'in_progress', 'closed'];
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const DEFAULT_PAGE_SIZE = 5;
const MAX_COMMENT_BODY = 4000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'cases.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as CaseRecord[];

const PATCH_FIELDS: Record<string, (v: unknown) => boolean> = {
  IsEscalated: (v) => typeof v === 'boolean',
  EscalationReason: (v) => typeof v === 'string',
  EscalationNote: (v) => typeof v === 'string' || v === null,
  EscalatedAt: (v) => typeof v === 'string',
  EscalatedBy: (v) => typeof v === 'string',
  EscalatedByAgent: (v) => typeof v === 'string' || v === null,
  EscalationApprovedBy: (v) => typeof v === 'string' || v === null,
};

function sfError(res: Response, status: number, errorCode: string, message: string): void {
  res.status(status).json([{ errorCode, message }]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function maxCommentNumber(cases: CaseRecord[]): number {
  let max = 0;
  for (const c of cases) {
    for (const comment of c.Comments) {
      const match = /^CM-(\d+)$/.exec(comment.id);
      if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}

function parseList(value: unknown, allowed: string[]): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split(',');
  return parts.every((p) => allowed.includes(p)) ? parts : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

/** Returns filters and pageSize, or an error message. */
function parseQuery(
  query: Record<string, unknown>,
): { filters: Filters; pageSize: number } | string {
  const filters: Filters = {};
  const allowedKeys = new Set([
    'status',
    'priority',
    'accountId',
    'openedAfter',
    'openedBefore',
    'pageSize',
  ]);
  for (const key of Object.keys(query)) {
    if (!allowedKeys.has(key)) return `unknown query parameter: ${key}`;
  }
  if (query.status !== undefined) {
    const status = parseList(query.status, STATUSES);
    if (!status) return `status must be a comma-separated subset of ${STATUSES.join(',')}`;
    filters.status = status;
  }
  if (query.priority !== undefined) {
    const priority = parseList(query.priority, PRIORITIES);
    if (!priority) return `priority must be a comma-separated subset of ${PRIORITIES.join(',')}`;
    filters.priority = priority;
  }
  if (query.accountId !== undefined) {
    if (typeof query.accountId !== 'string' || query.accountId === '') {
      return 'accountId must be a non-empty string';
    }
    filters.accountId = query.accountId;
  }
  if (query.openedAfter !== undefined) {
    if (!validTimestamp(query.openedAfter)) return 'openedAfter must be an RFC 3339 timestamp';
    filters.openedAfter = query.openedAfter;
  }
  if (query.openedBefore !== undefined) {
    if (!validTimestamp(query.openedBefore)) return 'openedBefore must be an RFC 3339 timestamp';
    filters.openedBefore = query.openedBefore;
  }
  let pageSize = DEFAULT_PAGE_SIZE;
  if (query.pageSize !== undefined) {
    const raw = query.pageSize;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 'pageSize must be an integer';
    pageSize = Number(raw);
    if (pageSize < 1 || pageSize > 200) return 'pageSize must be between 1 and 200';
  }
  return { filters, pageSize };
}

function matches(record: CaseRecord, f: Filters): boolean {
  if (f.status && !f.status.includes(record.Status)) return false;
  if (f.priority && !f.priority.includes(record.priority)) return false;
  if (f.accountId !== undefined && record.accountId !== f.accountId) return false;
  const opened = Date.parse(record.openedAt);
  if (f.openedAfter !== undefined && !(opened >= Date.parse(f.openedAfter))) return false;
  if (f.openedBefore !== undefined && !(opened < Date.parse(f.openedBefore))) return false;
  return true;
}

function encodeLocator(locator: Locator): string {
  return Buffer.from(JSON.stringify(locator), 'utf8').toString('base64url');
}

function decodeLocator(token: string): Locator | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!isPlainObject(parsed)) return undefined;
    const { offset, filters, pageSize } = parsed;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return undefined;
    if (typeof pageSize !== 'number' || !Number.isInteger(pageSize)) return undefined;
    if (pageSize < 1 || pageSize > 200) return undefined;
    if (!isPlainObject(filters)) return undefined;
    // Re-validate filters through the query parser so a forged token cannot smuggle odd values.
    const asQuery: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filters)) {
      asQuery[k] = Array.isArray(v) ? (v as unknown[]).join(',') : v;
    }
    const checked = parseQuery(asQuery);
    if (typeof checked === 'string') return undefined;
    return { offset, filters: checked.filters, pageSize };
  } catch {
    return undefined;
  }
}

function parseIfMatch(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  const match = /^"?(\d+)"?$/.exec(trimmed);
  return match?.[1];
}

export function casesRouter(deps: UpstreamDeps): UpstreamModule {
  let store: CaseRecord[] = structuredClone(FIXTURE);
  let commentCounter = maxCommentNumber(store);
  const router = Router();

  const page = (res: Response, locator: Locator): void => {
    const sorted = store
      .filter((c) => matches(c, locator.filters))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const records = sorted.slice(locator.offset, locator.offset + locator.pageSize);
    const nextOffset = locator.offset + locator.pageSize;
    const more = nextOffset < sorted.length;
    const body: Record<string, unknown> = {
      totalSize: sorted.length,
      done: !more,
      records,
    };
    if (more) {
      body.nextRecordsUrl = `/cases/query/${encodeLocator({ ...locator, offset: nextOffset })}`;
    }
    res.status(200).json(body);
  };

  router.get('/cases', (req, res) => {
    const parsed = parseQuery(req.query);
    if (typeof parsed === 'string') {
      sfError(res, 400, 'MALFORMED_QUERY', parsed);
      return;
    }
    page(res, { offset: 0, filters: parsed.filters, pageSize: parsed.pageSize });
  });

  router.get('/cases/query/:token', (req, res) => {
    const locator = decodeLocator(req.params.token);
    if (!locator) {
      sfError(res, 400, 'INVALID_QUERY_LOCATOR', 'The query locator is malformed.');
      return;
    }
    page(res, locator);
  });

  router.get('/cases/:id', (req, res) => {
    const record = store.find((c) => c.id === req.params.id);
    if (!record) {
      sfError(res, 404, 'NOT_FOUND', 'The requested resource does not exist');
      return;
    }
    res
      .set('ETag', `"${String(record.version)}"`)
      .status(200)
      .json(record);
  });

  router.post('/cases/:id/comments', (req, res) => {
    const record = store.find((c) => c.id === req.params.id);
    if (!record) {
      sfError(res, 404, 'NOT_FOUND', 'The requested resource does not exist');
      return;
    }
    const body: unknown = req.body;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some((k) => k !== 'body' && k !== 'author') ||
      typeof body.body !== 'string' ||
      body.body === '' ||
      body.body.length > MAX_COMMENT_BODY ||
      typeof body.author !== 'string' ||
      body.author === ''
    ) {
      sfError(
        res,
        400,
        'INVALID_FIELD',
        `body and author are required non-empty strings (body at most ${String(MAX_COMMENT_BODY)} characters) and no other fields are allowed`,
      );
      return;
    }
    commentCounter += 1;
    const at = formatTimestamp(deps.clock.now());
    const id = `CM-${String(commentCounter)}`;
    record.Comments.push({ id, author: body.author, body: body.body, at });
    record.version += 1;
    res
      .set('ETag', `"${String(record.version)}"`)
      .status(201)
      .json({ id, success: true, errors: [], at });
  });

  router.patch('/cases/:id', (req, res) => {
    const record = store.find((c) => c.id === req.params.id);
    if (!record) {
      sfError(res, 404, 'NOT_FOUND', 'The requested resource does not exist');
      return;
    }
    const header = req.header('If-Match');
    if (header === undefined) {
      sfError(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required');
      return;
    }
    if (parseIfMatch(header) !== String(record.version)) {
      sfError(res, 412, 'PRECONDITION_FAILED', 'The record was modified; refetch and retry');
      return;
    }
    const body: unknown = req.body;
    if (
      !isPlainObject(body) ||
      Object.keys(body).length === 0 ||
      !Object.entries(body).every(([k, v]) => PATCH_FIELDS[k]?.(v) === true)
    ) {
      sfError(
        res,
        400,
        'INVALID_FIELD',
        `body must be a non-empty object with only: ${Object.keys(PATCH_FIELDS).join(', ')}`,
      );
      return;
    }
    Object.assign(record, body);
    record.version += 1;
    res
      .set('ETag', `"${String(record.version)}"`)
      .status(204)
      .end();
  });

  return {
    router,
    reset: () => {
      store = structuredClone(FIXTURE);
      commentCounter = maxCommentNumber(store);
    },
  };
}
