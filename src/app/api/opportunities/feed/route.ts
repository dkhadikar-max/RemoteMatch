import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { PersonProfile } from '@/types/byn';
import { scoreOpportunitiesForFeed, checkHardEligibility } from '@/lib/matching/engine';
import { classifyCareerTransition } from '@/lib/matching/career-transition';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveOpportunities } from '@/lib/ingestion/catalog-read';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { deriveEffectiveDecisions, applyBehavioralPersonalization, type SwipeRow, type EffectiveDecision } from '@/lib/feed/behavioral-personalization';

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
 *
 *        Behavioral Feed Personalization (N) is a further additive,
 *        ORDER-ONLY post-processing layer, applied after the transition
 *        layer above. It never changes `fitScore`/`fitBadge`, never
 *        changes eligibility, and never changes the opportunity SET except
 *        to exclude jobs the caller has already made an effective decision
 *        on (server `swipes` is the only authoritative source for that —
 *        see behavioral-personalization.ts). Below 5 effective decisions,
 *        or for any anon/unauthenticated/unscorable-profile caller, this
 *        layer is a no-op and ordering is byte-identical to before.
 */

function isScorableProfile(p: unknown): p is PersonProfile {
  return Boolean(p) && typeof p === 'object' && Array.isArray((p as { skills?: unknown }).skills);
}

type ResolvedAuth = { user: User; supabase: SupabaseClient } | null;

/** Resolves the caller's identity once per request, for every layer below
 *  that needs it. Fails closed to `null` (anonymous/unauthenticated) —
 *  never throws past this point. */
async function resolveAuth(req: NextRequest): Promise<ResolvedAuth> {
  try {
    return await getAuthenticatedUser(req);
  } catch {
    return null;
  }
}

/**
 * Establishes — SERVER-SIDE, from the verified session only — whether the
 * additive Career Transition block layer is allowed for this caller. Both
 * facts come from the database, never the request body. Fails closed: any
 * auth/lookup problem yields `false`.
 */
async function transitionLayerAllowed(auth: ResolvedAuth): Promise<boolean> {
  if (!auth) return false;
  try {
    const [{ data: prof }, { data: intent }] = await Promise.all([
      auth.supabase.from('profiles').select('plan_tier').eq('id', auth.user.id).single(),
      auth.supabase.from('profile_intents').select('career_direction').eq('profile_id', auth.user.id).maybeSingle(),
    ]);
    return (
      (prof?.plan_tier as string | undefined) === 'pro' &&
      (intent?.career_direction as string | null) === 'change_fields'
    );
  } catch {
    return false;
  }
}

/**
 * N2/N3/N6 — the caller's own effective decision history, straight from
 * the authoritative server `swipes` table (RLS already scopes SELECT to
 * the owner; the explicit `.eq` is defense-in-depth, matching this
 * codebase's existing style of never relying on RLS alone). Fails closed
 * to an empty map — a lookup problem never blocks the feed, it just means
 * no exclusion/personalization happens this request.
 */
async function loadEffectiveDecisions(auth: ResolvedAuth): Promise<Map<string, EffectiveDecision>> {
  if (!auth) return new Map();
  try {
    const { data, error } = await auth.supabase
      .from('swipes')
      .select('id, opportunity_id, action, created_at, rewound_decision_id')
      .eq('profile_id', auth.user.id);
    if (error || !data) return new Map();
    return deriveEffectiveDecisions(data as SwipeRow[]);
  } catch {
    return new Map();
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

      // Authenticate once for every layer below that needs identity —
      // never re-validates the token twice per request.
      const auth = await resolveAuth(req);

      // Additive, order-preserving transition-explanation layer — gated
      // server-side on a verified Pro + change_fields caller (see
      // transitionLayerAllowed). The request body's `careerDirection` is NOT
      // trusted for this decision.
      const allowed = await transitionLayerAllowed(auth);
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

      // Behavioral Feed Personalization (N) — a further additive, order-only
      // post-processing layer. Excludes jobs the caller has an effective
      // decision on (unconditional) and, only once 5+ effective decisions
      // exist, applies a capped positive-only reorder toward liked patterns.
      // fitScore/fitBadge are never mutated; the opportunity set is never
      // changed except by that exclusion. See behavioral-personalization.ts.
      const effectiveDecisions = await loadEffectiveDecisions(auth);
      const personalized = applyBehavioralPersonalization(withTransition, effectiveDecisions);

      return NextResponse.json({ success: true, opportunities: personalized, scored: true });
    }

    return NextResponse.json({ success: true, opportunities, scored: false });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
