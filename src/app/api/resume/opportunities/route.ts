import { NextRequest, NextResponse } from 'next/server';
import type { PersonProfile } from '@/types/byn';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getActiveOpportunities } from '@/lib/ingestion/catalog-read';
import {
  selectRelevantOpportunities,
  computeSkillOpportunities,
  normalizeSkillKey,
  type SkillOpportunity,
} from '@/lib/resume/skill-opportunities';

/**
 * Resume Match Opportunities ("Grow your matches", ticket I).
 *
 * GET -> the skills most frequently requested across the caller's RELEVANT
 * jobs (hard-eligible AND target-role-aligned — see selectRelevantOpportunities)
 * that the caller has neither listed nor dismissed, ranked by DISTINCT relevant
 * job count.
 *
 * Rule-based and deterministic. No AI. No raw_resume_text scanning. Reads the
 * frozen `checkHardEligibility` for the relevance filter; never calls the
 * fit-score formula or feed ranking.
 */
const SUGGESTION_LIMIT = 8;

export interface ResumeSkillOpportunitiesResponse {
  success: boolean;
  opportunities: SkillOpportunity[];
  relevantJobCount: number;
}

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user, supabase } = auth;

  const [
    { data: skills },
    { data: intent },
    { data: location },
    { data: dismissals },
    catalog,
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
    supabase.from('profile_skill_dismissals').select('skill_key').eq('profile_id', user.id),
    getActiveOpportunities(supabase),
  ]);

  const skillNames = (skills ?? []).map((s) => s.skill_name as string).filter(Boolean);
  const now = new Date().toISOString();

  const YOE = ['0-1', '2-3', '4-6', '7-10', '10+'] as const;
  const yoeRaw = (intent?.years_of_experience as string | null) ?? '';
  // checkHardEligibility does not read yearsOfExperience; coerced only to satisfy the type.
  const yearsOfExperience = (YOE as readonly string[]).includes(yoeRaw)
    ? (yoeRaw as (typeof YOE)[number])
    : '2-3';

  // Minimal PersonProfile — only the fields checkHardEligibility reads matter;
  // the rest are filled with harmless defaults.
  const profile: PersonProfile = {
    id: user.id,
    email: user.email ?? '',
    fullName: '',
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

  const relevant = selectRelevantOpportunities(profile, catalog);

  const ownedSkillKeys = new Set(skillNames.map((n) => normalizeSkillKey(n)));
  const dismissedKeys = new Set((dismissals ?? []).map((d) => d.skill_key as string));

  const opportunities = computeSkillOpportunities({
    relevantOpps: relevant,
    ownedSkillKeys,
    dismissedKeys,
    limit: SUGGESTION_LIMIT,
  });

  const payload: ResumeSkillOpportunitiesResponse = {
    success: true,
    opportunities,
    relevantJobCount: relevant.length,
  };
  return NextResponse.json(payload);
}
