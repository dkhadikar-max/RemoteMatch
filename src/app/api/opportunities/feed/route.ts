import { NextRequest, NextResponse } from 'next/server';
import type { PersonProfile } from '@/types/byn';
import { scoreOpportunitiesForFeed, checkHardEligibility } from '@/lib/matching/engine';
import { classifyCareerTransition } from '@/lib/matching/career-transition';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveOpportunities } from '@/lib/ingestion/catalog-read';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';

/**
 * The opportunity catalog comes from the persisted `opportunities` table
 * (Live Supply Activation) — RLS (`opportunities_select_active`) restricts
 * both verbs below to `status = 'active'` rows regardless of caller identity,
 * so a cookie-less request reads correctly as the `anon` role.
 *
 * GET  — the public, session-independent active catalog, UNSCORED. This is
 *        the "preview list" contract (used by production-smoke.ts).
 *
 * POST — the same catalog, scored against the profile in the request body.
 *        There is no server-authoritative store of profile CONTENT
 *        (skills/experience) — `/api/profile` is entitlement + identity only
 *        — so the client sends the profile it already loaded (feed/page.tsx
 *        `loadProfile()`), and this route scores against THAT, per caller.
 *        Same trust level as the pre-Live-Supply client-side scoring: the fit
 *        score is advisory display only and never gates a swipe, quota, or
 *        the persisted decision snapshot (that runs in
 *        /api/opportunities/swipe and is unaffected). Without a usable
 *        profile the catalog is returned UNSCORED rather than scored against
 *        a shared demo fixture — this route has no dependency on the
 *        client-local profile store at all.
 *
 *        Career Transition Matching V1.1 is ADDITIVE, EXPLANATION-ONLY, and
 *        Pro-gated at the SERVER boundary. The `careerTransition` block layer
 *        runs only when BOTH facts are established server-side (never from the
 *        request body): the authenticated caller's `plan_tier === 'pro'` AND
 *        their `profile_intents.career_direction === 'change_fields'`. For any
 *        other caller (anon, Free, `continue`, unverified) the block layer is
 *        skipped entirely — a Free client cannot obtain the transition payload
 *        by asserting `careerDirection` in the body. The scored list's ORDER,
 *        fitScore, and eligibility are never changed for ANY caller —
 *        `scoreOpportunitiesForFeed` runs exactly as before; the gate only
 *        decides whether the additive block layer runs.
 */

function isScorableProfile(p: unknown): p is PersonProfile {
  return Boolean(p) && typeof p === 'object' && Array.isArray((p as { skills?: unknown }).skills);
}

/**
 * Establishes — SERVER-SIDE, from the verified session only — whether the
 * additive Career Transition block layer is allowed for this caller. Both
 * facts come from the database, never the request body. Fails closed: any
 * auth/lookup problem yields `false`.
 */
async function transitionLayerAllowed(req: NextRequest): Promise<boolean> {
  try {
    const { user, supabase } = await getAuthenticatedUser(req);
    const [{ data: prof }, { data: intent }] = await Promise.all([
      supabase.from('profiles').select('plan_tier').eq('id', user.id).single(),
      supabase.from('profile_intents').select('career_direction').eq('profile_id', user.id).maybeSingle(),
    ]);
    return (
      (prof?.plan_tier as string | undefined) === 'pro' &&
      (intent?.career_direction as string | null) === 'change_fields'
    );
  } catch {
    return false;
  }
}

async function loadActiveCatalog() {
  const supabase = createSupabaseServerClient();
  if (!supabase) return null;
  return getActiveOpportunities(supabase);
}

export async function GET() {
  try {
    const opportunities = await loadActiveCatalog();
    if (!opportunities) {
      return NextResponse.json({ success: false, error: 'Service temporarily unavailable.' }, { status: 503 });
    }
    return NextResponse.json({ success: true, opportunities, scored: false });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let profile: unknown = null;
    try {
      const body = await req.json();
      profile = body && typeof body === 'object' ? (body as { profile?: unknown }).profile : null;
    } catch {
      // No / malformed body — fall through to the unscored catalog.
    }

    const opportunities = await loadActiveCatalog();
    if (!opportunities) {
      return NextResponse.json({ success: false, error: 'Service temporarily unavailable.' }, { status: 503 });
    }

    if (isScorableProfile(profile)) {
      // v1 scoring + ranking — completely unchanged.
      const scored = scoreOpportunitiesForFeed(profile, opportunities);

      // Additive, order-preserving transition-explanation layer — gated
      // server-side on a verified Pro + change_fields caller (see
      // transitionLayerAllowed). The request body's `careerDirection` is NOT
      // trusted for this decision.
      const allowed = await transitionLayerAllowed(req);
      const withTransition = allowed
        ? scored.map((opp) => {
            // classifyCareerTransition still self-checks careerDirection; feed
            // it the server-established fact so a body without it still works.
            const gatedProfile: PersonProfile = { ...profile, careerDirection: 'change_fields' };
            const isEligible = checkHardEligibility(gatedProfile, opp).isEligible;
            const careerTransition = classifyCareerTransition(gatedProfile, opp, isEligible);
            return careerTransition ? { ...opp, careerTransition } : opp;
          })
        : scored;

      return NextResponse.json({ success: true, opportunities: withTransition, scored: true });
    }

    return NextResponse.json({ success: true, opportunities, scored: false });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
