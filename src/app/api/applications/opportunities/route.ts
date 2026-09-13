import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getOpportunitiesByCanonicalIdsAnyStatus } from '@/lib/ingestion/catalog-read';

/**
 * Tracker Opportunity Resolution.
 * ==============================================================================
 * Fixes a real defect: Tracker's card rendering used to fall through to
 * `localStore.getOpportunityById()` on every single row (GET /api/applications
 * never populated `.opportunity`, so that "fallback" was actually the only
 * path) — a lookup against the static, 12-entry `CURATED_JOBS` fixture, not
 * the live catalog. With Live Supply Activation, 91% of the real catalog is
 * not curated, so any application against a Remotive/Arbeitnow/Jobicy job
 * silently vanished from the Tracker UI entirely (`if (!opp) return null`).
 *
 * Authorization boundary — this is the entire point of this route, read
 * carefully before changing it:
 *   1. Authenticate the caller.
 *   2. Using the caller's OWN RLS-scoped client, read `applications.opportunity_id`
 *      for THIS user only (`.eq('profile_id', user.id)`) — same query shape
 *      GET /api/applications already uses. This is the ONLY source of which
 *      ids get resolved below.
 *   3. Only THOSE ids (never anything from the request body/query string —
 *      this route takes no input at all) are passed to
 *      `getOpportunitiesByCanonicalIdsAnyStatus()`, which uses the admin
 *      client to bypass the `opportunities_select_active` RLS restriction
 *      (a user's Tracker must be able to show a since-expired job they
 *      really applied to). The admin client is never given an id this
 *      route didn't already prove the caller owns.
 * A request cannot, by construction, resolve an opportunity the caller has
 * no application against — there is no parameter through which one could be
 * supplied.
 *
 * A superseded opportunity resolves to ITS OWN row (title/company as of the
 * row the user actually acted on) — `getOpportunitiesByCanonicalIdsAnyStatus`
 * has no knowledge of `superseded_by_opportunity_id` and never follows it.
 *
 * Response is a deliberately minimal projection (only what Tracker's cards
 * actually render) — not the full CanonicalOpportunity shape. A missing key
 * means the id could not be resolved (deleted row, or never existed) — the
 * client keeps its existing safe skip behavior for that case; this route
 * never fabricates a placeholder for it.
 */

export interface TrackerOpportunitySummary {
  id: string;
  title: string;
  company: string;
  remoteType: string;
  salaryMin?: number;
  salaryMax?: number;
}

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user, supabase } = auth;

  const { data: applications, error } = await supabase
    .from('applications')
    .select('opportunity_id')
    .eq('profile_id', user.id);

  if (error) {
    return NextResponse.json({ error: 'Could not load applications' }, { status: 500 });
  }

  const ownedIds = Array.from(
    new Set(
      (applications ?? [])
        .map((a) => a.opportunity_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  );

  if (ownedIds.length === 0) {
    return NextResponse.json({ opportunities: {} });
  }

  const opportunities = await getOpportunitiesByCanonicalIdsAnyStatus(ownedIds);

  const byId: Record<string, TrackerOpportunitySummary> = {};
  for (const opp of opportunities) {
    byId[opp.id] = {
      id: opp.id,
      title: opp.title,
      company: opp.company,
      remoteType: opp.remoteType,
      salaryMin: opp.salaryMin,
      salaryMax: opp.salaryMax,
    };
  }

  return NextResponse.json({ opportunities: byId });
}
