import type { RequestHandler } from 'express';
import { UpstreamError } from '../../adapters/errors.js';
import { accountSummary } from '../../domain/account.js';
import { AppError } from '../problems.js';
import { pathParam, upstreamProblem, type ReadDeps } from './shared.js';

/** The contract caps `CaseDetail.comments` at 50 (newest last). */
export const MAX_COMMENTS = 50;

/**
 * `GET /v1/cases/{caseId}` (S3 §2.6). A live read from the case system, with
 * its ETag in the header and the account joined from the entitlement snapshot.
 * The body is the canonical case: the upstream version and ETag stay out of it.
 */
export function getCaseHandler(deps: ReadDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const caseId = pathParam(req, 'caseId');
      let record;
      try {
        record = await deps.upstreams.cases.get(caseId);
      } catch (error) {
        if (error instanceof UpstreamError && error.kind === 'not_found') {
          next(new AppError('not-found', 'No case with this ID.'));
        } else {
          next(upstreamProblem(error));
        }
        return;
      }

      const entitlement = deps.upstreams.entitlement;
      const state = entitlement.current();
      const account = accountSummary(state, record.accountId);
      // Only a usable snapshot can say the account is missing; otherwise null means "unknown".
      if (account === null && state.usable) entitlement.reportUnmatched(record.accountId);

      // The adapter returns every comment oldest first; keep the newest 50, still oldest first.
      const comments = record.comments.slice(-MAX_COMMENTS).map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
      }));

      res.set('ETag', record.etag).json({
        id: record.id,
        accountId: record.accountId,
        account,
        subject: record.subject,
        status: record.status,
        priority: record.priority,
        openedAt: record.openedAt,
        escalation: record.escalation,
        comments,
        commentCount: record.comments.length,
      });
    } catch (error) {
      next(error);
    }
  };
}
