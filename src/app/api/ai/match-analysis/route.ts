import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { loadServerProfile } from '@/lib/profile/server-profile';
import { generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateApplicationKit } from '@/lib/ai/materials';
import { MaterialTone } from '@/types/byn';
import { getActiveOpportunityByCanonicalId } from '@/lib/ingestion/catalog-read';

const VALID_TONES: MaterialTone[] = ['confident', 'conversational', 'formal'];

function isValidBody(body: unknown): body is { opportunityId: string; tone?: MaterialTone } {
  if (!body || typeof body !== 'object') return false;
  const { opportunityId, tone } = body as Record<string, unknown>;
  if (typeof opportunityId !== 'string' || opportunityId.trim().length === 0 || opportunityId.length > 200) {
    return false;
  }
  if (tone !== undefined && !VALID_TONES.includes(tone as MaterialTone)) {
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
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }
  const { opportunityId, tone = 'confident' } = body;

  const opp = await getActiveOpportunityByCanonicalId(supabase, opportunityId);
  if (!opp) {
    return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
  }

  // Atomic reservation BEFORE generation — this is the fix for the P0 quota
  // race: the previous implementation checked the quota, awaited AI
  // generation, and only then incremented (discarding the increment's own
  // failure), so N concurrent requests at the boundary all received full
  // generated content. Now nothing is generated unless the reservation
  // itself (a single row-locked, atomic Postgres update) already succeeded.
  const { data: reservation, error: reserveError } = await supabase.rpc('reserve_proposal');
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
        reason: 'proposals',
        limit: reservationResult.limit,
        upgradeRequired: true,
        message: "You've used all 5 proposal generations today. Upgrade for unlimited proposal materials.",
      },
      { status: 403 }
    );
  }

  try {
    // O1 — profile CONTENT now comes from the real, server-authoritative
    // profile (loadServerProfile, O9), never the client-local demo fixture.
    // That fixture is a module-level singleton with no relationship to any
    // specific request — calling it from a server route returned the same
    // static demo data for every user, every time. This route already
    // authenticates the caller (auth.user/auth.supabase above); loading
    // their real profile here is the fix.
    const profile = await loadServerProfile(auth.supabase, auth.user);
    const match = generateRuleBasedMatchAnalysis(profile, opp);
    const kit = await generateApplicationKit(profile, opp, match, tone as MaterialTone);

    return NextResponse.json({
      success: true,
      match,
      resumeTweaks: kit.resumeTweaks,
      coverLetter: kit.coverLetter,
      source: kit.source,
      planTier: reservationResult.planTier,
      limit: reservationResult.limit,
      remaining: reservationResult.remaining,
    });
  } catch (err) {
    // Deliberate rollback: generation failed after quota was reserved, so
    // give the unit back rather than silently charging the user for
    // content they never received (the remediation spec requires either a
    // rollback strategy or a documented reason to retain — this endpoint
    // rolls back).
    await supabase.rpc('rollback_proposal_reservation');
    return NextResponse.json({ error: 'Proposal generation failed' }, { status: 500 });
  }
}
