-- ==============================================================================
-- RemoteMatch — 022: AI call observability (AI Phase 1A)
--
-- docs/ai-phase1-implementation-plan.md §2/§4, locked decision §11.6.
-- Minimal, shared-shape event log for AI provider calls — NOT a full
-- APM/Sentry integration (approved-plan §26's explicit non-goal), just
-- enough structured signal to see real quota/spend consumption per
-- provider, since Gemini (request ceiling) and OpenAI (spend ceiling) have
-- fundamentally different constraint shapes and need to be watched
-- differently. Phase 1A only ever writes provider='gemini' rows; the
-- `estimated_cost_usd` column exists now so Phase 1B doesn't need its own
-- migration later, but stays NULL until OpenAI routing exists.
--
-- Fire-and-forget from the calling code's perspective: a failure to write
-- an event must never block or fail the actual AI call/response it's
-- describing (src/lib/observability/ai-events.ts's contract).
--
-- Never logs: API keys/secrets, complete prompts, complete extracted job
-- text. `outcome` is a small closed vocabulary, not free-text error
-- messages, deliberately to avoid this table ever becoming a place raw
-- content leaks into.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS ai_call_events (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider             text NOT NULL,
  model                text NOT NULL,
  feature              text NOT NULL,
  outcome              text NOT NULL
    CHECK (outcome IN (
      'success', 'quota_exceeded_429', 'rate_limited_429', 'service_unavailable_503',
      'model_not_found_404', 'spend_cap_hit', 'preflight_error', 'malformed_response', 'other'
    )),
  cache_hit            boolean,          -- null when not applicable (no cache dimension yet for
                                          -- a provider/feature, e.g. any future OpenAI call)
  latency_ms           int,
  tokens_used          bigint,
  estimated_cost_usd   numeric(10,4),    -- null for Gemini (free tier, no cost dimension) — reserved
                                          -- for Phase 1B's OpenAI rows
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_call_events_provider_feature_created_idx
  ON ai_call_events (provider, feature, created_at DESC);

COMMENT ON TABLE ai_call_events IS
  'Shared, minimal AI-call observability log (both providers). Fire-and-'
  'forget write; never blocks the real call it describes. No secrets, no '
  'full prompts/content — outcome is a closed vocabulary, not free text.';

ALTER TABLE ai_call_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_call_events FORCE ROW LEVEL SECURITY;

CREATE POLICY "ai_call_events_service_role_all" ON ai_call_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON ai_call_events FROM anon, authenticated;
GRANT ALL ON ai_call_events TO service_role;

-- ==============================================================================
-- DOWN:
--   DROP TABLE IF EXISTS ai_call_events;
--   -- Safe at any point — pure observability, nothing reads it back at
--   -- request time (recordAiCallEvent() is write-only from the app's
--   -- perspective), referenced by no other table.
-- ==============================================================================
