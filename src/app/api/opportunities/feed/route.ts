import { NextRequest, NextResponse } from 'next/server';
import type { PersonProfile } from '@/types/byn';
import { scoreOpportunitiesForFeed } from '@/lib/matching/engine';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveOpportunities } from '@/lib/ingestion/catalog-read';

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
 */

function isScorableProfile(p: unknown): p is PersonProfile {
  return Boolean(p) && typeof p === 'object' && Array.isArray((p as { skills?: unknown }).skills);
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
      return NextResponse.json({
        success: true,
        opportunities: scoreOpportunitiesForFeed(profile, opportunities),
        scored: true,
      });
    }

    return NextResponse.json({ success: true, opportunities, scored: false });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}
