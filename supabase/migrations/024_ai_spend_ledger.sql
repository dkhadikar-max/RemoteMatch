-- ==============================================================================
-- RemoteMatch — 024: OpenAI spend-based ledger (AI Phase 1B)
--
-- docs/ai-phase1b-implementation-plan.md §2/§3/§7. Dollar-denominated
-- sibling of ai_quota_ledger (migration 020) — same reserve/consume/refund
-- shape, same row-locked SECURITY DEFINER pattern already proven correct in
-- production, but tracking spend (USD) instead of a raw request count,
-- since OpenAI's real binding constraint is cost, not a request ceiling
-- (confirmed live: 500 req/min / 500k tokens/min account rate limits,
-- Phase 0b).
--
-- ONE REAL STRUCTURAL DIFFERENCE from the Gemini ledger, load-bearing:
-- Gemini's reservation is always exactly "1 request" — consume/refund never
-- need to know how much was reserved. OpenAI's reservation is a COMPUTED
-- ESTIMATE that varies per call (depends on maxTokens at reservation time),
-- so consume_openai_spend() and refund_openai_spend() both take
-- p_reserved_cost_usd as an explicit parameter — the caller
-- (spend-ledger.ts) must carry the exact value reserve_openai_spend()
-- returned through to whichever of those two it eventually calls. Losing
-- track of this value would let reserved_cost_usd drift from reality.
--
-- THE SAFETY INVARIANT (identical in kind to ai_quota_ledger's, restated
-- here since it's the single most important property of this table): once
-- OpenAI has been reached and returned ANY response — success, 429, 5xx,
-- malformed, anything — the caller MUST call consume_openai_spend(), never
-- refund_openai_spend(). Refund is reserved for a call that never left the
-- process at all (a pre-flight DB/network error before the request was
-- sent).
--
-- Two real operational lessons from Phase 1A's actual rollout, applied
-- here rather than rediscovered: (1) copy-paste truncation into the SQL
-- editor is a real, repeatable failure mode — this file is comparable in
-- size to 020, the file it happened to; scroll to confirm the final DOWN
-- block is visible before running. (2) PostgREST's schema cache does not
-- always pick up new functions immediately — this file ends with its own
-- NOTIFY so that step isn't a separate manual one this time.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS ai_spend_ledger (
  provider            text NOT NULL DEFAULT 'openai',
  model               text NOT NULL,             -- actual billed model id, e.g. 'gpt-5-mini-2025-08-07'
  usage_period        date NOT NULL,              -- UTC day; monthly cap computed via SUM() across
                                                   -- a model/feature's rows within the current month
  feature             text NOT NULL,              -- 'o3_o4_materials' | 'resume_parsing' | 'resume_intelligence'
  estimated_cost_usd  numeric(10,4) NOT NULL DEFAULT 0,  -- reconciled-to-actual, reached-OpenAI calls only
  reserved_cost_usd   numeric(10,4) NOT NULL DEFAULT 0,  -- conservative pre-call estimate, in-flight
  tokens_used         bigint NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, usage_period, feature)
);

COMMENT ON TABLE ai_spend_ledger IS
  'OpenAI spend-based budget ledger (AI Phase 1B). One row per (provider, '
  'model, UTC day, feature). estimated_cost_usd is reconciled from the '
  'REAL response usage object on every reached-provider call, never an '
  'estimate left unadjusted. See reserve/consume/refund RPCs below.';

ALTER TABLE ai_spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_spend_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY "ai_spend_ledger_service_role_all" ON ai_spend_ledger FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON ai_spend_ledger FROM anon, authenticated;
GRANT ALL ON ai_spend_ledger TO service_role;

-- ------------------------------------------------------------------------------
-- reserve_openai_spend — atomic check-then-reserve against BOTH the daily
-- and monthly caps. Row-locks today's row (creating it at 0/0 if absent —
-- same composite-PK-gives-each-day-a-fresh-row property ai_quota_ledger
-- already relies on, migration 020) for the daily check; the monthly check
-- sums already-settled prior days for the same model/feature, which is
-- safe without an explicit lock since only TODAY's row is ever concurrently
-- mutated within a given day.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_openai_spend(
  p_model text,
  p_feature text,
  p_reserved_cost_usd numeric,
  p_daily_cap_usd numeric,
  p_monthly_cap_usd numeric
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today DATE := (timezone('utc', now()))::date;
  v_month_start DATE := date_trunc('month', v_today)::date;
  v_estimated NUMERIC;
  v_reserved NUMERIC;
  v_month_total NUMERIC;
BEGIN
  INSERT INTO ai_spend_ledger (provider, model, usage_period, feature)
    VALUES ('openai', p_model, v_today, p_feature)
    ON CONFLICT (provider, model, usage_period, feature) DO NOTHING;

  SELECT estimated_cost_usd, reserved_cost_usd INTO v_estimated, v_reserved
    FROM ai_spend_ledger
    WHERE provider = 'openai' AND model = p_model AND usage_period = v_today AND feature = p_feature
    FOR UPDATE;

  IF v_estimated + v_reserved + p_reserved_cost_usd > p_daily_cap_usd THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'daily_cap_exceeded', 'usagePeriod', v_today);
  END IF;

  SELECT COALESCE(SUM(estimated_cost_usd + reserved_cost_usd), 0) INTO v_month_total
    FROM ai_spend_ledger
    WHERE provider = 'openai' AND model = p_model AND feature = p_feature
      AND usage_period >= v_month_start AND usage_period <= v_today;

  IF v_month_total + p_reserved_cost_usd > p_monthly_cap_usd THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'monthly_cap_exceeded', 'usagePeriod', v_today);
  END IF;

  UPDATE ai_spend_ledger
    SET reserved_cost_usd = reserved_cost_usd + p_reserved_cost_usd, updated_at = now()
    WHERE provider = 'openai' AND model = p_model AND usage_period = v_today AND feature = p_feature;

  RETURN jsonb_build_object('allowed', true, 'usagePeriod', v_today);
END;
$$;

-- ------------------------------------------------------------------------------
-- consume_openai_spend — reconciles to REAL cost (computed by the caller
-- from the response's own usage object) and releases the ORIGINAL
-- reservation amount. Call after ANY response from OpenAI (success, 429,
-- 5xx, malformed, anything) — never conditional on success. If the caller
-- has no usable usage object (a genuine failure response), it passes the
-- full original reservation as p_actual_cost_usd — conservative, assume
-- worst case, never assume free.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_openai_spend(
  p_model text,
  p_feature text,
  p_usage_period date,
  p_actual_cost_usd numeric,
  p_reserved_cost_usd numeric,
  p_tokens_used bigint
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE ai_spend_ledger
    SET estimated_cost_usd = estimated_cost_usd + p_actual_cost_usd,
        reserved_cost_usd = GREATEST(reserved_cost_usd - p_reserved_cost_usd, 0),
        tokens_used = tokens_used + p_tokens_used,
        updated_at = now()
    WHERE provider = 'openai' AND model = p_model AND usage_period = p_usage_period AND feature = p_feature;
END;
$$;

-- ------------------------------------------------------------------------------
-- refund_openai_spend — releases a reservation WITHOUT touching
-- estimated_cost_usd. Call ONLY when OpenAI was never reached at all (a
-- pre-flight DB/network error before the request was sent). Calling this
-- after any real provider response is a correctness bug per this ledger's
-- whole design (docs/ai-phase1b-implementation-plan.md §2).
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_openai_spend(
  p_model text,
  p_feature text,
  p_usage_period date,
  p_reserved_cost_usd numeric
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE ai_spend_ledger
    SET reserved_cost_usd = GREATEST(reserved_cost_usd - p_reserved_cost_usd, 0), updated_at = now()
    WHERE provider = 'openai' AND model = p_model AND usage_period = p_usage_period AND feature = p_feature;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_openai_spend(text, text, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_openai_spend(text, text, date, numeric, numeric, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_openai_spend(text, text, date, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_openai_spend(text, text, numeric, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_openai_spend(text, text, date, numeric, numeric, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_openai_spend(text, text, date, numeric) TO service_role;

-- Applied proactively this time (Phase 1A lesson §6.2) rather than as a
-- reactive fix after a PGRST202 — see docs/ai-phase1b-implementation-plan.md §6.
NOTIFY pgrst, 'reload schema';

-- ==============================================================================
-- DOWN:
--   DROP FUNCTION IF EXISTS public.reserve_openai_spend(text, text, numeric, numeric, numeric);
--   DROP FUNCTION IF EXISTS public.consume_openai_spend(text, text, date, numeric, numeric, bigint);
--   DROP FUNCTION IF EXISTS public.refund_openai_spend(text, text, date, numeric);
--   DROP TABLE IF EXISTS ai_spend_ledger;
--   -- Safe at any point — purely additive bookkeeping, referenced by no
--   -- other table via foreign key. If rolled back while code still calls
--   -- these, spend-ledger.ts's caller (materials.ts/resume.ts/
--   -- resume-intelligence.ts) treats a reservation-call error as "not
--   -- allowed" -> falls to the existing deterministic template, matching
--   -- this project's established fail-safe convention.
-- ==============================================================================
