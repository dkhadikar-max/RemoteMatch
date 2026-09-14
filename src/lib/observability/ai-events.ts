import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

/**
 * AI Phase 1A — shared observability (docs/ai-phase1-implementation-plan.md
 * §4, §2's ai_call_events / migration 022).
 * ==============================================================================
 * New importer of the service-role admin client (`admin.ts` trust-anchor
 * list, docs/ai-phase1-implementation-plan.md §5): `ai_call_events`' RLS has
 * zero client policies by design (service-role only, migration 022) — no
 * `authenticated` session could write to it even with its own token — and
 * every value passed in here is computed server-side from real call
 * outcomes/static config, never from client-supplied input. Same reasoning
 * as `funnel_events`'s existing entry in admin.ts.
 *
 * Fire-and-forget: a failure here must never throw into the caller's actual
 * AI call/response path. Never pass a full prompt, full extracted text, or
 * any secret — `outcome` is the small closed vocabulary the migration's
 * CHECK constraint enforces, not a free-text error message.
 */

export type AiCallOutcome =
  | 'success'
  | 'quota_exceeded_429'
  | 'rate_limited_429'
  | 'service_unavailable_503'
  | 'model_not_found_404'
  | 'spend_cap_hit'
  | 'preflight_error'
  | 'malformed_response'
  | 'other';

export interface AiCallEventInput {
  provider: 'gemini' | 'openai';
  model: string;
  feature: string;
  outcome: AiCallOutcome;
  cacheHit?: boolean;
  latencyMs?: number;
  tokensUsed?: number;
  estimatedCostUsd?: number;
}

export async function recordAiCallEvent(event: AiCallEventInput): Promise<void> {
  try {
    const admin = getSupabaseAdminClient();
    if (!isSupabaseAdminConfigured || !admin) return;

    const { error } = await admin.from('ai_call_events').insert({
      provider: event.provider,
      model: event.model,
      feature: event.feature,
      outcome: event.outcome,
      cache_hit: event.cacheHit ?? null,
      latency_ms: event.latencyMs ?? null,
      tokens_used: event.tokensUsed ?? null,
      estimated_cost_usd: event.estimatedCostUsd ?? null,
    });
    if (error) {
      console.warn('[ai-events] failed to record event (non-fatal):', error.message);
    }
  } catch (err) {
    // Never let observability break the real call it's describing.
    console.warn('[ai-events] failed to record event (non-fatal):', err);
  }
}
