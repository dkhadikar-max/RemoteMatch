import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { readServerProfile, scorableProfile } from '@/lib/profile/server-profile';
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

interface ReserveResult {
  allowed: boolean;
  code?: 'RIGHT_LIMIT_REACHED' | 'TOTAL_LIMIT_REACHED' | 'DUPLICATE_INTERACTION';
  swipeId?: string;
  claimId?: string;
  hasDecision?: boolean;
  resumeInProgress?: boolean;
  rightCount?: number;
  totalCount?: number;
  resetAt?: string;
  planTier: 'free' | 'pro';
}

interface PassResult {
  allowed: boolean;
  code?: 'TOTAL_LIMIT_REACHED' | 'DUPLICATE_INTERACTION';
  swipeId?: string;
  rightCount?: number;
  totalCount?: number;
  resetAt?: string;
  planTier: 'free' | 'pro';
}

/**
 * Builds the decision snapshot + runs AI/matching for a right swipe. Shared
 * by the first-attempt success path and the resume path (a prior attempt's
 * claim expired before it finished) — both call this identically, the only
 * difference is which swipeId/claimId they attach the result to.
 */
async function scoreAndBuildSnapshot(
  supabase: Awaited<ReturnType<typeof getAuthenticatedUser>>['supabase'],
  user: Awaited<ReturnType<typeof getAuthenticatedUser>>['user'],
  opportunityId: string
) {
  const opp = await getActiveOpportunityByCanonicalId(supabase, opportunityId);
  if (!opp) return { decisionSnapshot: null, matchResultForClient: null };

  const read = await readServerProfile(supabase, user);
  const profileReadOk = read.readErrors.length === 0;
  const profile = scorableProfile(read);
  const profileUsable = profile !== null;
  const matchResult = profile ? generateRuleBasedMatchAnalysis(profile, opp) : null;
  const appKit = profile && matchResult ? await generateApplicationKit(profile, opp, matchResult, 'confident') : null;

  const decisionSnapshot: Record<string, unknown> = {
    profileSource: 'server',
    profileReadOk,
    profileUsable,
    fitScore: matchResult?.fitScore ?? null,
    fitBadge: matchResult?.fitBadge ?? null,
    isEligible: matchResult ? matchResult.isCountryEligible && matchResult.isRemoteEligible : null,
    decisionTimestamp: new Date().toISOString(),
    matchingEngineVersion: 'v1.0.0-beta',
    matchingWeightsVersion: 'weights-2026.09-v1',
    eligibilityRulesVersion: 'rules-2026.09-v1',
    profileVersion: read.profile.updatedAt || new Date().toISOString(),
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
    // P1 (Job-Quality Intelligence) candidate observable attributes, frozen
    // at decision time per the approved P1 scoping document — these do not
    // feed matching/scoring/eligibility, they are captured purely so a
    // later, separate analysis can check whether they correlate with
    // downstream outcomes. See src/lib/ingestion/pipeline.ts for how each
    // is computed.
    salaryDisclosed: opp.salaryQuality !== 'unspecified',
    postingAgeDaysAtDecision: Math.floor((Date.now() - new Date(opp.postedAt).getTime()) / (1000 * 60 * 60 * 24)),
    remoteScopeExplicit: opp.explicitRemoteScope ?? 'unknown',
    // C2 (Additional Supply Discovery) — the coarse, deterministic demand
    // pattern of THIS opportunity, frozen at decision time. Derived only
    // from `opp` (server-authoritative), never from client input. Pure
    // instrumentation: it feeds a later, separate demand-model measurement
    // job and nothing else — not matching, scoring, eligibility, or quota.
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

  return { decisionSnapshot, matchResultForClient: matchResult };
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
  const { supabase, user } = auth;

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

  if (action === 'passed') {
    const { data, error } = await supabase.rpc('record_pass', { p_opportunity_id: opportunityId });
    if (error) {
      return NextResponse.json({ error: 'Could not record swipe' }, { status: 500 });
    }
    const result = data as PassResult;

    if (!result.allowed) {
      if (result.code === 'DUPLICATE_INTERACTION') {
        return NextResponse.json({ error: 'duplicate_interaction', code: 'DUPLICATE_INTERACTION' }, { status: 409 });
      }
      return NextResponse.json(
        {
          error: 'limit_reached',
          code: result.code,
          resetAt: result.resetAt,
          rightCount: result.rightCount,
          totalCount: result.totalCount,
        },
        { status: 403 }
      );
    }

    return NextResponse.json({
      success: true,
      planTier: result.planTier,
      rightCount: result.rightCount,
      totalCount: result.totalCount,
    });
  }

  // action === 'interested': atomic reserve-or-claim BEFORE any further
  // work, so a request past the limit, or one that only duplicates an
  // existing decision, never reaches matching/AI generation.
  const { data: reservation, error: reserveError } = await supabase.rpc('reserve_and_record_right_swipe', {
    p_opportunity_id: opportunityId,
  });
  if (reserveError) {
    return NextResponse.json({ error: 'Could not process swipe' }, { status: 500 });
  }
  const reservationResult = reservation as ReserveResult;

  if (!reservationResult.allowed) {
    if (reservationResult.code === 'DUPLICATE_INTERACTION') {
      if (reservationResult.hasDecision) {
        // True duplicate — already fully completed. No replay of the
        // original decision data; the client already has it.
        return NextResponse.json({ error: 'duplicate_interaction', code: 'DUPLICATE_INTERACTION' }, { status: 409 });
      }

      if (reservationResult.resumeInProgress) {
        // Another in-flight request already holds the claim and is running
        // AI/matching for this swipe. Must NOT start a second AI call here —
        // that would be two paid calls racing to attach the same row.
        return NextResponse.json(
          { error: 'duplicate_interaction', code: 'DUPLICATE_INTERACTION', resumeInProgress: true },
          { status: 409 }
        );
      }

      // Resume branch: this request won the claim on a prior incomplete
      // swipe (e.g. a crashed/timed-out earlier attempt). Not an error
      // response — proceed exactly like the success path below, using the
      // existing swipeId/claimId instead of freshly-reserved ones.
      const swipeId = reservationResult.swipeId!;
      const claimId = reservationResult.claimId!;
      const { decisionSnapshot, matchResultForClient } = await scoreAndBuildSnapshot(supabase, user, opportunityId);

      const { data: attachData, error: attachError } = await supabase.rpc('attach_right_swipe_decision', {
        p_swipe_id: swipeId,
        p_decision_snapshot: decisionSnapshot,
        p_claim_id: claimId,
      });
      if (attachError) {
        return NextResponse.json({ error: 'Could not save your decision' }, { status: 500 });
      }
      const attachResult = attachData as { attached: boolean; reason?: string };
      if (!attachResult.attached) {
        // This request's AI result was discarded, not persisted — a
        // different, newer claim (or a completed decision) already exists
        // on that row. Do not report success for this specific request.
        return NextResponse.json({ error: 'duplicate_interaction', code: 'DUPLICATE_INTERACTION' }, { status: 409 });
      }

      return NextResponse.json({
        success: true,
        planTier: reservationResult.planTier,
        match: matchResultForClient,
        decisionSnapshot,
      });
    }

    // RIGHT_LIMIT_REACHED / TOTAL_LIMIT_REACHED
    return NextResponse.json(
      {
        error: 'limit_reached',
        code: reservationResult.code,
        resetAt: reservationResult.resetAt,
        rightCount: reservationResult.rightCount,
        totalCount: reservationResult.totalCount,
      },
      { status: 403 }
    );
  }

  // Fresh success: a new swipe row was just inserted and claimed.
  const swipeId = reservationResult.swipeId!;
  const claimId = reservationResult.claimId!;
  const { decisionSnapshot, matchResultForClient } = await scoreAndBuildSnapshot(supabase, user, opportunityId);

  // Note: if the AI-kit generation above throws, this attach call never
  // runs and the swipe row persists with decision_snapshot = NULL and an
  // eventually-expiring claim — the existing, already-approved divergence
  // ("swipe path intentionally does not roll back on AI failure") rather
  // than a new behavior introduced here.
  const { data: attachData, error: attachError } = await supabase.rpc('attach_right_swipe_decision', {
    p_swipe_id: swipeId,
    p_decision_snapshot: decisionSnapshot,
    p_claim_id: claimId,
  });
  if (attachError) {
    return NextResponse.json({ error: 'Could not save your decision' }, { status: 500 });
  }
  const attachResult = attachData as { attached: boolean; reason?: string };
  if (!attachResult.attached) {
    // Practically unreachable on this exact path (nothing else could hold a
    // newer claim on a row this request just inserted) — still checked,
    // never assumed, per the explicit `attached`-field contract.
    return NextResponse.json({ error: 'duplicate_interaction', code: 'DUPLICATE_INTERACTION' }, { status: 409 });
  }

  return NextResponse.json({
    success: true,
    planTier: reservationResult.planTier,
    rightCount: reservationResult.rightCount,
    totalCount: reservationResult.totalCount,
    // Returned so the client can populate its local, display-only tracker
    // fixture without re-running (and re-billing an AI call for) generation
    // that already happened here.
    match: matchResultForClient,
    decisionSnapshot,
  });
}
