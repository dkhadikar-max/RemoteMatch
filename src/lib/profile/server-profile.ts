import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { PersonProfile } from '@/types/byn';

/**
 * Server-authoritative PersonProfile construction (ticket O9, extracted from
 * ticket I's `/api/resume/opportunities` route — behavior-preserving,
 * byte-identical output, verified by I's own resume-opportunities-suite
 * staying green after the extraction).
 *
 * Builds a minimal but genuinely real `PersonProfile` from the profile_*
 * tables, scoped to the caller via RLS on `supabase` (the caller's own
 * session client — never the admin client). This is the ONLY correct way
 * to get real profile CONTENT server-side: never the client-local
 * `localStore` fixture (a demo/seed singleton with no relationship to any
 * specific request), and never a client-supplied request body for anything
 * that spends quota or persists — see the O1 audit finding this fixes.
 *
 * Deliberately minimal: only the fields any current caller
 * (checkHardEligibility, generateApplicationKit, deriveActionableSkillGaps)
 * actually reads are populated from real data; everything else gets a
 * harmless, clearly-a-default value. Never touches profile_experiences
 * (confirmed dead — zero rows, no write path anywhere in the app) or any
 * matching-engine/snapshot type.
 */
export async function loadServerProfile(
  supabase: SupabaseClient,
  user: Pick<User, 'id' | 'email'>,
): Promise<PersonProfile> {
  const [
    { data: skills },
    { data: intent },
    { data: location },
    { data: profileRow },
  ] = await Promise.all([
    supabase.from('profile_skills').select('skill_name').eq('profile_id', user.id),
    supabase
      .from('profile_intents')
      .select('employment_types, target_roles, years_of_experience')
      .eq('profile_id', user.id)
      .maybeSingle(),
    supabase
      .from('profile_locations')
      .select('current_country, current_timezone, work_preference, allowed_countries')
      .eq('profile_id', user.id)
      .maybeSingle(),
    supabase.from('profiles').select('full_name, raw_resume_text').eq('id', user.id).maybeSingle(),
  ]);

  const skillNames = (skills ?? []).map((s) => s.skill_name as string).filter(Boolean);
  const now = new Date().toISOString();

  const YOE = ['0-1', '2-3', '4-6', '7-10', '10+'] as const;
  const yoeRaw = (intent?.years_of_experience as string | null) ?? '';
  // checkHardEligibility does not read yearsOfExperience; coerced only to satisfy the type.
  const yearsOfExperience = (YOE as readonly string[]).includes(yoeRaw)
    ? (yoeRaw as (typeof YOE)[number])
    : '2-3';

  return {
    id: user.id,
    email: user.email ?? '',
    fullName: (profileRow?.full_name as string | null) ?? '',
    rawResumeText: (profileRow?.raw_resume_text as string | null) ?? '',
    planTier: 'free',
    dailyEvaluationsCount: 0,
    lastEvaluationResetAt: now,
    createdAt: now,
    updatedAt: now,
    skills: skillNames.map((skill_name, i) => ({
      id: `s-${i}`,
      profileId: user.id,
      skillName: skill_name,
      isPrimary: false,
    })),
    experiences: [],
    intent: {
      id: 'intent',
      profileId: user.id,
      employmentTypes: ((intent?.employment_types as string[] | null) ?? []) as NonNullable<
        PersonProfile['intent']
      >['employmentTypes'],
      targetRoles: (intent?.target_roles as string[] | null) ?? [],
      yearsOfExperience,
      preferredCurrency: 'USD',
      availabilityStatus: 'immediately',
      updatedAt: now,
    },
    location: {
      id: 'loc',
      profileId: user.id,
      currentCountry: (location?.current_country as string | null) ?? 'Worldwide',
      currentTimezone: (location?.current_timezone as string | null) ?? 'UTC',
      workPreference:
        (location?.work_preference as 'worldwide' | 'my_country' | 'selected_countries' | null) ??
        'worldwide',
      allowedCountries: (location?.allowed_countries as string[] | null) ?? [],
      willingTimezones: [],
    },
  };
}
