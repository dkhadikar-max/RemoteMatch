import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import { GEMINI_MODEL_ID, GEMINI_DAILY_REQUEST_LIMIT, GEMINI_PER_EMPLOYER_DAILY_SOFT_CAP_FRACTION } from './gemini-config';

/**
 * AI Phase 1A — Gemini request-count ledger + per-employer soft cap
 * (docs/ai-phase1-implementation-plan.md §3, §4, §5).
 * ==============================================================================
 * New importer of the service-role admin client (`admin.ts` trust-anchor
 * list): `ai_quota_ledger`/`ai_quota_employer_ledger`'s RLS has zero client
 * policies (service-role only, migrations 020/021) and every value written
 * here (feature, model, employer id) is server-computed from static config
 * or the trusted `allowlist_employers` registry, never client input.
 *
 * THE SAFETY INVARIANT (approved-plan §12, restated as load-bearing code,
 * not just a comment): once Gemini has been reached and returned ANY
 * response — success, 429, 503, 404, malformed JSON, anything — the caller
 * MUST call consumeGeminiRequest(), never refundGeminiReservation().
 * refundGeminiReservation() is the ONLY function that returns a
 * reservation, and it must be called ONLY when Gemini was never reached at
 * all (a pre-flight DB/network error before the fetch left the process).
 * See career-page-extraction.ts's call site for the enforced shape.
 *
 * The per-employer soft cap is deliberately NOT a second reserve/consume/
 * refund cycle (docs/ai-phase1-implementation-plan.md §3): it's a
 * lightweight pre-check read before the real (global) reservation is even
 * attempted, plus a lockstep increment at consume time. A race on the
 * per-employer check can only ever under-count by one request, never
 * over-spend the real global budget — that protection stays entirely with
 * the row-locked reserve_gemini_request() RPC. A soft-cap CHECK failure
 * (query error) fails OPEN (treated as "not capped yet") — the real budget
 * protection is unaffected either way.
 */

const FEATURE = 'c5_extraction';
const PROVIDER = 'gemini';

export interface GeminiReservationResult {
  allowed: boolean;
  reason?: 'global_quota_exhausted' | 'employer_soft_cap' | 'not_configured';
  /** UTC date string (YYYY-MM-DD) the reservation was made against — pass
   *  this back to consumeGeminiRequest()/refundGeminiReservation() so a
   *  reservation can never accidentally resolve against the wrong day if a
   *  call happens to straddle UTC midnight. */
  usageDate?: string;
}

async function getEmployerUsageToday(employerId: string, usageDate: string): Promise<number> {
  try {
    const admin = getSupabaseAdminClient();
    if (!isSupabaseAdminConfigured || !admin) return 0;

    const { data, error } = await admin
      .from('ai_quota_employer_ledger')
      .select('requests_used')
      .eq('provider', PROVIDER)
      .eq('employer_id', employerId)
      .eq('usage_date', usageDate)
      .maybeSingle();

    if (error || !data) return 0; // no row yet = 0 used today; a real query error fails open
    return data.requests_used ?? 0;
  } catch (err) {
    console.warn('[quota-ledger] employer soft-cap read failed, failing open (non-fatal):', err);
    return 0;
  }
}

export async function reserveGeminiRequest(employerId: string): Promise<GeminiReservationResult> {
  // Hardening fix (2026-09-14, real finding from Phase 1B live verification):
  // getSupabaseAdminClient() can throw SYNCHRONOUSLY (observed: @supabase/
  // supabase-js's realtime client constructor requires a WebSocket ctor on
  // Node < 22, absent in a bare script without a polyfill — Next.js's own
  // server runtime doesn't hit this, confirmed by this function's real
  // production use, but the call site itself must not assume that). Every
  // other function in this file already wraps its own getSupabaseAdminClient()
  // call in try/catch; this one didn't, so an uncaught throw here would
  // propagate into career-page-extraction.ts instead of failing closed —
  // a real mismatch against this module's own stated "fail-safe" contract.
  // See test/ai-ledger-failsafe-suite.ts for the regression coverage.
  let admin;
  try {
    admin = getSupabaseAdminClient();
  } catch (err) {
    console.warn('[quota-ledger] getSupabaseAdminClient() threw, failing closed:', err);
    return { allowed: false, reason: 'not_configured' };
  }
  if (!isSupabaseAdminConfigured || !admin) {
    return { allowed: false, reason: 'not_configured' };
  }

  const todayUtc = new Date().toISOString().slice(0, 10);
  const softCap = Math.max(1, Math.floor(GEMINI_DAILY_REQUEST_LIMIT * GEMINI_PER_EMPLOYER_DAILY_SOFT_CAP_FRACTION));
  const employerUsedToday = await getEmployerUsageToday(employerId, todayUtc);
  if (employerUsedToday >= softCap) {
    return { allowed: false, reason: 'employer_soft_cap', usageDate: todayUtc };
  }

  const { data, error } = await admin.rpc('reserve_gemini_request', {
    p_model: GEMINI_MODEL_ID,
    p_feature: FEATURE,
    p_daily_limit: GEMINI_DAILY_REQUEST_LIMIT,
  });

  if (error || !data) {
    console.warn('[quota-ledger] reserve_gemini_request failed, treating as not allowed:', error?.message);
    return { allowed: false, reason: 'global_quota_exhausted' };
  }

  return {
    allowed: Boolean(data.allowed),
    reason: data.allowed ? undefined : 'global_quota_exhausted',
    usageDate: data.usageDate ?? todayUtc,
  };
}

export async function consumeGeminiRequest(employerId: string, usageDate: string): Promise<void> {
  try {
    const admin = getSupabaseAdminClient();
    if (!isSupabaseAdminConfigured || !admin) return;

    const { error } = await admin.rpc('consume_gemini_request', {
      p_model: GEMINI_MODEL_ID,
      p_feature: FEATURE,
      p_usage_date: usageDate,
    });
    if (error) console.warn('[quota-ledger] consume_gemini_request failed (non-fatal, budget bookkeeping only):', error.message);

    // Lockstep increment on the per-employer soft-cap counter — same "any
    // outcome counts" rule as the global ledger's requests_used, same call
    // site. Never done at reserve time, only here, so refund never needs
    // to touch it (it was never incremented for a reservation that's being
    // refunded).
    //
    // Read-then-upsert, not a single atomic UPDATE ... SET x = x + 1 — the
    // Supabase JS client's upsert() can only send literal values via
    // PostgREST, not a SQL increment expression, and per the spec this
    // counter is explicitly advisory (docs/ai-phase1-implementation-plan.md
    // §3): a race here can under-count by at most one request under real
    // concurrent load, but can never over-spend the real global budget,
    // which stays entirely protected by reserve_gemini_request()'s
    // row-locked RPC above. Deliberately not a second RPC for a soft check.
    const currentEmployerUsed = await getEmployerUsageToday(employerId, usageDate);
    const { error: employerError } = await admin.from('ai_quota_employer_ledger').upsert(
      {
        provider: PROVIDER,
        employer_id: employerId,
        usage_date: usageDate,
        requests_used: currentEmployerUsed + 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'provider,employer_id,usage_date' }
    );
    if (employerError) {
      console.warn('[quota-ledger] employer soft-cap increment failed (non-fatal):', employerError.message);
    }
  } catch (err) {
    console.warn('[quota-ledger] consumeGeminiRequest failed (non-fatal, budget bookkeeping only):', err);
  }
}

export async function refundGeminiReservation(usageDate: string): Promise<void> {
  try {
    const admin = getSupabaseAdminClient();
    if (!isSupabaseAdminConfigured || !admin) return;

    const { error } = await admin.rpc('refund_gemini_reservation', {
      p_model: GEMINI_MODEL_ID,
      p_feature: FEATURE,
      p_usage_date: usageDate,
    });
    if (error) console.warn('[quota-ledger] refund_gemini_reservation failed (non-fatal, budget bookkeeping only):', error.message);
  } catch (err) {
    console.warn('[quota-ledger] refundGeminiReservation failed (non-fatal, budget bookkeeping only):', err);
  }
}
