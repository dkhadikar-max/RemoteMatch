import type { CanonicalOpportunity, PersonProfile } from '@/types/byn';
import { normalizeSkillKey } from '@/lib/resume/skill-opportunities';

/**
 * Actionable Skill Gaps (ticket L, "What may be missing" / "What you can do").
 *
 * Pure, deterministic, isolated from `src/lib/matching/engine.ts` — it never
 * imports engine.ts and engine.ts never imports it. It independently
 * re-derives which of a specific opportunity's `requiredSkills` the profile
 * does not demonstrate, using the SAME two-way fuzzy-match rule already used
 * in two other places in this codebase (`engine.ts`'s
 * `generateRuleBasedMatchAnalysis` and `career-transition.ts`'s
 * `skillCovers`): case-insensitive equality or substring either direction.
 * Re-implemented locally on purpose (this project's established pattern —
 * see `career-transition.ts` / `skill-opportunities.ts`) rather than
 * imported, so the frozen matcher stays untouched and unaffected by this
 * ticket even indirectly.
 *
 * Anti-fabrication guarantee, same as ticket I: this only ever says "the
 * profile doesn't show this skill" — it never asserts the user LACKS the
 * skill. The caller is responsible for phrasing that stays a question
 * ("Do you have X experience?"), never an assertion.
 */

function fuzzyMatches(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return x === y || x.includes(y) || y.includes(x);
}

export interface ActionableSkillGap {
  /** Display name, taken verbatim from `opportunity.requiredSkills`. */
  skill: string;
  /** Normalized key — same normalization I's `add_profile_skill`/
   *  `dismiss_profile_skill` routes key off of. */
  skillKey: string;
}

/** Same cap `generateRuleBasedMatchAnalysis` applies to `strengths`/`gaps`,
 *  so "What may be missing" never grows unbounded on a role with a long
 *  requirements list. */
const MAX_GAPS = 5;

export function deriveActionableSkillGaps(
  profile: Pick<PersonProfile, 'skills'>,
  opportunity: Pick<CanonicalOpportunity, 'requiredSkills'>,
): ActionableSkillGap[] {
  const profileSkillNames = (profile.skills || []).map((s) => s.skillName).filter(Boolean);

  const seenKeys = new Set<string>();
  const out: ActionableSkillGap[] = [];

  for (const raw of opportunity.requiredSkills || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = normalizeSkillKey(raw);
    if (seenKeys.has(key)) continue; // dedupe variants within this one job
    seenKeys.add(key);

    const covered = profileSkillNames.some((ps) => fuzzyMatches(ps, raw));
    if (!covered) {
      out.push({ skill: raw.trim(), skillKey: key });
    }
  }

  return out.slice(0, MAX_GAPS);
}
