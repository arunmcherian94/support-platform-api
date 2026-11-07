import type { DatabaseSync } from 'node:sqlite';

/**
 * Idempotency-key records for `POST /v1/cases/{caseId}/comments` (S4 §2.1,
 * ADR-0005). Every SQL statement for the table lives here.
 *
 * Claiming is one atomic insert; the row is read only when the insert didn't
 * happen. Never check-then-insert. `node:sqlite` is synchronous, but the logic
 * doesn't rely on that: each decision is a statement whose effect
 * (`changes = 1`) only one caller can win, so it holds on a shared database.
 */

/** Keys live 24 hours (ADR-0005). */
export const KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** An in-flight row this old was abandoned by a crashed request (well past the 10 s budget). */
export const IN_FLIGHT_ABANDON_MS = 60 * 1000;

export interface KeyScope {
  clientId: string;
  sub: string;
  /** Operation plus resource, e.g. `addCaseComment:CS-10231`. */
  endpoint: string;
  key: string;
}

/** Identifies one claim: the scope, the request it was made for, and when. */
export interface Claim extends KeyScope {
  requestHash: string;
  /** `created_at` written by the claim; completes and releases match on it. */
  claimedAt: string;
}

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  /** The exact JSON value that was sent. */
  body: unknown;
}

export type ClaimResult =
  | { kind: 'claimed'; claim: Claim }
  | ({ kind: 'replay' } & StoredResponse)
  | { kind: 'mismatch' }
  | { kind: 'in_flight' };

interface Row {
  request_hash: string;
  status: string;
  response_status: number | null;
  response_headers: string | null;
  response_body: string | null;
  created_at: string;
  expires_at: string;
}

type ClaimInput = KeyScope & { requestHash: string; now: Date };

export function claim(db: DatabaseSync, input: ClaimInput): ClaimResult {
  // A lost race (the row changed between our insert and read) is retried once;
  // losing twice means another request is actively using the key.
  return attempt(db, input) ?? attempt(db, input) ?? { kind: 'in_flight' };
}

/** One claim attempt; undefined when a concurrent change means it should be re-run. */
function attempt(db: DatabaseSync, input: ClaimInput): ClaimResult | undefined {
  const { clientId, sub, endpoint, key, requestHash, now } = input;
  const claimedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + KEY_TTL_MS).toISOString();
  const claimed: ClaimResult = {
    kind: 'claimed',
    claim: { clientId, sub, endpoint, key, requestHash, claimedAt },
  };

  const inserted = db
    .prepare(
      `INSERT INTO idempotency_keys
         (client_id, sub, endpoint, key, request_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'in_flight', ?, ?)
       ON CONFLICT (client_id, sub, endpoint, key) DO NOTHING`,
    )
    .run(clientId, sub, endpoint, key, requestHash, claimedAt, expiresAt);
  if (Number(inserted.changes) === 1) return claimed;

  const row = db
    .prepare(
      `SELECT request_hash, status, response_status, response_headers, response_body,
              created_at, expires_at
         FROM idempotency_keys
        WHERE client_id = ? AND sub = ? AND endpoint = ? AND key = ?`,
    )
    .get(clientId, sub, endpoint, key) as Row | undefined;
  if (row === undefined) return undefined; // released in between

  const nowMs = now.getTime();
  const expired = Date.parse(row.expires_at) <= nowMs;
  const abandoned =
    row.status === 'in_flight' && Date.parse(row.created_at) <= nowMs - IN_FLIGHT_ABANDON_MS;

  if (expired || abandoned) {
    // Take the row over. The WHERE repeats what we read, so of several callers
    // that saw the same stale row exactly one updates it; the rest re-run.
    const taken = db
      .prepare(
        `UPDATE idempotency_keys
            SET request_hash = ?, status = 'in_flight', response_status = NULL,
                response_headers = NULL, response_body = NULL, created_at = ?, expires_at = ?
          WHERE client_id = ? AND sub = ? AND endpoint = ? AND key = ?
            AND status = ? AND request_hash = ? AND created_at = ? AND expires_at = ?`,
      )
      .run(
        requestHash,
        claimedAt,
        expiresAt,
        clientId,
        sub,
        endpoint,
        key,
        row.status,
        row.request_hash,
        row.created_at,
        row.expires_at,
      );
    return Number(taken.changes) === 1 ? claimed : undefined;
  }

  // A different request under the same key, whatever the row's state.
  if (row.request_hash !== requestHash) return { kind: 'mismatch' };
  if (row.status === 'in_flight') return { kind: 'in_flight' };
  if (row.response_status === null || row.response_body === null) {
    throw new Error('completed idempotency record without a stored response');
  }
  return {
    kind: 'replay',
    status: row.response_status,
    headers: JSON.parse(row.response_headers ?? '{}') as Record<string, string>,
    body: JSON.parse(row.response_body) as unknown,
  };
}

/**
 * Stores the response of a successful create and marks the key completed.
 * Returns false when the claim is no longer held (taken over after 60 s).
 */
export function complete(db: DatabaseSync, held: Claim, response: StoredResponse): boolean {
  const result = db
    .prepare(
      `UPDATE idempotency_keys
          SET status = 'completed', response_status = ?, response_headers = ?, response_body = ?
        WHERE client_id = ? AND sub = ? AND endpoint = ? AND key = ?
          AND status = 'in_flight' AND request_hash = ? AND created_at = ?`,
    )
    .run(
      response.status,
      JSON.stringify(response.headers),
      JSON.stringify(response.body),
      held.clientId,
      held.sub,
      held.endpoint,
      held.key,
      held.requestHash,
      held.claimedAt,
    );
  return Number(result.changes) === 1;
}

/**
 * Releases a claim after a failed create, so a retry with the same key
 * proceeds. Deletes only this claim's in-flight row, never a completed one or
 * one another request has taken over.
 */
export function release(db: DatabaseSync, held: Claim): void {
  db.prepare(
    `DELETE FROM idempotency_keys
      WHERE client_id = ? AND sub = ? AND endpoint = ? AND key = ?
        AND status = 'in_flight' AND request_hash = ? AND created_at = ?`,
  ).run(held.clientId, held.sub, held.endpoint, held.key, held.requestHash, held.claimedAt);
}
