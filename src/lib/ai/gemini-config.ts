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
 * AI Phase 0 update (2026-09-14, docs/ai-phase1-implementation-plan.md,
 * remotematch-phase0-ai-verification-results memory) — SUPERSEDES the
 * `gemini-flash-latest` default below:
 *
 * `gemini-2.5-flash` and `gemini-2.5-flash-lite` (the two models Phase 0
 * set out to compare against) turned out to BOTH be retired (live 404 "no
 * longer available to new users"), same failure class as the original
 * `gemini-1.5-flash` retirement this file exists to guard against. Google's
 * own error named live replacements: `gemini-2.5-flash-lite` ->
 * `gemini-3.5-flash-lite`; `gemini-2.5-flash` -> `gemini-3.6-flash`.
 *
 * Both replacements were live-tested against the REAL, unmodified C5
 * extraction prompt + the REAL, unmodified `validateExtraction()` (Stage B,
 * 2 realistic unstructured-posting fixtures):
 *   - `gemini-3.5-flash-lite`: 2/2 fixtures produced a fully evidence-
 *     validated candidate. Latency 1.2-1.8s. Zero reasoning-token overhead.
 *   - `gemini-3.6-flash`: 1/2 succeeded (the other hit a real 503, not
 *     retried per this project's no-retry-on-503-during-verification
 *     discipline); the successful call took 6.8s and burned 908 reasoning
 *     tokens extracting a trivial posting.
 * `gemini-3.5-flash-lite` is the clear winner on the metric that actually
 * matters (usable jobs extracted per free-tier request, not raw quota
 * comparison) — faster, zero reasoning tax, 100% usable-candidate rate in
 * this sample.
 *
 * `gemini-flash-latest` (the prior default) is NOT reused here even though
 * it still works — it currently bills against `gemini-3.8-flash`'s
 * quota bucket (a real 429 body confirmed this), a bucket this file's
 * previous verification never ran Stage B extraction-quality testing
 * against, unlike the two models above.
 */
export const GEMINI_MODEL_ID = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

/**
 * Gemini free-tier daily request ceiling (AI Phase 1A,
 * docs/ai-phase1-implementation-plan.md §3, locked decision §11.1 —
 * remotematch-ai-cost-policy memory).
 *
 * THIS IS NOT A PERMANENT, GUESSED CONSTANT. It is the best currently-
 * verified evidence available: 20 requests/day/project/model, observed via
 * a REAL 429 error body during a real production sync against the
 * `gemini-3.8-flash` bucket (`gemini-flash-latest`'s actual billed model at
 * the time). `gemini-3.5-flash-lite` (the current default above) has NOT
 * itself been 429-tested — Phase 0 deliberately avoided provoking a real
 * quota exhaustion just to learn the exact number for a new model. This
 * value is used as the best available evidence-based starting ceiling
 * (locked decision: "C5 gets the full currently available Gemini free-tier
 * request budget," not a defensively-shrunk guess) and MUST be corrected
 * here the moment production observes a real 429 naming a different number
 * for the current model. `ai_quota_ledger`'s RPCs never hardcode this
 * number themselves — it's always passed in from here (src/lib/ai/quota-
 * ledger.ts), so a correction stays a one-line change, never a migration.
 */
export const GEMINI_DAILY_REQUEST_LIMIT = Number(process.env.GEMINI_DAILY_REQUEST_LIMIT) || 20;

/**
 * C5 per-employer soft cap (AI Phase 1A, locked decision §11.5): expressed
 * as a FRACTION of GEMINI_DAILY_REQUEST_LIMIT, not a second hardcoded
 * absolute number — so the per-employer cap self-adjusts automatically if
 * the daily limit above is ever corrected from new real evidence, with
 * nothing else to remember to update. Default 0.35: no single employer can
 * consume more than ~35% of whatever the current verified daily limit is.
 */
export const GEMINI_PER_EMPLOYER_DAILY_SOFT_CAP_FRACTION =
  Number(process.env.GEMINI_PER_EMPLOYER_SOFT_CAP_FRACTION) || 0.35;

/** Thin wrapper so every call site shares one construction path instead of
 *  repeating `genAI.getGenerativeModel({ model: '<literal>' })` inline —
 *  the actual mechanism that eliminates the 4-independent-literals problem,
 *  not just moving the default value into one place. */
export function getGeminiModel(genAI: GoogleGenerativeAI): GenerativeModel {
  return genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });
}
