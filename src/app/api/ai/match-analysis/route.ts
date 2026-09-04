import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { localStore } from '@/lib/db/mock-seed';
import { generateRuleBasedMatchAnalysis } from '@/lib/matching/engine';
import { generateApplicationKit } from '@/lib/ai/materials';
import { MaterialTone } from '@/types/byn';

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

  const opp = localStore.getOpportunityById(opportunityId);
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
    // Profile CONTENT (skills/experience) is out of scope for this pass and
    // still comes from the local fixture; only the quota gate above and the
    // plan tier are Supabase-authoritative.
    const localProfile = localStore.getProfile();
    const match = generateRuleBasedMatchAnalysis(localProfile, opp);
    const kit = await generateApplicationKit(localProfile, opp, match, tone as MaterialTone);

    return NextResponse.json({
      success: true,
      match,
      resumeTweaks: kit.resumeTweaks,
      coverLetter: kit.coverLetter,
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
