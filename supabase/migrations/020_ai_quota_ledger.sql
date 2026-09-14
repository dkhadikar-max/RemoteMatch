-- ==============================================================================
-- RemoteMatch — 020: Gemini request-count quota ledger (AI Phase 1A)
--
-- docs/ai-phase1-implementation-plan.md §2/§3. Global, feature/model/day-
-- scoped counter for real Gemini `generateContent` calls — enforces the
-- locked policy (remotematch-ai-cost-policy memory, §11.1/§11.4 of the
-- Phase 1A spec): C5 gets 100% of the currently-available Gemini free-tier
-- request budget, sourced from real-verified evidence, never a guessed
-- permanent constant. `p_daily_limit` is always passed in by the caller
-- (from src/lib/ai/gemini-config.ts's GEMINI_DAILY_REQUEST_LIMIT) — this
-- migration hardcodes no ceiling number at all, so a config change stays a
-- one-line TypeScript edit, never a migration.
--
-- Row-per-UTC-day-by-construction: `usage_date` is part of the primary key,
-- so a new day's row simply doesn't exist yet (INSERT ... ON CONFLICT DO
-- NOTHING creates it at 0/0 the first time it's touched) — there is no
-- "lazy reset a stale row" step to write, unlike profiles.usage_date
-- (migration 003's reserve_proposal()/reserve_right_swipe()), which have to
-- roll a single ever-existing row forward in place. Simpler by construction,
-- not by omission.
--
-- The provider-consumption/internal-reservation distinction (the plan's own
-- most safety-critical invariant, approved-plan §12) is enforced by which
-- of the three functions below a caller invokes, not by a comment: any
-- outcome where Google was actually reached (success, 429, 503, 404,
-- anything) MUST go through consume_gemini_request(), which moves
-- reserved -> used and never gives it back. refund_gemini_reservation() is
-- the ONLY path that returns a reservation, and it must only ever be
-- called when Google was never reached at all (a pre-flight DB/network
-- error before the fetch left the process).
-- ==============================================================================

CREATE TABLE IF NOT EXISTS ai_quota_ledger (
  provider           text NOT NULL DEFAULT 'gemini',
  model              text NOT NULL,             -- the actual billed model id, e.g. 'gemini-3.5-flash-lite'
  usage_date         date NOT NULL,              -- UTC
  feature            text NOT NULL,              -- 'c5_extraction' today — the only feature drawing
                                                   -- from this budget; a future Gemini workload needs
                                                   -- its own explicit allocation decision, never a
                                                   -- silent share of C5's rows (locked decision §11.4)
  requests_used      int NOT NULL DEFAULT 0,     -- reached Google, ANY outcome — never decremented
  requests_reserved  int NOT NULL DEFAULT 0,     -- in-flight, decremented on consume or refund
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, usage_date, feature)
);

COMMENT ON TABLE ai_quota_ledger IS
  'Gemini request-count budget ledger (AI Phase 1A). One row per (provider, '
  'model, UTC day, feature). requests_used is reached-provider-any-outcome, '
  'never decremented — see reserve/consume/refund RPCs below.';

ALTER TABLE ai_quota_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_quota_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY "ai_quota_ledger_service_role_all" ON ai_quota_ledger FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON ai_quota_ledger FROM anon, authenticated;
GRANT ALL ON ai_quota_ledger TO service_role;

-- ------------------------------------------------------------------------------
-- reserve_gemini_request — atomic check-then-increment on requests_reserved.
-- Ensures today's row exists (at 0/0) then row-locks it via FOR UPDATE,
-- mirroring reserve_proposal()'s own atomicity guarantee (migration 003)
-- adapted to a global ledger row instead of a per-user profiles row.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_gemini_request(
  p_model text,
  p_feature text,
  p_daily_limit int
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := (timezone('utc', now()))::date;
  v_used INT;
  v_reserved INT;
BEGIN
  INSERT INTO ai_quota_ledger (provider, model, usage_date, feature)
    VALUES ('gemini', p_model, v_today, p_feature)
    ON CONFLICT (provider, model, usage_date, feature) DO NOTHING;

  SELECT requests_used, requests_reserved INTO v_used, v_reserved
    FROM ai_quota_ledger
    WHERE provider = 'gemini' AND model = p_model AND usage_date = v_today AND feature = p_feature
    FOR UPDATE;

  IF v_used + v_reserved >= p_daily_limit THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'global_quota_exhausted',
      'usageDate', v_today, 'remaining', 0
    );
  END IF;

  UPDATE ai_quota_ledger
    SET requests_reserved = requests_reserved + 1, updated_at = now()
    WHERE provider = 'gemini' AND model = p_model AND usage_date = v_today AND feature = p_feature;

  RETURN jsonb_build_object(
    'allowed', true, 'usageDate', v_today,
    'remaining', GREATEST(p_daily_limit - (v_used + v_reserved + 1), 0)
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- consume_gemini_request — moves reserved -> used. Call after ANY response
-- from Google (success, 429, 503, 404, malformed JSON, anything) — never
-- conditional on success. This is the ONLY function that increments
-- requests_used, and it never decrements it.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_gemini_request(
  p_model text,
  p_feature text,
  p_usage_date date
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE ai_quota_ledger
    SET requests_used = requests_used + 1,
        requests_reserved = GREATEST(requests_reserved - 1, 0),
        updated_at = now()
    WHERE provider = 'gemini' AND model = p_model AND usage_date = p_usage_date AND feature = p_feature;
END;
$$;

-- ------------------------------------------------------------------------------
-- refund_gemini_reservation — releases a reservation WITHOUT touching
-- requests_used. Call ONLY when Google was never reached at all (a
-- pre-flight DB/network error before the fetch left the process). Calling
-- this after any real provider response — even a failure response — is a
-- correctness bug per this ledger's whole design (approved-plan §12).
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_gemini_reservation(
  p_model text,
  p_feature text,
  p_usage_date date
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE ai_quota_ledger
    SET requests_reserved = GREATEST(requests_reserved - 1, 0), updated_at = now()
    WHERE provider = 'gemini' AND model = p_model AND usage_date = p_usage_date AND feature = p_feature;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_gemini_request(text, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_gemini_request(text, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_gemini_reservation(text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_gemini_request(text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_gemini_request(text, text, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_gemini_reservation(text, text, date) TO service_role;

-- ==============================================================================
-- DOWN:
--   DROP FUNCTION IF EXISTS public.reserve_gemini_request(text, text, int);
--   DROP FUNCTION IF EXISTS public.consume_gemini_request(text, text, date);
--   DROP FUNCTION IF EXISTS public.refund_gemini_reservation(text, text, date);
--   DROP TABLE IF EXISTS ai_quota_ledger;
--   -- Safe at any point — purely additive bookkeeping, referenced by no
--   -- other table via foreign key, and career-page-extraction.ts's caller
--   -- (career-page.ts) degrades to "reservation call errors -> treated as
--   -- not allowed -> null extraction" if these are ever rolled back while
--   -- code still calls them, matching this project's existing fail-safe
--   -- convention rather than crashing the sync.
-- ==============================================================================
