/**
 * The onboarding "resume check" — facts only.
 * ==============================================================================
 * Replaces the previous "analysis", whose output was largely hard-coded (a nine-character gibberish "resume" scored
 * 48/100 with "Clean chronological formatting" and invented "strengths"; see docs/audit-2026-10-13-resume-analysis.md,
 * R-P0-1). This module computes ONLY what can be stated truthfully from the inputs:
 *
 *   - how much text there is (characters / words), and whether it is too little to conclude anything;
 *   - which of the user's DECLARED skills literally appear in that text, and which do not (a text search — see
 *     skill-evidence.ts for exactly what that means and its limits).
 *
 * It produces no score, no strengths, no "improvements" and no claim that the resume was verified or understood.
 * Matching today uses the user's declared profile, not the resume (that statement is shown in the UI).
 * Pure; never throws.
 */
import { skillAppearsInText, normalizeResumeText } from './skill-evidence';

export const MIN_WORDS_FOR_CHECK = 8;
export const MAX_SKILLS_CHECKED = 100;

export type ResumeCheckStatus =
  /** Enough text; found / notFound are meaningful. */
  | 'ok'
  /** Nothing (or only whitespace / control characters) was provided. */
  | 'empty'
  /** Too little text to conclude that a skill is absent; only positive finds are reported. */
  | 'too_short'
  /** Unexpected failure; nothing is reported (the user can still continue). */
  | 'error';

export interface ResumeCheck {
  status: ResumeCheckStatus;
  characterCount: number;
  wordCount: number;
  /** Declared skills that appear in the resume text. */
  found: string[];
  /** Declared skills that do NOT appear (only populated when status === 'ok'). */
  notFound: string[];
  /** Number of distinct declared skills that were considered. */
  skillsChecked: number;
}

const EMPTY: ResumeCheck = { status: 'empty', characterCount: 0, wordCount: 0, found: [], notFound: [], skillsChecked: 0 };

/** Distinct, trimmed, non-empty skill names (case-insensitive de-dupe), capped; non-strings dropped. */
export function sanitizeSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of skills) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (!t || t.length > 80) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_SKILLS_CHECKED) break;
  }
  return out;
}

export function checkResumeAgainstSkills(skills: unknown, resumeText: unknown): ResumeCheck {
  try {
    const text = normalizeResumeText(resumeText).trim();
    const declared = sanitizeSkills(skills);
    if (!text) return { ...EMPTY, skillsChecked: declared.length };

    const words = text.split(/\s+/).filter(Boolean).length;
    const found: string[] = [];
    const notFound: string[] = [];
    for (const skill of declared) (skillAppearsInText(skill, text) ? found : notFound).push(skill);

    if (words < MIN_WORDS_FOR_CHECK) {
      // Too little text to say a skill is "missing" — report positives only.
      return { status: 'too_short', characterCount: text.length, wordCount: words, found, notFound: [], skillsChecked: declared.length };
    }
    return { status: 'ok', characterCount: text.length, wordCount: words, found, notFound, skillsChecked: declared.length };
  } catch {
    return { ...EMPTY, status: 'error' };
  }
}

export const MAX_SUGGESTED_SKILLS = 5;

/**
 * Skills from a known candidate-facing vocabulary (e.g. onboarding's `popularSkills`) that literally appear in the
 * resume text and are not already declared. Never suggests anything outside `candidateSkillList` — this cannot
 * invent a skill, only confirm a text occurrence of one already on a fixed, reviewed list, via the same
 * `skillAppearsInText` matcher `checkResumeAgainstSkills` uses. Case-insensitive de-dupe against what's already
 * declared, and against an EXACT repeated entry within `candidateSkillList` (by lowercased string equality) — this
 * does NOT canonicalize alias spellings (e.g. "C++" vs "cpp" are checked independently and could each produce a
 * suggestion for the same underlying skill if both were present in the list). The one caller of this function,
 * onboarding's fixed `popularSkills`, contains no such alias pairs, so this does not occur in practice today; a
 * real alias-canonicalization pass is out of scope for this feature. Same honesty posture as
 * `checkResumeAgainstSkills`: too little resume text to judge → no suggestions. Pure; never throws.
 */
export function suggestSkillsFromResume(
  declaredSkills: unknown,
  resumeText: unknown,
  candidateSkillList: readonly string[]
): string[] {
  try {
    const text = normalizeResumeText(resumeText).trim();
    if (!text) return [];
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < MIN_WORDS_FOR_CHECK) return [];

    const declared = new Set(sanitizeSkills(declaredSkills).map((s) => s.toLowerCase()));
    const suggested: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidateSkillList) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (declared.has(key) || seen.has(key)) continue;
      if (skillAppearsInText(trimmed, text)) {
        seen.add(key);
        suggested.push(trimmed);
        if (suggested.length >= MAX_SUGGESTED_SKILLS) break;
      }
    }
    return suggested;
  } catch {
    return [];
  }
}
