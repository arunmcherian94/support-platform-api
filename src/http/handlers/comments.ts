import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { UpstreamError } from '../../adapters/errors.js';
import type { CaseComment } from '../../ports/cases.js';
import { claim, complete, release } from '../../store/idempotency.js';
import { AppError } from '../problems.js';
import { identityOf, pathParam, upstreamProblem, type ReadDeps } from './shared.js';

/** What the comment handler needs: the read dependencies plus the store. */
export interface CommentDeps extends ReadDeps {
  db: DatabaseSync;
}

const OPERATION = 'addCaseComment';

/**
 * The key from the `Idempotency-Key` header: a Structured Field string
 * (`"…"`, with `\"` and `\\` escapes) or, leniently, the bare value.
 */
export function parseIdempotencyKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return value;
}

/** JSON with object keys sorted at every level, so formatting and key order don't matter. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 over the operation, the case and the canonical body (S4 §2.1). */
export function requestHash(caseId: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([OPERATION, caseId, canonicalJson(body)]))
    .digest('hex');
}

/**
 * `POST /v1/cases/{caseId}/comments` (S4 §2.1). The key is claimed atomically
 * before the case system is called; only a 201 is stored and replayed. Any
 * failure releases the key, so the client can retry with it.
 */
export function addCaseCommentHandler(deps: CommentDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const caseId = pathParam(req, 'caseId');
      const identity = identityOf(res);
      const key = parseIdempotencyKey(req.get('Idempotency-Key'));
      if (key === undefined || key === '') {
        next(
          new AppError(
            'idempotency-key-required',
            'Send a unique Idempotency-Key with every comment create.',
          ),
        );
        return;
      }
      const body = req.body as { body: string };
      const hash = requestHash(caseId, body);

      const result = claim(deps.db, {
        clientId: identity.clientId,
        sub: identity.sub,
        endpoint: `${OPERATION}:${caseId}`,
        key,
        requestHash: hash,
        now: deps.clock.now(),
      });

      switch (result.kind) {
        case 'replay':
          res
            .set(result.headers)
            .set('Idempotent-Replayed', 'true')
            .status(result.status)
            .json(result.body);
          return;
        case 'mismatch':
          next(
            new AppError(
              'idempotency-key-reused',
              'This Idempotency-Key was already used for a different request. Use a new key.',
            ),
          );
          return;
        case 'in_flight':
          next(
            new AppError(
              'request-in-progress',
              'A request with this Idempotency-Key is still running. Retry shortly.',
            ),
          );
          return;
        case 'claimed':
          break;
      }

      let created: CaseComment;
      try {
        created = await deps.upstreams.cases.addComment(caseId, {
          author: identity.sub,
          body: body.body,
        });
      } catch (error) {
        // Nothing is stored for a failure: the key is free for a retry.
        release(deps.db, result.claim);
        if (error instanceof UpstreamError && error.kind === 'not_found') {
          next(new AppError('not-found', 'No case with this ID.'));
        } else {
          next(upstreamProblem(error));
        }
        return;
      }

      const status = 201;
      const headers = {
        Location: `/v1/cases/${encodeURIComponent(caseId)}/comments/${encodeURIComponent(created.id)}`,
      };
      const responseBody = {
        id: created.id,
        author: created.author,
        body: created.body,
        createdAt: created.createdAt,
      };
      if (!complete(deps.db, result.claim, { status, headers, body: responseBody })) {
        // The claim was taken over after 60 s; the comment exists, so still answer 201.
        deps.logger.warn({ caseId }, 'idempotency claim lost before completion');
      }
      res.set(headers).status(status).json(responseBody);
    } catch (error) {
      next(error);
    }
  };
}
