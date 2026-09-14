import OpenAI from 'openai';

/**
 * AI Phase 1B — OpenAI provider configuration
 * (docs/ai-phase1b-implementation-plan.md). Mirrors gemini-config.ts's
 * centralization pattern exactly — a model/pricing/cap change stays a
 * one-line edit here, never a multi-file hunt.
 *
 * Model: `gpt-5-mini` — chosen via real Phase 0b live verification
 * (2026-09-14). Real current pricing (verified live against
 * developers.openai.com/api/docs/pricing): $0.25 / $2.00 per 1M input/
 * output tokens — cheaper than gpt-4.1-mini, more capable than the
 * nano-class models (too weak for quality tailored-materials generation),
 * far cheaper than the o4-mini/o3-mini reasoning-class models ($1.10/
 * $4.40 — overkill for this bounded-call workload). Real account rate
 * limits observed: 500 requests/min, 500,000 tokens/min — confirms
 * OpenAI's binding constraint for RemoteMatch is genuinely COST, not a
 * request ceiling, unlike Gemini.
 *
 * CRITICAL, LOAD-BEARING FINDING (Phase 0b, real evidence): gpt-5-mini is
 * itself a reasoning model. A real verification call WITHOUT
 * reasoning_effort set returned `finish_reason: "length"` with EMPTY
 * visible content — every token of `max_completion_tokens` consumed by
 * internal reasoning, at real (if small) cost, with the calling code's
 * existing malformed-response handling silently falling back to the
 * deterministic template every time. OPENAI_REASONING_EFFORT below is NOT
 * a tunable default — every call site MUST pass it explicitly. See
 * test/openai-reasoning-effort-suite.ts, which regression-guards this
 * exact failure mode from recurring silently after a future edit.
 */
export const OPENAI_MODEL_ID = process.env.OPENAI_MODEL || 'gpt-5-mini';
export const OPENAI_REASONING_EFFORT = 'minimal' as const;

/**
 * Real per-token pricing, USD, live-verified 2026-09-14. Re-verify before
 * trusting these numbers if a meaningful amount of time has passed —
 * OpenAI's pricing changes, same caveat as Gemini's quota numbers.
 */
export const OPENAI_INPUT_PRICE_PER_TOKEN = 0.25 / 1_000_000;
export const OPENAI_OUTPUT_PRICE_PER_TOKEN = 2.0 / 1_000_000;

/**
 * Locked decision (docs/ai-phase1b-implementation-plan.md §7.3 restated —
 * actually §11.2 of the original two-provider spec): hard, application-
 * side daily/monthly spend ceilings, independent of whatever OpenAI's own
 * account-level limits are. A call is never attempted when the applicable
 * cap can't accommodate its conservative reserved-cost estimate — see
 * spend-ledger.ts's reserveOpenAiSpend().
 */
export const OPENAI_DAILY_SPEND_CAP_USD = Number(process.env.OPENAI_DAILY_SPEND_CAP_USD) || 5;
export const OPENAI_MONTHLY_SPEND_CAP_USD = Number(process.env.OPENAI_MONTHLY_SPEND_CAP_USD) || 50;

let client: OpenAI | null = null;

/** Thin wrapper so every call site shares one construction path instead of
 *  repeating `new OpenAI({ apiKey: ... })` inline — same reasoning as
 *  gemini-config.ts's getGeminiModel(). Callers are expected to check
 *  `process.env.OPENAI_API_KEY` themselves before calling this (same
 *  pattern materials.ts/resume.ts/resume-intelligence.ts already use for
 *  GEMINI_API_KEY) — this function does not itself guard against a missing
 *  key. */
export function getOpenAiClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}
