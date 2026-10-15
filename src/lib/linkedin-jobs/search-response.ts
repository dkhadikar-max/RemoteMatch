import type { LinkedInSearchOutcome } from './search';
import type { SettlementResult } from './quota';

/**
 * LinkedIn Job Finder — the JSON body of POST /api/linkedin-jobs/search's
 * normal (HTTP 200) path, built here rather than inline in the route so the
 * exact shape is unit-testable without a server.
 *
 * `success` means THE SEARCH WAS DELIVERED, not merely "the route finished
 * without throwing". It is true only for status 'ok' (including a real
 * search that legitimately found nothing). For 'vendor_not_configured' and
 * 'vendor_failed' the user received no search — the reserved unit is
 * refunded — so a client that checks `success` first must not treat that
 * empty result as a successful search. `status` carries the specifics.
 *
 * Because every non-'ok' status needs a refund, `success: true` also implies
 * no refund was attempted: a failed refund can never appear next to a
 * success flag. (Invariant asserted in test/linkedin-jobs-quota-refund-suite.ts.)
 *
 * HTTP status is deliberately left at 200 for these outcomes so the existing
 * page, which reads `vendorConfigured` and `results`, behaves unchanged.
 */
export function buildSearchResponseBody(
  outcome: LinkedInSearchOutcome,
  settlement: SettlementResult,
  reservation: { planTier: string; limit: number }
) {
  return {
    success: outcome.status === 'ok',
    status: outcome.status,
    vendorConfigured: outcome.vendorConfigured,
    results: outcome.results,
    planTier: reservation.planTier,
    limit: reservation.limit,
    remaining: settlement.remaining,
    quotaRefunded: settlement.quotaRefunded,
    // Present only when a refund was needed and FAILED — never silent.
    ...(settlement.quotaRefundError ? { quotaRefundError: settlement.quotaRefundError } : {}),
  };
}
