import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/**
 * Server-authoritative profile-domain state: entitlement (planTier + quota),
 * identity/linking, and — since Career Transition Matching — the caller's
 * `career_direction`. Profile CONTENT (name/skills/experience) is served by
 * GET /api/onboarding, not here. `dailyEvaluationsCount` is deliberately never
 * returned — internal-only per the product spec.
 */
export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user, supabase } = auth;

  const [{ data, error }, { data: intent }, { data: swipeCounts }] = await Promise.all([
    supabase
      .from('profiles')
      .select('plan_tier, daily_right_swipes_count, daily_proposals_count, usage_date, linkedin_url, github_url')
      .eq('id', user.id)
      .single(),
    // career_direction lives on profile_intents (migration 015); an un-onboarded
    // user has no row yet -> treat as the 'continue' default.
    supabase.from('profile_intents').select('career_direction').eq('profile_id', user.id).maybeSingle(),
    // Rolling-24h right/total swipe counts — the SAME shared function the
    // swipe route's gating RPCs call (migration 046), so this display value
    // can never drift from what actually gates a swipe. Replaces the old
    // calendar-day `daily_right_swipes_count` counter for display purposes;
    // that column is retained only as a rollback safety net (see migration
    // 046), no longer read here.
    supabase.rpc('get_rolling_swipe_counts'),
  ]);

  if (error || !data) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  const careerDirection =
    (intent?.career_direction as string | null) === 'change_fields' ? 'change_fields' : 'continue';

  const rollingRightCount = (swipeCounts as { rightCount: number; totalCount: number } | null)?.rightCount
    ?? (data.daily_right_swipes_count as number);
  const rollingTotalCount = (swipeCounts as { rightCount: number; totalCount: number } | null)?.totalCount ?? 0;

  return NextResponse.json({
    planTier: data.plan_tier as 'free' | 'pro',
    dailyRightSwipesCount: rollingRightCount,
    dailyProposalsCount: data.daily_proposals_count as number,
    usageDate: data.usage_date as string,
    rightSwipeLimit: 15,
    proposalLimit: 5,
    // New, additive fields for the total-swipe-cap popup/modal — not yet
    // consumed by every caller of this endpoint, but always present so the
    // frontend can rely on them without a feature-detection dance.
    totalSwipesCount: rollingTotalCount,
    totalSwipeLimit: 50,
    // Identity/linking state — read from the verified auth user, never
    // client-suppliable.
    email: user.email ?? null,
    isAnonymous: user.is_anonymous ?? true,
    linkedinUrl: (data.linkedin_url as string | null) ?? null,
    githubUrl: (data.github_url as string | null) ?? null,
    careerDirection,
  });
}
