/**
 * RemoteMatch — Onboarding persistence contract (AFC / P-INT)
 * ==============================================================================
 * The single shared definition of what /onboarding submits and how it maps to
 * the DB. Used by:
 *   - the client (src/app/onboarding/page.tsx) to build the request
 *   - the server route (src/app/api/onboarding/route.ts) to validate before it
 *     calls the complete_onboarding() SECURITY DEFINER RPC
 *   - the test suites
 *
 * The RPC re-validates everything server-side regardless — this is a fast
 * client/route pre-check and the source of truth for the shape.
 */

export const YEARS_OF_EXPERIENCE = ['0-1', '2-3', '4-6', '7-10', '10+'] as const;
export const WORK_PREFERENCES = ['worldwide', 'my_country', 'selected_countries'] as const;

export type YearsOfExperience = (typeof YEARS_OF_EXPERIENCE)[number];
export type WorkPreference = (typeof WORK_PREFERENCES)[number];

export interface OnboardingSkillInput {
  name: string;
  isPrimary?: boolean;
}

export interface OnboardingPayload {
  fullName: string;
  headline?: string;
  employmentTypes: string[];
  targetRoles: string[];
  yearsOfExperience: YearsOfExperience;
  minSalary?: number | null;
  preferredCurrency?: string;
  skills: OnboardingSkillInput[];
  workPreference: WorkPreference;
  currentCountry: string;
  currentTimezone?: string;
  allowedCountries?: string[];
  willingTimezones?: string[];
  rawResumeText?: string;
}

export interface OnboardingValidationError {
  field: keyof OnboardingPayload;
  message: string;
}

/** Fast structural check. Returns [] when valid. The RPC is the real gate. */
export function validateOnboardingPayload(input: unknown): OnboardingValidationError[] {
  const errs: OnboardingValidationError[] = [];
  const p = (input ?? {}) as Partial<OnboardingPayload>;

  if (typeof p.fullName !== 'string' || p.fullName.trim() === '') {
    errs.push({ field: 'fullName', message: 'Name is required.' });
  }
  if (!Array.isArray(p.employmentTypes) || p.employmentTypes.filter((x) => typeof x === 'string' && x.trim()).length === 0) {
    errs.push({ field: 'employmentTypes', message: 'Pick at least one employment type.' });
  }
  if (!Array.isArray(p.targetRoles) || p.targetRoles.filter((x) => typeof x === 'string' && x.trim()).length === 0) {
    errs.push({ field: 'targetRoles', message: 'Add at least one target role.' });
  }
  if (typeof p.yearsOfExperience !== 'string' || !(YEARS_OF_EXPERIENCE as readonly string[]).includes(p.yearsOfExperience)) {
    errs.push({ field: 'yearsOfExperience', message: 'Select your experience level.' });
  }
  if (typeof p.workPreference !== 'string' || !(WORK_PREFERENCES as readonly string[]).includes(p.workPreference)) {
    errs.push({ field: 'workPreference', message: 'Select a residency scope.' });
  }
  if (typeof p.currentCountry !== 'string' || p.currentCountry.trim() === '') {
    errs.push({ field: 'currentCountry', message: 'Enter your current country.' });
  }
  if (!Array.isArray(p.skills) || p.skills.filter((s) => s && typeof s.name === 'string' && s.name.trim()).length === 0) {
    errs.push({ field: 'skills', message: 'Add at least one skill.' });
  }
  if (p.minSalary != null && (typeof p.minSalary !== 'number' || !Number.isFinite(p.minSalary) || p.minSalary < 0)) {
    errs.push({ field: 'minSalary', message: 'Minimum salary must be a positive number.' });
  }
  return errs;
}

/** Ordered positional arguments for the complete_onboarding() RPC. The order
 *  here MUST match the function signature in migration 014. */
export function toCompleteOnboardingArgs(p: OnboardingPayload) {
  return {
    p_full_name: p.fullName.trim(),
    p_headline: p.headline?.trim() || null,
    p_employment_types: dedupeStrings(p.employmentTypes),
    p_target_roles: dedupeStrings(p.targetRoles),
    p_years_of_experience: p.yearsOfExperience,
    p_min_salary: p.minSalary ?? null,
    p_preferred_currency: p.preferredCurrency?.trim() || 'USD',
    p_skills: p.skills
      .filter((s) => s && typeof s.name === 'string' && s.name.trim())
      .map((s) => ({ name: s.name.trim(), isPrimary: Boolean(s.isPrimary) })),
    p_work_preference: p.workPreference,
    p_current_country: p.currentCountry.trim(),
    p_current_timezone: p.currentTimezone?.trim() || 'UTC',
    p_allowed_countries: dedupeStrings(p.allowedCountries ?? []),
    p_willing_timezones: dedupeStrings(p.willingTimezones ?? []),
    p_raw_resume_text: p.rawResumeText?.trim() || null,
  };
}

function dedupeStrings(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const v = typeof x === 'string' ? x.trim() : '';
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
