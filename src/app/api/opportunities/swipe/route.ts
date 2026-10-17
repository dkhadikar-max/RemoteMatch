import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { loadServerProfile } from '@/lib/profile/server-profile';
import { isUsableProfile } from '@/lib/profile/usable';
import { generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateApplicationKit } from '@/lib/ai/materials';
import { getActiveOpportunityByCanonicalId } from '@/lib/ingestion/catalog-read';
import { normalizeDemandPattern, demandPatternKey, PATTERN_LEXICON_VERSION } from '@/lib/demand/pattern';

const VALID_ACTIONS = ['interested', 'passed'] as const;
type SwipeAction = (typeof VALID_ACTIONS)[number];

function isValidSwipeBody(body: unknown): body is { opportunityId: string; action: SwipeAction } {
  if (!body || typeof body !== 'object') return false;
  const { opportunityId, action } = body as Record<string, unknown>;
  return (
    typeof opportunityId === 'string' &&
    opportunityId.trim().length > 0 &&
    opportunityId.length <= 200 &&
    typeof action === 'string' &&
    (VALID_ACTIONS as readonly string[]).includes(action)
  );
}

export async function POST(req: NextRequest) {
  // Identity is derived from the verified session cookie only — the request
  // body's opportunityId/action are the only client-supplied inputs, and
  // neither can name another user or influence entitlement.
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

  if (!isValidSwipeBody(body)) {
    return NextResponse.json({ error: 'Invalid swipe parameters' }, { status: 400 });
  }
  const { opportunityId, action } = body;

  // Unlimited left swipes: no reservation, straight to the append-only log.
  if (action === 'passed') {
    const { data, error } = await supabase.rpc('record_pass', { p_opportunity_id: opportunityId });
    if (error) {
      return NextResponse.json({ error: 'Could not record swipe' }, { status: 500 });
    }
    return NextResponse.json({ success: Boolean((data as any)?.success) });
  }

  // action === 'interested': atomic reserve BEFORE any further work, so a
  // request past the 15/day limit never reaches matching/AI generation,
  // never creates a swipe/application row, and never returns success.
  const { data: reservation, error: reserveError } = await supabase.rpc('reserve_right_swipe');
  if (reserveError) {
    return NextResponse.json({ error: 'Could not process swipe' }, { status: 500 });
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
        reason: 'swipes',
        limit: reservationResult.limit,
        upgradeRequired: true,
        message: "You've used all 15 saves today. Upgrade for unlimited saves.",
      },
      { status: 403 }
    );
  }

  // Opportunity lookup / fit scoring / application-kit generation reuse the
  // frozen matching engine and existing AI materials pipeline unchanged —
  // only their inputs (a verified user + reserved quota) and where the
  // opportunity itself comes from (the persisted `opportunities` catalog,
  // Live Supply Activation) have changed. RLS-scoped via the user's own
  // session client, same as every other read in this route — an
  // opportunity that isn't currently 'active' simply isn't found, exactly
  // like a bad id would be.
  const opp = await getActiveOpportunityByCanonicalId(supabase, opportunityId);
  let decisionSnapshot: Record<string, unknown> | null = null;
  let matchResultForClient: ReturnType<typeof generateRuleBasedMatchAnalysis> | null = null;

  if (opp) {
    // Profile CONTENT is the caller's own, read server-side through their
    // RLS-scoped session (loadServerProfile, same as /api/ai/match-analysis) —
    // never the `localStore` demo fixture, which scored every user's swipe
    // and wrote every user's cover letter for the same seeded person.
    // A profile with no skill and no target role can't be scored
    // meaningfully: the swipe is still saved, but with no score and no kit,
    // rather than a number that measures nothing. A failed profile read
    // comes back empty, so it takes the same safe path.
    const profile = await loadServerProfile(supabase, auth.user);
    const profileUsable = isUsableProfile(profile);
    const matchResult = profileUsable ? generateRuleBasedMatchAnalysis(profile, opp) : null;
    const appKit = matchResult ? await generateApplicationKit(profile, opp, matchResult, 'confident') : null;

    decisionSnapshot = {
      profileSource: 'server',
      profileUsable,
      fitScore: matchResult?.fitScore ?? null,
      fitBadge: matchResult?.fitBadge ?? null,
      isEligible: matchResult ? matchResult.isCountryEligible && matchResult.isRemoteEligible : null,
      decisionTimestamp: new Date().toISOString(),
      matchingEngineVersion: 'v1.0.0-beta',
      matchingWeightsVersion: 'weights-2026.09-v1',
      eligibilityRulesVersion: 'rules-2026.09-v1',
      profileVersion: profile.updatedAt || new Date().toISOString(),
      jobVersion: opp.lastVerifiedAt || opp.postedAt,
      jobSource: opp.source,
      jobSourceId: opp.sourceId,
      officialUrl: opp.officialUrl,
      employmentType: opp.employmentType,
      remoteClassification: opp.remoteType,
      requirementsEvaluated: matchResult
        ? matchResult.requirementChecklist.map((r) => ({
            requirement: r.requirement,
            status: r.status,
          }))
        : [],
      scoreBreakdown: matchResult
        ? {
            roleMatch: matchResult.isRoleMatch ? 95 : 60,
            recommendation: matchResult.recommendation,
            strengthsCount: matchResult.strengths.length,
            gapsCount: matchResult.gaps.length,
          }
        : null,
      coverLetter: appKit?.coverLetter ?? null,
      resumeTweaks: appKit?.resumeTweaks ?? null,
      // P1 (Job-Quality Intelligence) candidate observable attributes,
      // frozen at decision time per the approved P1 scoping document —
      // these do not feed matching/scoring/eligibility, they are captured
      // purely so a later, separate analysis can check whether they
      // correlate with downstream outcomes. See
      // src/lib/ingestion/pipeline.ts for how each is computed.
      salaryDisclosed: opp.salaryQuality !== 'unspecified',
      postingAgeDaysAtDecision: Math.floor(
        (Date.now() - new Date(opp.postedAt).getTime()) / (1000 * 60 * 60 * 24)
      ),
      remoteScopeExplicit: opp.explicitRemoteScope ?? 'unknown',
      // C2 (Additional Supply Discovery) — the coarse, deterministic demand
      // pattern of THIS opportunity, frozen at decision time. Derived only
      // from `opp` (server-authoritative), never from client input. Pure
      // instrumentation: it feeds a later, separate demand-model measurement
      // job and nothing else — not matching, scoring, eligibility, or quota.
      // Same "measure, don't act" posture as the P1 attributes above.
      ...(() => {
        const demandPattern = normalizeDemandPattern({
          title: opp.title,
          requiredSkills: opp.requiredSkills,
          remoteType: opp.remoteType,
          eligibleCountries: opp.eligibleCountries,
          experienceRequirement: opp.experienceRequirement,
          salaryMin: opp.salaryMin,
          salaryCurrency: opp.salaryCurrency,
          description: opp.description,
        });
        return {
          demandPattern,
          demandPatternKey: demandPatternKey(demandPattern),
          patternLexiconVersion: PATTERN_LEXICON_VERSION,
        };
      })(),
    };
    matchResultForClient = matchResult;
  }

  // Note: if the AI-kit generation above throws, this finalize call never
  // runs and the reserved quota unit is intentionally NOT rolled back —
  // same as the pre-remediation behavior, where the quota increment already
  // happened before the (also unguarded) AI call. See final report for why
  // this is treated as an acceptable, explicitly-documented divergence from
  // the proposal endpoint's rollback requirement.
  const { error: finalizeError } = await supabase.rpc('finalize_interested_swipe', {
    p_opportunity_id: opportunityId,
    p_decision_snapshot: decisionSnapshot,
  });

  if (finalizeError) {
    return NextResponse.json({ error: 'Could not save your decision' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    planTier: reservationResult.planTier,
    limit: reservationResult.limit,
    remaining: reservationResult.remaining,
    // Returned so the client can populate its local, display-only tracker
    // fixture without re-running (and re-billing an AI call for) generation
    // that already happened here — see report re: tracker/applications
    // remaining out of the Supabase migration's scope for this pass.
    match: matchResultForClient,
    decisionSnapshot,
  });
}
