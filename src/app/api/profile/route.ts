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

  const [{ data, error }, { data: intent }] = await Promise.all([
    supabase
      .from('profiles')
      .select('plan_tier, daily_right_swipes_count, daily_proposals_count, usage_date, linkedin_url, github_url')
      .eq('id', user.id)
      .single(),
    // career_direction lives on profile_intents (migration 015); an un-onboarded
    // user has no row yet -> treat as the 'continue' default.
    supabase.from('profile_intents').select('career_direction').eq('profile_id', user.id).maybeSingle(),
  ]);

  if (error || !data) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  const careerDirection =
    (intent?.career_direction as string | null) === 'change_fields' ? 'change_fields' : 'continue';

  return NextResponse.json({
    planTier: data.plan_tier as 'free' | 'pro',
    dailyRightSwipesCount: data.daily_right_swipes_count as number,
    dailyProposalsCount: data.daily_proposals_count as number,
    usageDate: data.usage_date as string,
    rightSwipeLimit: 15,
    proposalLimit: 5,
    // Identity/linking state — read from the verified auth user, never
    // client-suppliable.
    email: user.email ?? null,
    isAnonymous: user.is_anonymous ?? true,
    linkedinUrl: (data.linkedin_url as string | null) ?? null,
    githubUrl: (data.github_url as string | null) ?? null,
    careerDirection,
  });
}
