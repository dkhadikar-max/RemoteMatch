/**
 * What counts as a USABLE matching profile — one definition, shared by the feed route (server) and the client.
 * ==============================================================================
 * Before this, the feed route called a profile "scorable" when `skills` was merely an ARRAY — so an EMPTY profile
 * (no skills, no target roles) was scored and rendered as a personalized feed ("Moderate Fit" on unrelated roles),
 * and the UI invented a score when none existed (`fitScore ?? 94`). See docs/profile-fix-scope.md.
 *
 * A profile is usable when it has at least one skill OR at least one target role — the two inputs the matcher
 * actually has something to say about. Blank entries do not count.
 */

const nonBlank = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

export function isUsableProfile(profile: unknown): boolean {
  if (!profile || typeof profile !== 'object') return false;
  const p = profile as { skills?: unknown; intent?: { targetRoles?: unknown } | null };

  const hasSkill = Array.isArray(p.skills) && p.skills.some((s) => nonBlank((s as { skillName?: unknown } | null)?.skillName));
  const roles = p.intent && typeof p.intent === 'object' ? p.intent.targetRoles : undefined;
  const hasRole = Array.isArray(roles) && roles.some(nonBlank);

  return hasSkill || hasRole;
}

/** Why a feed is not personalized — returned by the feed route and read by the UI. */
export type UnpersonalizedReason = 'no_profile' | 'profile_incomplete';

/** The exact wording shown when the profile is incomplete (Deep's copy, 2026-10-13). */
export const INCOMPLETE_PROFILE_COPY = {
  title: 'Complete your profile to get relevant matches.',
  body: 'Add your skills or target roles so we can assess how well each job fits your experience.',
  cta: 'Complete your profile',
  href: '/settings',
} as const;
