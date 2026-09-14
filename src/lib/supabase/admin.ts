import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// NOTE: intentionally does not depend on the `server-only` package (not an
// existing project dependency) to avoid a build-time addition outside this
// remediation's scope. Enforcement instead relies on: this module is only
// ever imported from route handlers (grep for importers before adding a new
// one), and SUPABASE_SERVICE_ROLE_KEY is never exposed via NEXT_PUBLIC_*.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseAdminConfigured = Boolean(
  supabaseUrl && serviceRoleKey && supabaseUrl.startsWith('https://') && serviceRoleKey.length > 20
);

let adminClient: SupabaseClient | null = null;

/**
 * Service-role Supabase client. Bypasses Row Level Security entirely —
 * NEVER import this from a Client Component, and never forward its key to
 * the browser. Restricted to code paths that are themselves already
 * trust-anchored by something other than the caller's own session:
 *   - the Stripe webhook (trust anchor: the verified Stripe signature)
 *   - the Stripe verify route's real-Stripe branch, to write plan_tier after
 *     Stripe itself has confirmed payment (trust anchor: Stripe's API
 *     response), which the authenticated user's own RLS-limited session
 *     cannot do by design (see supabase/migrations/003_security_remediation.sql).
 *   - `getOpportunitiesByCanonicalIdsAnyStatus()` (src/lib/ingestion/catalog-read.ts),
 *     used only by GET /api/applications/opportunities (Tracker Opportunity
 *     Resolution), to read an opportunity regardless of its `status` (a
 *     since-expired job a user genuinely applied to). Trust anchor: the
 *     caller's own RLS-scoped `applications` query has already proven, in
 *     the same request, that every id passed in belongs to THAT user's own
 *     applications — this function is never given a client-supplied id.
 *   - `recordFunnelEvent()` (src/lib/funnel/events.ts), used only by
 *     POST /api/funnel/event (Funnel Instrumentation). Different shape of
 *     justification from the two above: `funnel_events` has RLS enabled
 *     with ZERO client policies by design (migration 019) — no `anon` or
 *     `authenticated` role can read or write it at all, ever. The admin
 *     client here isn't bypassing a policy a real session could otherwise
 *     satisfy; it's the intended sole write path behind a route that has
 *     already validated event_type/fields against a fixed allow-list and
 *     derived profile_id from the caller's own session (never the body).
 *   - `src/lib/ingestion/employer-registry.ts` (Supply Discovery gate C3),
 *     used only by the ATS provider classes (Greenhouse/Lever/Ashby) inside
 *     the same ingestion pipeline `catalog-sync.ts` itself already writes
 *     the `opportunities` table through (that pre-existing usage predates
 *     this comment). Trust anchor: this code path is only ever reached from
 *     the secret-gated `/api/opportunities/sync` route
 *     (verifyIngestionSecret()) — never from a user-facing request — and it
 *     only reads `allowlist_employers`/writes reliability counters on
 *     `supply_sources`, both service-role-only tables with zero client
 *     policies (migration 012).
 *   - `src/lib/ai/quota-ledger.ts`, `src/lib/ai/gemini-cache.ts`,
 *     `src/lib/observability/ai-events.ts` (AI Phase 1A,
 *     docs/ai-phase1-implementation-plan.md §5), used only by
 *     `career-page-extraction.ts`'s C5 extraction call site (itself only
 *     ever reached from the same secret-gated career-page sync path as
 *     `employer-registry.ts` above). Same shape of justification as
 *     `funnel_events`: `ai_quota_ledger` / `ai_quota_employer_ledger` /
 *     `gemini_extraction_cache` / `ai_call_events` all have RLS enabled
 *     with ZERO client policies by design (migrations 020-023) — no `anon`
 *     or `authenticated` role can read or write any of them, ever — and
 *     every value written through these three modules (feature name,
 *     model id, employer id, content hash, call outcome) is computed
 *     server-side from static config or the trusted `allowlist_employers`
 *     registry, never from client-supplied input.
 *   - `src/lib/ai/spend-ledger.ts` (AI Phase 1B,
 *     docs/ai-phase1b-implementation-plan.md), used by `materials.ts`
 *     (O3/O4), `resume.ts` and `resume-intelligence.ts` (O5, still
 *     structurally unreachable — see those files' own headers). UNLIKE the
 *     C3/C5 entries above, these ARE user-facing call sites (reached from
 *     `/api/opportunities/swipe`'s proposal-generation flow and
 *     onboarding), so the trust anchor here is the same shape as
 *     `funnel_events`'s, not the secret-gated-route shape: `ai_spend_ledger`
 *     has RLS enabled with ZERO client policies (migration 024) — no
 *     `anon` or `authenticated` role can read or write it, ever — and
 *     every value written (feature name, model id, the reserved/actual
 *     cost estimate) is computed server-side from static `openai-config.ts`
 *     constants or a real OpenAI response's own `usage` object, never from
 *     anything the calling user supplies.
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  if (!isSupabaseAdminConfigured) return null;
  if (!adminClient) {
    adminClient = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}
