import type { RequestHandler } from 'express';
import { UpstreamError } from '../../adapters/errors.js';
import type { SourceStatus } from '../../domain/account.js';
import { monthClosedAt, summariseUsage, type UsageSummary } from '../../domain/usage.js';
import type { AccountEntitlement, EntitlementSnapshot } from '../../ports/entitlement.js';
import { AppError } from '../problems.js';
import { entitlementStale, identityOf, pathParam, type ReadDeps } from './shared.js';

/** The scope that makes ARR visible (S3 §2.4). */
const FINANCE_SCOPE = 'finance:read';

interface UsageResult {
  usage: UsageSummary | null;
  source: SourceStatus;
  degraded: boolean;
}

/** Usage is optional: a warehouse failure degrades the response instead of failing it. */
async function readUsage(deps: ReadDeps, accountId: string): Promise<UsageResult> {
  const system = 'usage_warehouse';
  try {
    const months = await deps.upstreams.warehouse.monthlyUsage(accountId, 2);
    const usage = summariseUsage(months);
    if (usage === null) {
      return {
        usage,
        source: { system, status: 'no_data', asOf: null, fields: [] },
        degraded: false,
      };
    }
    return {
      usage,
      source: { system, status: 'ok', asOf: monthClosedAt(usage.latestMonth), fields: ['usage'] },
      degraded: false,
    };
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    // Upstream and failure class only: never the upstream body (S3-8).
    deps.logger.warn(
      { upstream: error.upstream, kind: error.kind },
      'optional upstream failed: serving the customer summary degraded',
    );
    return {
      usage: null,
      source: { system, status: 'unavailable', asOf: null, fields: [] },
      degraded: true,
    };
  }
}

/** Which entitlement system supplied which response field, per ADR-0003 precedence. */
function customerEntitlementSources(
  snapshot: EntitlementSnapshot,
  account: AccountEntitlement,
  showArr: boolean,
): SourceStatus[] {
  const exportFields = ['name'];
  if (account.tierSource === 'entitlement_export') exportFields.push('supportTier');
  if (account.renewalSource === 'entitlement_export') exportFields.push('renewalDate');
  if (showArr) exportFields.push('arr');
  const exportSource: SourceStatus = {
    system: 'entitlement_export',
    status: snapshot.export.status,
    asOf: snapshot.export.asOf,
    fields: exportFields,
  };

  const feed = snapshot.feed;
  let feedSource: SourceStatus;
  if (feed.asOf === null) {
    feedSource = { system: 'entitlement_feed', status: 'unavailable', asOf: null, fields: [] };
  } else if (!account.inFeed) {
    feedSource = { system: 'entitlement_feed', status: 'no_data', asOf: feed.asOf, fields: [] };
  } else {
    const feedFields: string[] = [];
    if (account.tierSource === 'entitlement_feed') feedFields.push('supportTier');
    if (account.renewalSource === 'entitlement_feed') feedFields.push('renewalDate');
    feedSource = {
      system: 'entitlement_feed',
      status: feed.status,
      asOf: feed.asOf,
      fields: feedFields,
    };
  }
  return [exportSource, feedSource];
}

/**
 * `GET /v1/customers/{customerId}` (S3 §2.4). Entitlement is required and read
 * from the in-memory snapshot; usage is optional. ARR is added to the body only
 * when the caller's token carries `finance:read`: the key is omitted, not
 * nulled, otherwise.
 */
export function getCustomerHandler(deps: ReadDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const customerId = pathParam(req, 'customerId');
      const state = deps.upstreams.entitlement.current();
      if (!state.usable) {
        next(entitlementStale());
        return;
      }
      const account = state.snapshot.accounts.get(customerId);
      if (account === undefined) {
        next(new AppError('not-found', 'No customer with this ID.'));
        return;
      }

      const showArr = identityOf(res).scopes.includes(FINANCE_SCOPE);
      const usage = await readUsage(deps, account.id);

      res.json({
        id: account.id,
        name: account.name,
        supportTier: account.supportTier,
        renewalDate: account.renewalDate,
        ...(showArr ? { arr: { amount: account.arr.amount, currency: account.arr.currency } } : {}),
        usage: usage.usage,
        degraded: usage.degraded,
        sources: [...customerEntitlementSources(state.snapshot, account, showArr), usage.source],
      });
    } catch (error) {
      next(error);
    }
  };
}
