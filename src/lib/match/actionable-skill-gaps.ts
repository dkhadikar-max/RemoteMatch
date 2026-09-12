import type { CanonicalOpportunity, PersonProfile } from '@/types/byn';
import { normalizeSkillKey } from '@/lib/resume/skill-opportunities';
import { skillMatches } from '@/lib/matching/skill-match';

/**
 * Actionable Skill Gaps (ticket L, "What may be missing" / "What you can do").
 *
 * Pure, deterministic, isolated from `src/lib/matching/engine.ts` itself —
 * it never imports engine.ts and engine.ts never imports it. It
 * independently re-derives which of a specific opportunity's
 * `requiredSkills` the profile does not demonstrate.
 *
 * Short-Skill Matching (approved remediation) — this module now imports the
 * shared `skillMatches()` predicate from `@/lib/matching/skill-match` (a
 * sibling module of engine.ts, not engine.ts itself), replacing what used
 * to be a locally-reimplemented `fuzzyMatches()` — one of six independent,
 * independently-buggy copies of the same two-way substring rule found
 * across this codebase (a bare required skill like "C" trivially
 * false-matched almost any real profile). Fixing only engine.ts's copies
 * would have left THIS module's copy — the one that feeds L-adjacent-1's
 * honest job-card counts — silently exposed to the identical defect. See
 * src/lib/matching/skill-match.ts for the full contract.
 *
 * Anti-fabrication guarantee, same as ticket I: this only ever says "the
 * profile doesn't show this skill" — it never asserts the user LACKS the
 * skill. The caller is responsible for phrasing that stays a question
 * ("Do you have X experience?"), never an assertion.
 */

export interface ActionableSkillGap {
  /** Display name, taken verbatim from `opportunity.requiredSkills`. */
  skill: string;
  /** Normalized key — same normalization I's `add_profile_skill`/
   *  `dismiss_profile_skill` routes key off of. */
  skillKey: string;
}

/** Same cap `generateRuleBasedMatchAnalysis` applies to `strengths`/`gaps`,
 *  so "What may be missing" never grows unbounded on a role with a long
 *  requirements list. Applied only to the DISPLAY list below — never to the
 *  card's honest count (L-adjacent-1), which must reflect every distinct
 *  requirement, not just the first 5. */
const MAX_GAPS = 5;

/**
 * The single, shared, UNCAPPED coverage computation — every distinct
 * required skill for this opportunity (`total`, deduped by
 * `normalizeSkillKey`, in encounter order), and the subset the profile does
 * not demonstrate (`gaps`). Both `deriveActionableSkillGaps` (L's capped
 * display list) and `deriveSkillMatchSummary` (L-adjacent-1's honest job-
 * card count) are thin views over this ONE matching pass — never two
 * separately-maintained implementations of the same fuzzy-match/dedup
 * rule.
 */
function computeSkillCoverage(
  profile: Pick<PersonProfile, 'skills'>,
  opportunity: Pick<CanonicalOpportunity, 'requiredSkills'>,
): { total: ActionableSkillGap[]; gaps: ActionableSkillGap[] } {
  const profileSkillNames = (profile.skills || []).map((s) => s.skillName).filter(Boolean);

  const seenKeys = new Set<string>();
  const total: ActionableSkillGap[] = [];
  const gaps: ActionableSkillGap[] = [];

  for (const raw of opportunity.requiredSkills || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = normalizeSkillKey(raw);
    if (seenKeys.has(key)) continue; // dedupe variants within this one job
    seenKeys.add(key);

    const entry: ActionableSkillGap = { skill: raw.trim(), skillKey: key };
    total.push(entry);

    const covered = profileSkillNames.some((ps) => skillMatches(ps, raw));
    if (!covered) {
      gaps.push(entry);
    }
  }

  return { total, gaps };
}

export function deriveActionableSkillGaps(
  profile: Pick<PersonProfile, 'skills'>,
  opportunity: Pick<CanonicalOpportunity, 'requiredSkills'>,
): ActionableSkillGap[] {
  return computeSkillCoverage(profile, opportunity).gaps.slice(0, MAX_GAPS);
}

/**
 * L-adjacent-1 — the job card's honest replacement for the old
 * back-calculated-from-fitScore `metCount` (which reflected the WHOLE
 * scoring formula — role alignment, seniority, geography — never actual
 * skill overlap) and the arbitrary `requiredSkills[metCount]` array-index
 * "missing skill". `totalCount` is deliberately UNCAPPED — a role with 6+
 * genuine gaps must report all 6+ as required, not silently truncate to 5
 * the way the display-only `deriveActionableSkillGaps` does.
 */
export interface SkillMatchSummary {
  /** Distinct required skills the profile demonstrates (fuzzy-matched). */
  matchedCount: number;
  /** Every distinct required skill for this opportunity — uncapped. */
  totalCount: number;
  /** The first genuinely unmatched requirement, or null when there are none. */
  firstMissingSkill: string | null;
}

export function deriveSkillMatchSummary(
  profile: Pick<PersonProfile, 'skills'>,
  opportunity: Pick<CanonicalOpportunity, 'requiredSkills'>,
): SkillMatchSummary {
  const { total, gaps } = computeSkillCoverage(profile, opportunity);
  return {
    matchedCount: total.length - gaps.length,
    totalCount: total.length,
    firstMissingSkill: gaps[0]?.skill ?? null,
  };
}
