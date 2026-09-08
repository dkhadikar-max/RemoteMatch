import { NextResponse } from 'next/server';
import { localStore } from '@/lib/db/mock-seed';
import { computeScreeningFit } from '@/lib/matching/engine';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveOpportunities } from '@/lib/ingestion/catalog-read';

/**
 * Opportunity catalog now comes from the persisted `opportunities` table
 * (Live Supply Activation) instead of the static CURATED_JOBS array — the
 * matching/scoring logic below (computeScreeningFit) is completely
 * unchanged, it just receives its input from a different source.
 *
 * This route was previously never actually called by the client (the /feed
 * page duplicated this same scoring logic client-side against localStore
 * directly) — its swipe-filtering used `localStore.getSwipes()` on the
 * server, which is always an empty in-memory array server-side (no
 * `window`, nothing ever loads into it), so it silently filtered nothing.
 * Harmless while unused; actively misleading now that the page is wired to
 * call this route for real. Removed rather than fixed: swipe-filtering
 * against the real per-user history already happens correctly server-side
 * at write time (finalize_interested_swipe()/record_pass(), P0), and
 * client-side against the local swipe cache for display purposes — neither
 * of those changes here. This route's only job is "all currently active
 * opportunities, scored"; the client still does its own unswiped-filter
 * exactly as before.
 *
 * RLS (`opportunities_select_active`) already restricts this to
 * status = 'active' rows regardless of whether the caller has a session —
 * this route remains unauthenticated (a preview list, not a mutation), so
 * the cookie-based client naturally falls back to the `anon` role when
 * there's no session, which the policy already accounts for.
 */
export async function GET() {
  try {
    const profile = localStore.getProfile();

    const supabase = createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Service temporarily unavailable.' }, { status: 503 });
    }
    const opportunities = await getActiveOpportunities(supabase);

    const scored = opportunities.map((opp) => {
      const fit = computeScreeningFit(profile, opp);
      return {
        ...opp,
        fitScore: fit.fitScore,
        fitBadge: fit.fitBadge,
      };
    });

    scored.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

    return NextResponse.json({
      success: true,
      opportunities: scored,
      dailyCount: profile.dailyEvaluationsCount,
      remaining: Math.max(20 - (profile.dailyEvaluationsCount || 0), 0),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
