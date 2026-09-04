import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/**
 * Server-authoritative entitlement fields only (planTier + quota counters).
 * Profile CONTENT (name/skills/experience/etc.) intentionally stays on the
 * existing client-local fixture for this pass — see
 * supabase/migrations/003_security_remediation.sql header for the scoping
 * rationale. `dailyEvaluationsCount` is deliberately never returned here —
 * it is internal-only, per the product spec, and was previously leaked by
 * the swipe/rewind routes.
 */
export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user, supabase } = auth;

  const { data, error } = await supabase
    .from('profiles')
    .select('plan_tier, daily_right_swipes_count, daily_proposals_count, usage_date')
    .eq('id', user.id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  return NextResponse.json({
    planTier: data.plan_tier as 'free' | 'pro',
    dailyRightSwipesCount: data.daily_right_swipes_count as number,
    dailyProposalsCount: data.daily_proposals_count as number,
    usageDate: data.usage_date as string,
    rightSwipeLimit: 15,
    proposalLimit: 5,
  });
}
