/**
 * F — Settings data-source alignment. Deterministic "Profile completeness"
 * shown on /settings. This is NOT a matching/readiness score — it is purely
 * "how many of the core profile fields the user has filled", each worth 1/5.
 *
 * Every input comes from the server (`GET /api/onboarding` + `GET /api/profile`).
 * There is NO fabricated fallback — an empty field counts as 0, so a user with
 * only their name filled reads 20%, not an invented 85%.
 */
export interface ProfileCompletenessInput {
  fullName?: string | null;
  headline?: string | null;
  skillCount: number;
  targetRoleCount: number;
  employmentTypeCount: number;
  currentCountry?: string | null;
  currentTimezone?: string | null;
}

export interface ProfileCompleteness {
  /** 0..5 */
  completed: number;
  total: 5;
  /** completed / 5 * 100, integer */
  percent: number;
  /** per-criterion, for a checklist UI if wanted */
  criteria: {
    name: boolean;
    headline: boolean;
    skills: boolean;
    preferences: boolean;
    location: boolean;
  };
}

const filled = (s: string | null | undefined): boolean => typeof s === 'string' && s.trim().length > 0;

export function computeProfileCompleteness(input: ProfileCompletenessInput): ProfileCompleteness {
  const criteria = {
    name: filled(input.fullName),
    headline: filled(input.headline),
    skills: input.skillCount > 0,
    // "at least one target role OR employment preference"
    preferences: input.targetRoleCount > 0 || input.employmentTypeCount > 0,
    // country AND timezone both present
    location: filled(input.currentCountry) && filled(input.currentTimezone),
  };
  const completed = Object.values(criteria).filter(Boolean).length;
  return {
    completed,
    total: 5,
    percent: Math.round((completed / 5) * 100),
    criteria,
  };
}
