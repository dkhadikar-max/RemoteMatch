import type {
  CanonicalOpportunity,
  PersonProfile,
  CareerTransitionResult,
  CareerTransitionClass,
} from '@/types/byn';

/**
 * Career Transition Matching V1 — a PURE, DETERMINISTIC, ADDITIVE layer.
 *
 * It does NOT import from or modify src/lib/matching/engine.ts. It does NOT
 * change eligibility, the fit-score formula, feed ranking, or the decision
 * snapshot. Its only job: for a user who has EXPLICITLY chosen `change_fields`,
 * explain how their proven experience transfers to an opportunity that already
 * aligns with a role they want.
 *
 * Anti-fabrication: `transferableExperience` is strictly the intersection of
 * the job's required skills with the user's CONFIRMED profile skills (a skill
 * the user listed in onboarding — `evidenceLevel` is not persisted for real
 * users, so a listed skill counts unless it is explicitly marked 'missing',
 * a tier only fixtures/tests can produce). Raw résumé text is NOT scanned —
 * substring presence ("no experience with Kubernetes") is not evidence.
 */

export const CAREER_TRANSITION_RULES_VERSION = 'career-transition-2026.09-v1';

// Classification thresholds on the proven-skill overlap ratio. Preconditions
// (change_fields + eligible + title-aligned) are checked before these apply.
const DIRECT_MIN_OVERLAP = 0.6;
const TRANSITION_MIN_OVERLAP = 0.25;

/** Generic role words that carry no domain signal — mirrors the set the
 *  eligibility gate uses, kept local so engine.ts is never touched. */
const GENERIC_ROLE_TOKENS = new Set([
  'engineer', 'developer', 'software', 'specialist', 'manager', 'lead', 'senior',
  'junior', 'staff', 'principal', 'architect', 'associate', 'head', 'director',
  'vp', 'officer', 'intern', 'contractor', 'consultant', 'expert', 'role',
]);

function skillMatches(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return x === y || x.includes(y) || y.includes(x);
}

/** A profile skill counts as confirmed evidence unless explicitly 'missing'. */
function confirmedSkillNames(profile: PersonProfile): string[] {
  return (profile.skills || [])
    .filter((s) => s.evidenceLevel !== 'missing')
    .map((s) => s.skillName)
    .filter((n) => typeof n === 'string' && n.trim().length > 0);
}

/**
 * Does the job align with one of the user's target roles? Returns the matched
 * target role, or null. Same shape as the eligibility gate's role-relevance
 * check, re-implemented locally (engine.ts is frozen).
 */
function alignedTargetRole(profile: PersonProfile, opp: CanonicalOpportunity): string | null {
  const targetRoles = profile.intent?.targetRoles ?? [];
  if (targetRoles.length === 0) return null;

  const titleLower = opp.title.toLowerCase();
  const oppSkillsLower = (opp.requiredSkills || []).map((s) => s.toLowerCase());
  const oppText = `${titleLower} ${oppSkillsLower.join(' ')}`;
  const confirmed = confirmedSkillNames(profile).map((s) => s.toLowerCase());

  for (const role of targetRoles) {
    const tokens = role.toLowerCase().split(/[\s/-]+/).filter((w) => w.length > 1);
    const substantive = tokens.filter((t) => !GENERIC_ROLE_TOKENS.has(t));

    if (substantive.length > 0) {
      if (substantive.some((t) => oppText.includes(t))) return role;
    } else {
      // Purely generic target title → fall back to skill overlap, same as the gate.
      if (confirmed.some((sk) => oppSkillsLower.some((o) => o.includes(sk) || sk.includes(o)))) {
        return role;
      }
    }
  }
  return null;
}

function classify(overlapRatio: number): CareerTransitionClass {
  if (overlapRatio >= DIRECT_MIN_OVERLAP) return 'direct';
  if (overlapRatio >= TRANSITION_MIN_OVERLAP) return 'transition';
  return 'stretch';
}

/**
 * Returns the transition explanation for ONE opportunity, or `null` when the
 * transition layer does not apply:
 *   - the user has not chosen `change_fields`
 *   - `isEligible` is false (caller passes the existing gate result in)
 *   - the opportunity does not align with any target role
 *
 * `isEligible` is supplied by the caller (from the UNMODIFIED
 * checkHardEligibility) so this function never calls into engine.ts.
 */
export function classifyCareerTransition(
  profile: PersonProfile,
  opp: CanonicalOpportunity,
  isEligible: boolean,
): CareerTransitionResult | null {
  if (profile.careerDirection !== 'change_fields') return null;
  if (!isEligible) return null;

  const targetRole = alignedTargetRole(profile, opp);
  if (!targetRole) return null;

  const required = (opp.requiredSkills || []).filter((s) => typeof s === 'string' && s.trim());
  const confirmed = confirmedSkillNames(profile);

  const transferableExperience: string[] = [];
  const potentialGaps: string[] = [];
  for (const req of required) {
    if (confirmed.some((c) => skillMatches(c, req))) transferableExperience.push(req);
    else potentialGaps.push(req);
  }

  const overlapRatio = Math.round((transferableExperience.length / Math.max(required.length, 1)) * 100) / 100;

  return {
    classification: classify(overlapRatio),
    targetRole,
    transferableExperience,
    potentialGaps,
    overlapRatio,
    rulesVersion: CAREER_TRANSITION_RULES_VERSION,
  };
}

/** UI copy — never "qualified". Exposed so the client and tests share one source. */
export const CAREER_TRANSITION_COPY: Record<CareerTransitionClass, { label: string; blurb: string }> = {
  direct: {
    label: 'Potential fit',
    blurb: 'Your proven experience already covers most of what this role asks for.',
  },
  transition: {
    label: 'Potential fit',
    blurb: 'Your existing experience overlaps with some requirements for this role.',
  },
  stretch: {
    label: 'Career transition',
    blurb: 'This role is a bigger step from your current experience — see what transfers and what may be missing.',
  },
};
