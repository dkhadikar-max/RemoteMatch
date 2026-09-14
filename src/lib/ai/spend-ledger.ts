import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import {
  OPENAI_MODEL_ID,
  OPENAI_INPUT_PRICE_PER_TOKEN,
  OPENAI_OUTPUT_PRICE_PER_TOKEN,
  OPENAI_DAILY_SPEND_CAP_USD,
  OPENAI_MONTHLY_SPEND_CAP_USD,
} from './openai-config';

/**
 * AI Phase 1B — OpenAI spend ledger
 * (docs/ai-phase1b-implementation-plan.md §2/§3).
 * ==============================================================================
 * New importer of the service-role admin client (`admin.ts` trust-anchor
 * list): `ai_spend_ledger`'s RLS has zero client policies (service-role
 * only, migration 024) and every value written here (feature, model, cost
 * estimate) is computed server-side from static config or a real OpenAI
 * response, never from client-supplied input.
 *
 * THE SAFETY INVARIANT (identical in kind to quota-ledger.ts's Gemini
 * version, restated as load-bearing code, not just a comment): once OpenAI
 * has been reached and returned ANY response — success, 429, 5xx,
 * malformed, anything — the caller MUST call consumeOpenAiSpend(), never
 * refundOpenAiSpend(). refundOpenAiSpend() is the ONLY function that
 * returns a reservation, and it must be called ONLY when OpenAI was never
 * reached at all (a pre-flight DB/network error before the request left
 * the process).
 *
 * ONE REAL STRUCTURAL DIFFERENCE from Gemini's ledger: a reservation here
 * is a COMPUTED ESTIMATE (varies per call, based on maxTokens at
 * reservation time), not a fixed "1 request". `reservedCostUsd` returned
 * by reserveOpenAiSpend() MUST be carried through unchanged to whichever
 * of consumeOpenAiSpend()/refundOpenAiSpend() the caller eventually calls
 * — losing track of it would let the ledger's reserved_cost_usd drift from
 * reality.
 */

export interface OpenAiReservationResult {
  allowed: boolean;
  reason?: 'daily_cap_exceeded' | 'monthly_cap_exceeded' | 'not_configured';
  usagePeriod?: string;
  /** The exact amount reserved for this call — pass back unchanged to
   *  consumeOpenAiSpend()/refundOpenAiSpend(). Present only when allowed. */
  reservedCostUsd?: number;
}

/** Deliberately conservative overestimate (real English text averages
 *  ~4 chars/token) — never a real tokenizer call, no extra API round-trip.
 *  Locked per docs/ai-phase1b-implementation-plan.md §3/§7.1: errs toward
 *  over-reserving, never under. */
function estimatePromptTokens(promptText: string): number {
  return Math.ceil(promptText.length / 3);
}

export function estimateReservationCostUsd(promptText: string, maxTokens: number): number {
  const promptTokens = estimatePromptTokens(promptText);
  return promptTokens * OPENAI_INPUT_PRICE_PER_TOKEN + maxTokens * OPENAI_OUTPUT_PRICE_PER_TOKEN;
}

export async function reserveOpenAiSpend(
  feature: string,
  promptText: string,
  maxTokens: number
): Promise<OpenAiReservationResult> {
  // Hardening fix (2026-09-14, real finding from Phase 1B live verification —
  // same fix applied to quota-ledger.ts's reserveGeminiRequest()):
  // getSupabaseAdminClient() can throw SYNCHRONOUSLY in a bare-Node context
  // (Node < 22 without a WebSocket polyfill — Next.js's own server runtime
  // doesn't hit this). Every other function in this file already wraps its
  // getSupabaseAdminClient() call in try/catch; this one didn't. See
  // test/ai-ledger-failsafe-suite.ts for the regression coverage.
  let admin;
  try {
    admin = getSupabaseAdminClient();
  } catch (err) {
    console.warn('[spend-ledger] getSupabaseAdminClient() threw, failing closed:', err);
    return { allowed: false, reason: 'not_configured' };
  }
  if (!isSupabaseAdminConfigured || !admin) {
    return { allowed: false, reason: 'not_configured' };
  }

  const reservedCostUsd = estimateReservationCostUsd(promptText, maxTokens);

  const { data, error } = await admin.rpc('reserve_openai_spend', {
    p_model: OPENAI_MODEL_ID,
    p_feature: feature,
    p_reserved_cost_usd: reservedCostUsd,
    p_daily_cap_usd: OPENAI_DAILY_SPEND_CAP_USD,
    p_monthly_cap_usd: OPENAI_MONTHLY_SPEND_CAP_USD,
  });

  if (error || !data) {
    console.warn('[spend-ledger] reserve_openai_spend failed, treating as not allowed:', error?.message);
    return { allowed: false, reason: 'daily_cap_exceeded' };
  }

  return {
    allowed: Boolean(data.allowed),
    reason: data.allowed ? undefined : (data.reason ?? 'daily_cap_exceeded'),
    usagePeriod: data.usagePeriod,
    reservedCostUsd: data.allowed ? reservedCostUsd : undefined,
  };
}

export interface OpenAiConsumeResult {
  /** The REAL reconciled cost of this call (from the response's own usage
   *  object when available, else the full original reservation as a
   *  conservative fallback) — this is what actually got recorded into
   *  ai_spend_ledger.estimated_cost_usd. Callers MUST use this value (not
   *  reservedCostUsd) when logging to ai_call_events, so operational cost
   *  dashboards built from that table reflect real spend, not the pre-call
   *  estimate (fixed 2026-09-14 — was a real observability inconsistency
   *  found during Phase 1B live verification: events showed the $0.0042
   *  reservation even though the ledger correctly reconciled to $0.0015). */
  actualCostUsd: number;
  tokensUsed: number;
}

/** Call after ANY response from OpenAI — success, failure, malformed,
 *  anything that means the request actually reached the provider. Pass the
 *  real `usage.prompt_tokens`/`usage.completion_tokens` from the response
 *  when available so the ledger reconciles to REAL cost; omit both when
 *  there's no usable usage object (a genuine failure response) and this
 *  falls back to charging the full original reservation — conservative,
 *  assume worst case, never assume free. Always returns the reconciled
 *  values (even if the ledger write itself fails) so the caller's
 *  ai_call_events record stays accurate regardless of ledger-write outcome. */
export async function consumeOpenAiSpend(
  feature: string,
  usagePeriod: string,
  reservedCostUsd: number,
  actualPromptTokens?: number,
  actualCompletionTokens?: number
): Promise<OpenAiConsumeResult> {
  const actualCostUsd =
    actualPromptTokens !== undefined && actualCompletionTokens !== undefined
      ? actualPromptTokens * OPENAI_INPUT_PRICE_PER_TOKEN + actualCompletionTokens * OPENAI_OUTPUT_PRICE_PER_TOKEN
      : reservedCostUsd;
  const tokensUsed = (actualPromptTokens ?? 0) + (actualCompletionTokens ?? 0);

  try {
    const admin = getSupabaseAdminClient();
    if (!isSupabaseAdminConfigured || !admin) return { actualCostUsd, tokensUsed };

    const { error } = await admin.rpc('consume_openai_spend', {
      p_model: OPENAI_MODEL_ID,
      p_feature: feature,
      p_usage_period: usagePeriod,
      p_actual_cost_usd: actualCostUsd,
      p_reserved_cost_usd: reservedCostUsd,
      p_tokens_used: tokensUsed,
    });
    if (error) {
      console.warn('[spend-ledger] consume_openai_spend failed (non-fatal, budget bookkeeping only):', error.message);
    }
  } catch (err) {
    console.warn('[spend-ledger] consumeOpenAiSpend failed (non-fatal, budget bookkeeping only):', err);
  }

  return { actualCostUsd, tokensUsed };
}

/** Call ONLY when OpenAI was never reached at all (a pre-flight DB/network
 *  error before the request left the process). */
export async function refundOpenAiSpend(
  feature: string,
  usagePeriod: string,
  reservedCostUsd: number
): Promise<void> {
  try {
    const admin = getSupabaseAdminClient();
    if (!isSupabaseAdminConfigured || !admin) return;

    const { error } = await admin.rpc('refund_openai_spend', {
      p_model: OPENAI_MODEL_ID,
      p_feature: feature,
      p_usage_period: usagePeriod,
      p_reserved_cost_usd: reservedCostUsd,
    });
    if (error) {
      console.warn('[spend-ledger] refund_openai_spend failed (non-fatal, budget bookkeeping only):', error.message);
    }
  } catch (err) {
    console.warn('[spend-ledger] refundOpenAiSpend failed (non-fatal, budget bookkeeping only):', err);
  }
}
