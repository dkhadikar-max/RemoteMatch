import { normalizeSkillKey } from '@/lib/resume/skill-opportunities';

/**
 * Short-Skill Matching — the single shared skill-match predicate.
 * ==============================================================================
 * Approved remediation for a defect independently reimplemented six times
 * across engine.ts, career-transition.ts, and actionable-skill-gaps.ts: a
 * naive two-way substring check (`a.includes(b) || b.includes(a)`) trivially
 * false-matches any short skill string against unrelated longer ones — e.g.
 * a job requiring the single-character skill "C" matched almost any real
 * profile, since most skill names ("React", "JavaScript", "Docker"...)
 * contain the letter "c" somewhere. Confirmed against real production data:
 * 18 of 72 active opportunities (25%) carry a required skill of <= 3
 * characters; the bare tag "C" alone appeared on 6 of 72 (8.3%).
 *
 * This is the ONLY implementation of the matching rule in this codebase —
 * every one of the six sites above imports this function rather than
 * encoding its own variant. Deliberately co-located with engine.ts, which
 * is now an approved importer of it (the first ticket ever allowed a
 * non-zero diff on engine.ts — see the Short-Skill Matching decision
 * table/spec). The frozen SCORING FORMULA and its weights are untouched by
 * this change; only the boolean "does this skill count as a match"
 * predicate that feeds them changes.
 *
 * Contract (see the approved decision table for the full worked matrix):
 *   1. Exact match after normalization — reuses normalizeSkillKey()
 *      UNMODIFIED, including its existing tiny alias map (golang/go,
 *      node.js/nodejs, node js/nodejs, k8s/kubernetes).
 *   2. If either side is "short" (<= SHORT_SKILL_THRESHOLD characters after
 *      normalization): the short side must appear as a WHOLE TOKEN inside
 *      the longer side (space/hyphen/slash delimited) — never a free
 *      substring. There is no fallback to (3) for a short pair; if the
 *      whole-token check fails, the answer is no. This is what makes
 *      "AWS" match "AWS Lambda" (a real whole-word token) while "C" does
 *      NOT match "React" (no word boundary — "c" is buried mid-string) and
 *      "SQL" does NOT match "PostgreSQL" (fused into one token, no
 *      delimiter to split on — no exception is added for this; see the
 *      decision table's explicit "no semantic exception" ruling).
 *   3. Otherwise (both sides longer than the threshold): the existing
 *      two-way substring behavior, UNCHANGED — this is what keeps "React"
 *      matching "React.js".
 *
 * A genuine byproduct, not the point of the ticket: the old code also
 * false-matched "C" against "C#"/"C++" (distinct languages) — this fixes
 * that too, since neither string contains a delimiter to expose "c" as a
 * standalone token inside them.
 */

/** Below this length, no free substring matching — only exact match or a
 *  whole-token match inside a longer compound skill name. */
const SHORT_SKILL_THRESHOLD = 3;

/** Deliberately whitespace/hyphen/slash only — NOT `.`, `#`, `+`. Excluding
 *  those keeps "C#"/"C++" atomic (never split into "C" + something), and
 *  splits "AWS Lambda" into ["aws","lambda"] so "AWS" matches as a whole
 *  compound-name token. */
const TOKEN_DELIMITERS = /[\s\-/]+/;

function tokenize(s: string): string[] {
  return s.split(TOKEN_DELIMITERS).filter(Boolean);
}

/**
 * Symmetric, pure, no I/O. The single skill-match predicate for the whole
 * codebase — see the module header for the full contract and rationale.
 */
export function skillMatches(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const na = normalizeSkillKey(a);
  const nb = normalizeSkillKey(b);
  if (!na || !nb) return false;

  if (na === nb) return true;

  const aIsShort = na.length <= SHORT_SKILL_THRESHOLD;
  const bIsShort = nb.length <= SHORT_SKILL_THRESHOLD;

  if (aIsShort || bIsShort) {
    const shortSide = aIsShort ? na : nb;
    const longSide = aIsShort ? nb : na;
    return tokenize(longSide).includes(shortSide);
  }

  return na.includes(nb) || nb.includes(na);
}
