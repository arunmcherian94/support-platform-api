import type { RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { UpstreamError } from '../../adapters/errors.js';
import type { Identity } from '../../auth/types.js';
import { accountSummary } from '../../domain/account.js';
import { escalationVerdict, type TierLookup } from '../../domain/escalation.js';
import { enqueueEvent } from '../../events/enqueue.js';
import { currentContext } from '../../observability/context.js';
import type { CaseDetailRecord, CaseEscalation, EscalationReason } from '../../ports/cases.js';
import { recordAudit, type AuditRow } from '../../store/audit.js';
import { AppError } from '../problems.js';
import { identityOf, pathParam, upstreamProblem, type ReadDeps } from './shared.js';

export interface EscalateDeps extends ReadDeps {
  db: DatabaseSync;
  /** This API's base URL, for the webhook's `caseUrl`. */
  publicBaseUrl: string;
}

const ACTION = 'case.escalate';

/**
 * `POST /v1/cases/{caseId}/escalate` (S5 §2.1). Order: `If-Match` present,
 * ETag current, state, then priority and tier. The write goes through to the
 * case system once, with the version it was checked against; the audit row and
 * the `case.escalated` delivery are then committed together.
 */
export function escalateCaseHandler(deps: EscalateDeps): RequestHandler {
  return async (req, res, next) => {
    const started = deps.clock.now().getTime();
    let identity: Identity | undefined;
    let caseId = '';
    let reason: EscalationReason | undefined;
    const auditRow = (outcome: string): AuditRow | undefined =>
      identity === undefined
        ? undefined
        : {
            at: deps.clock.now(),
            correlationId: currentContext()?.correlationId ?? 'unknown',
            sub: identity.sub,
            ...(identity.agent === undefined ? {} : { agent: identity.agent }),
            clientId: identity.clientId,
            action: ACTION,
            resourceType: 'case',
            resourceId: caseId,
            // The note is free text: only whether one was given is recorded.
            ...(reason === undefined ? {} : { args: { reason, hasNote: hasNote(req.body) } }),
            outcome,
            latencyMs: deps.clock.now().getTime() - started,
          };
    /** Refusals are audited best-effort: a failed audit write never changes the answer. */
    const audit = (outcome: string): void => {
      const row = auditRow(outcome);
      if (row === undefined) return;
      try {
        recordAudit(deps.db, row);
      } catch (error) {
        deps.logger.error({ err: error, caseId }, 'audit record not written');
      }
    };
    const refuse = (error: AppError): void => {
      audit(error.problem);
      next(error);
    };

    try {
      caseId = pathParam(req, 'caseId');
      identity = identityOf(res);
      const body = req.body as { reason: EscalationReason; note?: string };
      reason = body.reason;

      // The contract marks If-Match required; the error handler turns its absence into 428.
      const ifMatch = req.get('If-Match')?.trim();
      if (ifMatch === undefined || ifMatch === '') {
        refuse(
          new AppError('precondition-required', "Send If-Match with the case's current ETag."),
        );
        return;
      }

      let record: CaseDetailRecord;
      try {
        record = await deps.upstreams.cases.get(caseId);
      } catch (error) {
        const problem =
          error instanceof UpstreamError && error.kind === 'not_found'
            ? new AppError('not-found', 'No case with this ID.')
            : upstreamProblem(error);
        if (problem instanceof AppError) audit(problem.problem);
        next(problem);
        return;
      }

      if (ifMatch !== record.etag) {
        refuse(stale());
        return;
      }

      const entitlement = deps.upstreams.entitlement;
      const verdict = escalationVerdict(record, (): TierLookup => {
        const state = entitlement.current();
        if (!state.usable) return 'stale';
        return state.snapshot.accounts.get(record.accountId)?.supportTier ?? null;
      });
      if (!verdict.allowed) {
        refuse(
          new AppError(verdict.problem, verdict.detail, {
            ...(verdict.problem === 'invalid-state' && record.escalation !== null
              ? { extensions: { escalation: record.escalation } }
              : {}),
          }),
        );
        return;
      }

      const escalation: CaseEscalation = {
        reason: body.reason,
        ...(body.note === undefined ? {} : { note: body.note }),
        // Second precision, like every other timestamp the API returns.
        escalatedAt: deps.clock
          .now()
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
        escalatedBy: {
          user: identity.sub,
          ...(identity.agent === undefined ? {} : { agent: identity.agent }),
        },
      };

      let written: { version: number; etag: string };
      try {
        written = await deps.upstreams.cases.escalate(caseId, escalation, record.version);
      } catch (error) {
        if (
          error instanceof UpstreamError &&
          error.kind === 'client_error' &&
          error.info.status === 412
        ) {
          // Changed between our read and the write.
          refuse(stale());
        } else if (error instanceof UpstreamError && error.kind === 'not_found') {
          refuse(new AppError('not-found', 'No case with this ID.'));
        } else {
          const problem = upstreamProblem(error);
          if (problem instanceof AppError) audit(problem.problem);
          next(problem);
        }
        return;
      }

      // The case system has accepted the write, so the answer is 200 from here on.
      // Audit and event commit together, or neither does.
      try {
        deps.db.exec('BEGIN IMMEDIATE');
        try {
          const row = auditRow('ok');
          if (row !== undefined) recordAudit(deps.db, row);
          enqueueEvent(deps.db, deps.clock, 'case.escalated', {
            caseId,
            accountId: record.accountId,
            priority: record.priority,
            escalation: {
              reason: escalation.reason,
              escalatedAt: escalation.escalatedAt,
              escalatedBy: escalation.escalatedBy,
            },
            caseEtag: written.etag,
            caseUrl: `${deps.publicBaseUrl}/v1/cases/${encodeURIComponent(caseId)}`,
          });
          deps.db.exec('COMMIT');
        } catch (error) {
          deps.db.exec('ROLLBACK');
          throw error;
        }
      } catch (error) {
        deps.logger.error({ err: error, caseId }, 'escalation audit and event not recorded');
      }

      const state = entitlement.current();
      res.set('ETag', written.etag).json({
        id: record.id,
        accountId: record.accountId,
        account: accountSummary(state, record.accountId),
        subject: record.subject,
        status: record.status,
        priority: record.priority,
        openedAt: record.openedAt,
        escalation,
      });
    } catch (error) {
      next(error);
    }
  };
}

function stale(): AppError {
  return new AppError(
    'precondition-failed',
    'The case changed since you read it. Fetch it again and retry with the new ETag.',
  );
}

function hasNote(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { note?: unknown }).note === 'string'
  );
}
