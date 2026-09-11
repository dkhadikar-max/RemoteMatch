import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';

/**
 * J — Unified Search Profile. The ONLY post-onboarding write path for
 * `profile_intents` / `profile_locations` — a grouped, PARTIAL update.
 * `complete_onboarding()` (AFC, frozen) remains the one-time bootstrap;
 * this is the ongoing editor, same additive-RPC pattern as
 * set_career_direction() (015) and add_profile_skill() (016).
 *
 * POST accepts ANY SUBSET of:
 *   { targetRoles?, employmentTypes?, yearsOfExperience?, minSalary?,
 *     workPreference?, currentCountry? }
 *
 * A key that is ABSENT from the body is never sent to the RPC at all —
 * PostgREST then leaves that named parameter at its SQL DEFAULT NULL, and
 * update_search_preferences() treats NULL as "leave this field unchanged".
 * This is what makes the update genuinely partial: omitting a field is not
 * the same as sending it, and the two are never conflated here.
 *
 * Never touches profile_skills (that stays add_profile_skill()-only, per I)
 * and never calls complete_onboarding().
 */

const YEARS_OF_EXPERIENCE = ['0-1', '2-3', '4-6', '7-10', '10+'];
const WORK_PREFERENCES = ['worldwide', 'my_country', 'selected_countries'];

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.filter((x) => typeof x === 'string' && x.trim() !== '').length > 0;
}

export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { supabase } = auth;

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Fast shape pre-check, mirroring the onboarding contract's style — the RPC
  // re-validates authoritatively regardless.
  const errors: string[] = [];
  if ('targetRoles' in body && !isNonEmptyStringArray(body.targetRoles)) errors.push('targetRoles');
  if ('employmentTypes' in body && !isNonEmptyStringArray(body.employmentTypes)) errors.push('employmentTypes');
  if ('yearsOfExperience' in body && !YEARS_OF_EXPERIENCE.includes(body.yearsOfExperience as string)) {
    errors.push('yearsOfExperience');
  }
  if ('workPreference' in body && !WORK_PREFERENCES.includes(body.workPreference as string)) {
    errors.push('workPreference');
  }
  if ('currentCountry' in body && (typeof body.currentCountry !== 'string' || body.currentCountry.trim() === '')) {
    errors.push('currentCountry');
  }
  if (
    'minSalary' in body &&
    (typeof body.minSalary !== 'number' || !Number.isFinite(body.minSalary) || body.minSalary < 0)
  ) {
    errors.push('minSalary');
  }
  if (errors.length > 0) {
    return NextResponse.json({ error: 'Invalid search preferences', fields: errors }, { status: 400 });
  }
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: 'No fields supplied' }, { status: 400 });
  }

  // Only include a named RPC arg for a key that was actually present in the
  // body — an absent key must never become an explicit `null` here.
  const args: Record<string, unknown> = {};
  if ('targetRoles' in body) args.p_target_roles = body.targetRoles;
  if ('employmentTypes' in body) args.p_employment_types = body.employmentTypes;
  if ('yearsOfExperience' in body) args.p_years_of_experience = body.yearsOfExperience;
  if ('minSalary' in body) args.p_min_salary = body.minSalary;
  if ('workPreference' in body) args.p_work_preference = body.workPreference;
  if ('currentCountry' in body) args.p_current_country = (body.currentCountry as string).trim();

  const { error } = await supabase.rpc('update_search_preferences', args);
  if (error) {
    const status = error.code === '28000' ? 401 : error.code === '23514' ? 400 : 500;
    return NextResponse.json({ error: 'Could not update search preferences' }, { status });
  }

  return NextResponse.json({ ok: true });
}
