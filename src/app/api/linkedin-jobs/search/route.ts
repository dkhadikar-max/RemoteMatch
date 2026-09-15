import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { loadServerProfile } from '@/lib/profile/server-profile';
import { runLinkedInJobSearch } from '@/lib/linkedin-jobs/search';
import type { LinkedInJobSearchFilters } from '@/types/linkedin-jobs';

/**
 * LinkedIn Job Finder — automated search (plan §22 step [1], §26 Mode A,
 * §27 Pro-with-small-Free-allowance). Pro-gated via the SAME atomic-
 * reservation pattern as reserve_proposal() (src/app/api/ai/match-analysis/
 * route.ts) — reserve_linkedin_search() (migration 027, NOT YET APPLIED —
 * see that file's header) enforces a small Free daily allowance and
 * unlimited Pro, exactly mirroring the swipe/proposal quota philosophy
 * rather than inventing a new one.
 *
 * Until migration 027 is applied, this RPC does not exist in the database
 * and every call here returns 500 — this is expected and documented, not a
 * bug: this route is NOT deployed as part of this implementation pass
 * (commit/push/deploy remain separate, un-triggered gates), so the RPC's
 * absence in production is never actually reached by a real request.
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

    return NextResponse.json({
      success: true,
      vendorConfigured: outcome.vendorConfigured,
      results: outcome.results,
      planTier: reservationResult.planTier,
      limit: reservationResult.limit,
      remaining: reservationResult.remaining,
    });
  } catch (err) {
    // Same rollback discipline as match-analysis/route.ts: a failure after
    // the reservation succeeded gives the unit back rather than silently
    // charging the user's quota for a search they never received.
    await supabase.rpc('rollback_linkedin_search_reservation');
    console.error('[linkedin-jobs/search] failed:', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
