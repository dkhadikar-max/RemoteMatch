import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { loadServerProfile } from '@/lib/profile/server-profile';
import { runLinkedInJobSearch } from '@/lib/linkedin-jobs/search';
import { settleSearchReservation, refundSearchReservation } from '@/lib/linkedin-jobs/quota';
import type { LinkedInJobSearchFilters } from '@/types/linkedin-jobs';

/**
 * LinkedIn Job Finder — automated search (plan §22 step [1], §26 Mode A,
 * §27 Pro-with-small-Free-allowance). Pro-gated via the SAME atomic-
 * reservation pattern as reserve_proposal() (src/app/api/ai/match-analysis/
 * route.ts) — reserve_linkedin_search() (migration 027) enforces a small
 * Free daily allowance and unlimited Pro, exactly mirroring the
 * swipe/proposal quota philosophy rather than inventing a new one.
 *
 * The reserved unit is refunded whenever the user did not receive a search:
 * an unconfigured/failing vendor (status !== 'ok') or a thrown error. See
 * src/lib/linkedin-jobs/quota.ts for the rule and its documented limits.
 */

function isValidFilters(body: unknown): body is LinkedInJobSearchFilters {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const stringFields = ['keywords', 'location', 'experienceLevel', 'company', 'jobType'];
  for (const f of stringFields) {
    if (b[f] !== undefined && typeof b[f] !== 'string') return false;
  }
  if (b.remoteOnly !== undefined && typeof b.remoteOnly !== 'boolean') return false;
  if (b.datePosted !== undefined && !['any', 'past24h', 'pastWeek', 'pastMonth'].includes(b.datePosted as string)) {
    return false;
  }
  return true;
}

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabase } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isValidFilters(body)) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }
  const filters = body as LinkedInJobSearchFilters;

  // Atomic reservation BEFORE the vendor call — identical reasoning to
  // match-analysis/route.ts's reserve_proposal() call: nothing is fetched
  // unless the reservation itself already succeeded.
  const { data: reservation, error: reserveError } = await supabase.rpc('reserve_linkedin_search');
  if (reserveError) {
    return NextResponse.json({ error: 'Could not process request' }, { status: 500 });
  }

  const reservationResult = reservation as {
    allowed: boolean;
    limit: number;
    remaining: number | null;
    planTier: string;
  };

  if (!reservationResult.allowed) {
    return NextResponse.json(
      {
        error: 'limit_reached',
        reason: 'linkedin_search',
        limit: reservationResult.limit,
        upgradeRequired: true,
        message: "You've used your free LinkedIn searches for today. Upgrade for unlimited automated search.",
      },
      { status: 403 }
    );
  }

  try {
    const profile = await loadServerProfile(supabase, auth.user);
    const outcome = await runLinkedInJobSearch(profile, filters);

    // The reservation pays for a search the user actually receives.
    // runLinkedInJobSearch() does not throw for an unconfigured or failing
    // vendor — it reports it via `status` — so the refund must key off that,
    // not off an exception. A successful search with zero results is
    // status 'ok' and keeps its charge.
    const settlement = await settleSearchReservation(supabase, outcome.status, reservationResult.remaining);

    return NextResponse.json({
      success: true,
      status: outcome.status,
      vendorConfigured: outcome.vendorConfigured,
      results: outcome.results,
      planTier: reservationResult.planTier,
      limit: reservationResult.limit,
      remaining: settlement.remaining,
      quotaRefunded: settlement.quotaRefunded,
      // Present only when a refund was needed and FAILED — never silent.
      ...(settlement.quotaRefundError ? { quotaRefundError: settlement.quotaRefundError } : {}),
    });
  } catch (err) {
    // Same rollback discipline as match-analysis/route.ts: a failure after
    // the reservation succeeded gives the unit back rather than silently
    // charging the user's quota for a search they never received. The
    // refund's own failure is now surfaced instead of discarded.
    const refund = await refundSearchReservation(supabase);
    console.error('[linkedin-jobs/search] failed:', err);
    return NextResponse.json(
      {
        error: 'Search failed',
        quotaRefunded: refund.refunded,
        ...(refund.error ? { quotaRefundError: refund.error } : {}),
      },
      { status: 500 }
    );
  }
}
