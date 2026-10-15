import type { SupabaseClient } from '@supabase/supabase-js';
import type { LinkedInSearchStatus } from './search';

/**
 * LinkedIn Job Finder — search-quota settlement.
 *
 * The search route reserves a Free-tier unit (reserve_linkedin_search(),
 * migration 027) BEFORE calling the vendor. That unit pays for a search the
 * user actually receives. If the vendor is not configured or the call
 * failed, nothing was delivered, so the unit must be given back.
 *
 * Found in a production smoke test: runLinkedInJobSearch() swallows both
 * cases and returns normally, and the route only refunded when the code
 * THREW — so every Free search against an unconfigured/failed vendor
 * silently spent one of the user's 3 daily searches.
 *
 * A successful search that legitimately returns zero results is status 'ok'
 * and keeps its charge: the vendor was reached and answered.
 *
 * KNOWN LIMITATION (accepted, documented in the PR): rollback_linkedin_
 * search_reservation() is a plain atomic counter decrement
 * (GREATEST(count - 1, 0)) — the same design as rollback_proposal_
 * reservation(). It is not tied to a specific reservation id. If a search
 * straddles the UTC day reset, a refund can take back a unit reserved by a
 * different search after the reset. Worst case is one extra free search in
 * a window of a few seconds per day. A true per-reservation refund needs
 * reservation ids and a migration, and is a separate decision.
 */

export function shouldRefundSearch(status: LinkedInSearchStatus): boolean {
  return status !== 'ok';
}

export interface RefundResult {
  refunded: boolean;
  /** Present only when the refund was attempted and failed. */
  error?: string;
}

export interface SettlementResult {
  quotaRefunded: boolean;
  /** Present only when a refund was needed and FAILED. */
  quotaRefundError?: string;
  /** `remaining` as the user should see it after settlement. null = unlimited (Pro). */
  remaining: number | null;
}

/**
 * The one decision the search route makes after the vendor call: refund the
 * reserved unit if the user did not receive a search, and report the
 * resulting `remaining`. Kept here (not inline in the route) so the exact
 * code path the route runs is unit-testable without a server.
 */
export async function settleSearchReservation(
  client: Pick<SupabaseClient, 'rpc'>,
  status: LinkedInSearchStatus,
  remainingAtReservation: number | null
): Promise<SettlementResult> {
  if (!shouldRefundSearch(status)) {
    return { quotaRefunded: false, remaining: remainingAtReservation };
  }
  const refund = await refundSearchReservation(client);
  return {
    quotaRefunded: refund.refunded,
    ...(refund.error ? { quotaRefundError: refund.error } : {}),
    // `remaining` was computed at reservation time; a successful refund
    // means the user has one more than that. Unlimited (null) stays null.
    remaining:
      refund.refunded && remainingAtReservation !== null ? remainingAtReservation + 1 : remainingAtReservation,
  };
}

/**
 * Gives back one reserved search unit. NEVER throws and NEVER hides a
 * failure: a failed refund is logged and returned as { refunded: false,
 * error } so the caller can put it in the response instead of letting the
 * quota accounting drift silently.
 */
export async function refundSearchReservation(client: Pick<SupabaseClient, 'rpc'>): Promise<RefundResult> {
  try {
    const { error } = await client.rpc('rollback_linkedin_search_reservation');
    if (error) {
      console.error('[linkedin-jobs] quota refund FAILED:', error.message);
      return { refunded: false, error: error.message };
    }
    return { refunded: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[linkedin-jobs] quota refund threw:', message);
    return { refunded: false, error: message };
  }
}
