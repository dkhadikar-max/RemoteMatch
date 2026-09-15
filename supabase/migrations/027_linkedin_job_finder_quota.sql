-- LinkedIn Job Finder — Free/Pro search-quota guardrail
-- (C:\Users\dell\.claude\plans\vivid-hatching-kitten.md §22/§27).
-- ==============================================================================
-- Mirrors reserve_proposal()/rollback_proposal_reservation() (migration
-- 003_security_remediation.sql) EXACTLY — same atomic row-locked reservation
-- shape, same UTC daily reset, same allowed/limit/remaining JSONB contract —
-- for the automated vendor-backed search (plan §26 Mode A), which is the
-- one part of this feature with a real, metered per-query vendor cost.
--
-- DDL — per this project's standing convention, Claude writes migration
-- files but does not apply DDL; this file is NOT applied. Apply via the
-- Supabase dashboard SQL editor, then verify with the same
-- information_schema / RPC-existence probe technique used for every prior
-- migration this project (28000 = exists, 42883 = not yet applied).
--
-- Explicitly NOT part of this migration (see the plan's "What this plan
-- does NOT authorize" + Deep's implementation-authorization message):
-- no `linkedin_job_notes` save-to-history table (default behavior is
-- non-persisting per plan §22 step [6]; that table is a future, separately
-- authorized addition if "save to history" is ever built).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS daily_linkedin_searches_count INT NOT NULL DEFAULT 0;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_daily_linkedin_searches_count_nonneg CHECK (daily_linkedin_searches_count >= 0);

-- Free allowance: a small taste of real automated discovery (plan §27),
-- not a blanket unlock — mirrors the existing swipe/proposal quota
-- philosophy rather than inventing a new one.
CREATE OR REPLACE FUNCTION public.reserve_linkedin_search()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (timezone('utc', now()))::date;
  v_row profiles%ROWTYPE;
  v_free_limit CONSTANT INT := 3;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  IF v_row.usage_date <> v_today THEN
    v_row.daily_right_swipes_count := 0;
    v_row.daily_proposals_count := 0;
    v_row.daily_evaluations_count := 0;
    v_row.daily_linkedin_searches_count := 0;
    v_row.usage_date := v_today;
  END IF;

  IF v_row.plan_tier <> 'pro' AND v_row.daily_linkedin_searches_count >= v_free_limit THEN
    UPDATE profiles SET
      usage_date = v_row.usage_date,
      daily_right_swipes_count = v_row.daily_right_swipes_count,
      daily_proposals_count = v_row.daily_proposals_count,
      daily_evaluations_count = v_row.daily_evaluations_count,
      daily_linkedin_searches_count = v_row.daily_linkedin_searches_count
      WHERE id = v_uid;
    RETURN jsonb_build_object(
      'allowed', false, 'error', 'limit_reached', 'reason', 'linkedin_search',
      'limit', v_free_limit, 'remaining', 0, 'planTier', v_row.plan_tier
    );
  END IF;

  v_row.daily_linkedin_searches_count := v_row.daily_linkedin_searches_count + 1;

  UPDATE profiles SET
    usage_date = v_row.usage_date,
    daily_right_swipes_count = v_row.daily_right_swipes_count,
    daily_proposals_count = v_row.daily_proposals_count,
    daily_evaluations_count = v_row.daily_evaluations_count,
    daily_linkedin_searches_count = v_row.daily_linkedin_searches_count,
    updated_at = now()
    WHERE id = v_uid;

  RETURN jsonb_build_object(
    'allowed', true, 'planTier', v_row.plan_tier,
    'limit', v_free_limit,
    'remaining', CASE WHEN v_row.plan_tier = 'pro' THEN NULL
                       ELSE GREATEST(v_free_limit - v_row.daily_linkedin_searches_count, 0) END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_linkedin_search_reservation()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE profiles
    SET daily_linkedin_searches_count = GREATEST(daily_linkedin_searches_count - 1, 0),
        updated_at = now()
    WHERE id = v_uid;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_linkedin_search() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rollback_linkedin_search_reservation() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.reserve_linkedin_search() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_linkedin_search_reservation() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- DOWN (manual, dashboard-only, same convention as every prior migration):
-- DROP FUNCTION IF EXISTS public.reserve_linkedin_search();
-- DROP FUNCTION IF EXISTS public.rollback_linkedin_search_reservation();
-- ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_daily_linkedin_searches_count_nonneg;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS daily_linkedin_searches_count;
