import type { TailoredResumeSuggestions } from '@/types/byn';

/**
 * Anti-fabrication validator (ticket O4) — a CONSERVATIVE CLAIM SCREEN, not
 * a semantic fact-checker. It catches a small, enumerable, mechanically
 * detectable set of unsupported-claim shapes; it does NOT prove every
 * sentence in a passing result is true. The deterministic fallback template
 * remains the actual safety mechanism whenever a known violation fires —
 * this module's job is only to decide when that fallback is required.
 *
 * Contract: a generated claim is "supported" only if it is traceable to one
 * of the trusted inputs explicitly passed in — never to the LLM's own
 * judgment. Checked ONLY on the fields that speak in first person as if
 * already true about the candidate: `coverLetter`, `summaryAdjustment`,
 * `bulletRewrites[].suggestedRewrite`. Deliberately NEVER checks
 * `recommendedSkillsToAdd` (its whole purpose is naming skills the profile
 * does NOT show — a suggestion, not a claim) or
 * `bulletRewrites[].targetRequirement` / `.originalContext` (facts about
 * the JOB's requirement, not claims about the candidate).
 */

export interface FabricationCheckContext {
  /** Skill names the profile does NOT demonstrate for this opportunity —
   *  from deriveActionableSkillGaps(profile, opportunity).map(g => g.skill).
   *  Any of these appearing in a checked field, in any context, is treated
   *  as an unsupported claim (conservative: a false positive here only
   *  costs a safe fallback, never a wrong claim reaching the user). */
  gapSkills: string[];
  /** profile.rawResumeText — the only place a real, specific metric or
   *  employer name could legitimately come from. Empty string when absent
   *  (the common case in production today) — every metric/employer check
   *  below then has nothing to match against, so anything metric- or
   *  employer-shaped fails closed. */
  rawResumeText: string;
  /** opportunity.company — the one organization name that's always
   *  legitimate to name (the letter is addressed to them). */
  opportunityCompany: string;
}

const YEAR_UNIT = /\b(years?|yrs?)\b/i;

/** Result/impact-shaped numeric patterns: percentages, dollar amounts,
 *  scale multipliers ("3x"), and a 2+ digit number next to a scale-sounding
 *  unit word. Explicitly does NOT match a number immediately followed by
 *  "year(s)"/"yr(s)" — years-of-experience is legitimately profile-sourced
 *  (profile.intent.yearsOfExperience), not a claim this check should ever
 *  flag. */
const METRIC_PATTERNS: RegExp[] = [
  /\b\d+(\.\d+)?%/g,
  /\$\d[\d,]*(\.\d+)?/g,
  /\b\d+(\.\d+)?x\b/gi,
  /\b\d{2,}\+?\s*(users?|customers?|clients?|requests?|servers?|engineers?|employees?|downloads?|installs?|transactions?|ms|milliseconds?|seconds?)\b/gi,
];

function findUnsupportedMetric(text: string, rawResumeText: string): boolean {
  for (const pattern of METRIC_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const matched = match[0];
      // Never flag a number that's actually a years-of-experience mention
      // ("5+ years", "10 yrs") — check a short window after the match.
      const after = text.slice(match.index + matched.length, match.index + matched.length + 12);
      if (YEAR_UNIT.test(matched + after)) continue;
      if (rawResumeText && rawResumeText.includes(matched)) continue;
      return true;
    }
  }
  return false;
}

/** A capitalized phrase immediately after "at "/"with "/"for " that names
 *  neither the addressee company nor anything in the real resume text. */
function findUnsupportedEmployer(text: string, rawResumeText: string, opportunityCompany: string): boolean {
  // Each captured "word" must be 2+ characters — excludes the capitalized
  // pronoun "I" and other single-letter capitals from being swept into the
  // candidate organization name (e.g. "at Initech I led" must not capture
  // "Initech I" as the candidate; it must capture "Initech" alone).
  const pattern = /\b(?:at|with|for)\s+((?:[A-Z][a-zA-Z0-9&.'-]+\s*){1,4})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const candidate = match[1].trim().replace(/[.,;:]$/, '');
    if (!candidate) continue;
    if (candidate.toLowerCase() === opportunityCompany.trim().toLowerCase()) continue;
    if (rawResumeText && rawResumeText.includes(candidate)) continue;
    // A capitalized phrase that's just a single common word (e.g. "at Home",
    // "for Free") is very unlikely to be a fabricated employer name — require
    // it to look organization-shaped: either 2+ words, or a single word with
    // an internal capital/digit/ampersand (e.g. "GitLab", "Acme&Co").
    const looksOrgShaped = /\s/.test(candidate) || /[A-Z].*[A-Z]|[&0-9]/.test(candidate.slice(1));
    if (!looksOrgShaped) continue;
    return true;
  }
  return false;
}

function findGapSkillMention(text: string, gapSkills: string[]): string | null {
  const lower = text.toLowerCase();
  for (const skill of gapSkills) {
    if (!skill || !skill.trim()) continue;
    const escaped = skill.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) return skill;
  }
  return null;
}

/**
 * True iff every checked field is fully supported by the trusted context.
 * False means: discard the ENTIRE generated result and use the
 * deterministic fallback template instead — never a partial edit of the
 * LLM's text.
 */
export function isGeneratedKitSupported(
  kit: { coverLetter: string; resumeTweaks: Pick<TailoredResumeSuggestions, 'summaryAdjustment' | 'bulletRewrites'> },
  context: FabricationCheckContext,
): boolean {
  const checkedFields = [
    kit.coverLetter,
    kit.resumeTweaks.summaryAdjustment,
    ...(kit.resumeTweaks.bulletRewrites || []).map((b) => b.suggestedRewrite),
  ].filter((t): t is string => typeof t === 'string' && t.length > 0);

  for (const field of checkedFields) {
    if (findGapSkillMention(field, context.gapSkills)) return false;
    if (findUnsupportedMetric(field, context.rawResumeText)) return false;
    if (findUnsupportedEmployer(field, context.rawResumeText, context.opportunityCompany)) return false;
  }

  return true;
}
