import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import {
  OnboardingPayload,
  validateOnboardingPayload,
  toCompleteOnboardingArgs,
} from '@/lib/onboarding/contract';

/**
 * AFC / P-INT — server-backed onboarding.
 *
 * GET  → the caller's current onboarding content, for hydrating the form and
 *        the client-local profile cache (decision 7a). Reads the caller's own
 *        rows via their RLS-scoped session.
 * POST → validate, then call the complete_onboarding() SECURITY DEFINER RPC
 *        (migration 014), which writes profile_intents / profile_skills /
 *        profile_locations + profiles.full_name/headline and stamps
 *        onboarding_completed_at atomically, all for auth.uid() only.
 *
 * This route never touches the service-role client and never writes these
 * tables directly — the RPC is the single atomic, validated writer.
 */

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user, supabase } = auth;

  const [{ data: profile }, { data: intent }, { data: location }, { data: skills }] = await Promise.all([
    supabase.from('profiles').select('full_name, headline, raw_resume_text, onboarding_completed_at').eq('id', user.id).single(),
    supabase.from('profile_intents').select('*').eq('profile_id', user.id).maybeSingle(),
    supabase.from('profile_locations').select('*').eq('profile_id', user.id).maybeSingle(),
    supabase.from('profile_skills').select('skill_name, is_primary').eq('profile_id', user.id),
  ]);

  return NextResponse.json({
    onboardingCompletedAt: (profile?.onboarding_completed_at as string | null) ?? null,
    fullName: (profile?.full_name as string | null) ?? user.user_metadata?.full_name ?? '',
    headline: (profile?.headline as string | null) ?? '',
    rawResumeText: (profile?.raw_resume_text as string | null) ?? '',
    employmentTypes: (intent?.employment_types as string[] | null) ?? [],
    targetRoles: (intent?.target_roles as string[] | null) ?? [],
    yearsOfExperience: (intent?.years_of_experience as string | null) ?? null,
    minSalary: (intent?.min_salary as number | null) ?? null,
    preferredCurrency: (intent?.preferred_currency as string | null) ?? 'USD',
    workPreference: (location?.work_preference as string | null) ?? null,
    currentCountry: (location?.current_country as string | null) ?? '',
    currentTimezone: (location?.current_timezone as string | null) ?? 'UTC',
    allowedCountries: (location?.allowed_countries as string[] | null) ?? [],
    willingTimezones: (location?.willing_timezones as string[] | null) ?? [],
    skills: (skills ?? []).map((s) => ({ name: s.skill_name as string, isPrimary: Boolean(s.is_primary) })),
  });
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
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const errors = validateOnboardingPayload(body);
  if (errors.length > 0) {
    return NextResponse.json({ error: 'Onboarding is incomplete.', fields: errors }, { status: 400 });
  }

  const args = toCompleteOnboardingArgs(body as OnboardingPayload);
  const { data, error } = await supabase.rpc('complete_onboarding', args);

  if (error) {
    // The RPC re-validates; a 23514 there means the payload passed the fast
    // check but failed the authoritative one. 28000 = no auth.uid (shouldn't
    // happen past getAuthenticatedUser, but map it honestly).
    const status = error.code === '28000' ? 401 : error.message.includes('onboarding_invalid') ? 400 : 500;
    return NextResponse.json({ error: 'Could not save onboarding.', detail: error.message }, { status });
  }

  return NextResponse.json({ ok: true, onboardingCompletedAt: data as string });
}
