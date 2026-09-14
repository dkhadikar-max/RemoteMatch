import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

/**
 * Gemini Compatibility Remediation (docs/gemini-compatibility-remediation-spec.md)
 * ==============================================================================
 * Single source of truth for the model identifier — replaces 4 independently
 * hardcoded `'gemini-1.5-flash'` literals (career-page-extraction.ts,
 * materials.ts, resume-intelligence.ts, resume.ts). That duplication is WHY
 * the defect went unnoticed: 4 blind spots instead of one. The next
 * retirement is now a one-line change here, not a repo-wide hunt.
 *
 * Default: `gemini-flash-latest` — chosen and live-verified 2026-09-14
 * (real generateContent call, real 200 response, real text extracted via
 * the existing SDK's own `.text()` accessor — see the remediation spec's
 * §6/§9 verification record). `gemini-3.8-flash` was also tested and was
 * NOT chosen: it returned a transient 503 (high demand), not a validation
 * failure, but there is no reason to ship an unverified-this-session model
 * when the alias passed the required live test.
 *
 * `latest`-style aliases are Google's own documented mechanism for this
 * exact problem: hot-swapped to newer releases of the same model
 * generation, with a stated two-week notice before a breaking change
 * (per Google's current model-naming documentation, referenced in the
 * remediation spec). This is NOT a claim that `gemini-flash-latest` is
 * permanently retirement-proof — Google's own lifecycle pages show even
 * "recommended upgrade path" models carry posted shutdown dates. It is a
 * claim that this is the documented, intended way to reduce how often a
 * hardcoded identifier goes stale, which is the actual problem this
 * remediation exists to fix.
 *
 * Observed operational note: `gemini-flash-latest` is a reasoning-capable
 * generation — real usage during verification showed a non-trivial
 * internal `thoughtsTokenCount` (104 tokens for a one-word reply) consumed
 * BEFORE any visible output text, distinct from the old non-reasoning
 * `gemini-1.5-flash`. None of the 4 call sites set `maxOutputTokens`
 * (confirmed by direct inspection during the audit), so this does not
 * currently risk silently truncating real output to empty — but it does
 * mean real calls may cost more tokens and take longer than the retired
 * model did. Worth remembering if a future caller ever adds an output cap.
 */
export const GEMINI_MODEL_ID = process.env.GEMINI_MODEL || 'gemini-flash-latest';

/** Thin wrapper so every call site shares one construction path instead of
 *  repeating `genAI.getGenerativeModel({ model: '<literal>' })` inline —
 *  the actual mechanism that eliminates the 4-independent-literals problem,
 *  not just moving the default value into one place. */
export function getGeminiModel(genAI: GoogleGenerativeAI): GenerativeModel {
  return genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });
}
