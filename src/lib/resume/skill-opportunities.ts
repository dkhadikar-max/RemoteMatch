import type { CanonicalOpportunity, PersonProfile } from '@/types/byn';
import { checkHardEligibility } from '@/lib/matching/engine';

/**
 * Resume Match Opportunities — "Grow your matches" (ticket I).
 *
 * Pure, deterministic, rule-based. NO AI, NO résumé-text scanning. It answers
 * one question: which skills are frequently requested in the jobs relevant to
 * the user, that the user has neither listed nor dismissed — ranked by how many
 * DISTINCT relevant jobs ask for them.
 *
 * It reads `checkHardEligibility` (frozen, read-only) for the relevance filter
 * but NEVER calls into the fit-score formula or feed ranking. Adding a skill
 * that this surface suggested legitimately raises the user's own
 * computeScreeningFit inputs later — that is the user's real profile changing
 * from their explicit confirmation, not a matcher change.
 */

/**
 * The ENTIRE alias map. Deliberately tiny and literal — three well-known
 * spellings of the SAME skill. This must NOT grow into a semantic taxonomy:
 * `javascript`≠`typescript`, `postgresql`≠`sql`, `react`≠`frontend` are
 * different skills and conflating them would produce false opportunity claims.
 */
const SKILL_ALIASES: Record<string, string> = {
  'node.js': 'nodejs',
  'node js': 'nodejs',
  k8s: 'kubernetes',
  golang: 'go',
};

/** lower + trim + collapse internal whitespace + apply the tiny alias map. */
export function normalizeSkillKey(raw: string): string {
  const base = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  return SKILL_ALIASES[base] ?? base;
}

/**
 * The "relevant jobs" set (I2 = hard-eligible AND target-role-aligned).
 *
 * `checkHardEligibility().isEligible` already REQUIRES role relevance as one of
 * its four components (`roleRelevant`, gate D — it checks the user's target
 * roles against the opportunity), so "hard-eligible" here inherently means
 * "hard-eligible AND target-role-aligned". We call the frozen function directly
 * rather than re-implement a parallel alignment check.
 */
export function selectRelevantOpportunities(
  profile: PersonProfile,
  opps: CanonicalOpportunity[],
): CanonicalOpportunity[] {
  return opps.filter((opp) => checkHardEligibility(profile, opp).isEligible);
}

export interface SkillOpportunity {
  /** Display name — the most common original casing seen across relevant jobs. */
  skill: string;
  /** Normalized key — what "I don't have this" dismisses. */
  skillKey: string;
  /** Number of DISTINCT relevant jobs that ask for this skill (never a raw
   *  occurrence count — one job asking for it 3× still contributes 1). */
  jobCount: number;
}

export function computeSkillOpportunities(input: {
  relevantOpps: Array<Pick<CanonicalOpportunity, 'requiredSkills'>>;
  ownedSkillKeys: Set<string>;
  dismissedKeys: Set<string>;
  limit?: number;
}): SkillOpportunity[] {
  const jobCount = new Map<string, number>();
  const displayVotes = new Map<string, Map<string, number>>();

  for (const opp of input.relevantOpps) {
    // Collapse case + alias variants WITHIN this one job first, so a job that
    // lists "React", "react" and "React.js" contributes 1 to each distinct key,
    // not 3 to "react".
    const rawByKey = new Map<string, string>();
    for (const raw of opp.requiredSkills || []) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const key = normalizeSkillKey(raw);
      if (!rawByKey.has(key)) rawByKey.set(key, raw.trim());
    }
    rawByKey.forEach((disp, key) => {
      jobCount.set(key, (jobCount.get(key) ?? 0) + 1);
      const votes = displayVotes.get(key) ?? new Map<string, number>();
      votes.set(disp, (votes.get(disp) ?? 0) + 1);
      displayVotes.set(key, votes);
    });
  }

  const out: SkillOpportunity[] = [];
  jobCount.forEach((count, key) => {
    if (input.ownedSkillKeys.has(key) || input.dismissedKeys.has(key)) return;
    let bestDisp = key;
    let best = -1;
    displayVotes.get(key)!.forEach((c, d) => {
      if (c > best) {
        best = c;
        bestDisp = d;
      }
    });
    out.push({ skill: bestDisp, skillKey: key, jobCount: count });
  });

  out.sort((a, b) => b.jobCount - a.jobCount || a.skill.localeCompare(b.skill));
  return typeof input.limit === 'number' ? out.slice(0, input.limit) : out;
}
