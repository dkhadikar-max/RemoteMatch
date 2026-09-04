import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { localStore } from '@/lib/db/mock-seed';
import { generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateApplicationKit } from '@/lib/ai/materials';

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
  // result is persisted (Supabase, not the in-memory mock) have changed.
  // `localStore` here supplies only the curated job catalog (non-sensitive,
  // UI-only fixture data), never entitlement.
  const opp = localStore.getOpportunityById(opportunityId);
  let decisionSnapshot: Record<string, unknown> | null = null;
  let matchResultForClient: ReturnType<typeof generateRuleBasedMatchAnalysis> | null = null;

  if (opp) {
    // The demo profile content (skills/experience) still comes from the
    // local, non-authoritative profile fixture — profile CONTENT is out of
    // scope for this security pass (see migration file header); only
    // entitlement fields are Supabase-authoritative.
    const localProfile = localStore.getProfile();
    const matchResult = generateRuleBasedMatchAnalysis(localProfile, opp);
    const appKit = await generateApplicationKit(localProfile, opp, matchResult, 'confident');

    decisionSnapshot = {
      fitScore: matchResult.fitScore,
      fitBadge: matchResult.fitBadge,
      isEligible: matchResult.isCountryEligible && matchResult.isRemoteEligible,
      decisionTimestamp: new Date().toISOString(),
      matchingEngineVersion: 'v1.0.0-beta',
      matchingWeightsVersion: 'weights-2026.09-v1',
      eligibilityRulesVersion: 'rules-2026.09-v1',
      profileVersion: localProfile.updatedAt || new Date().toISOString(),
      jobVersion: opp.lastVerifiedAt || opp.postedAt,
      jobSource: opp.source,
      jobSourceId: opp.sourceId,
      officialUrl: opp.officialUrl,
      employmentType: opp.employmentType,
      remoteClassification: opp.remoteType,
      requirementsEvaluated: matchResult.requirementChecklist.map((r) => ({
        requirement: r.requirement,
        status: r.status,
      })),
      scoreBreakdown: {
        roleMatch: matchResult.isRoleMatch ? 95 : 60,
        recommendation: matchResult.recommendation,
        strengthsCount: matchResult.strengths.length,
        gapsCount: matchResult.gaps.length,
      },
      coverLetter: appKit.coverLetter,
      resumeTweaks: appKit.resumeTweaks,
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
