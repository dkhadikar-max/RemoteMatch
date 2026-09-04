-- ==============================================================================
-- RemoteMatch — P0 SECURITY REMEDIATION
-- Wires the (previously unused) schema to real Supabase Auth identity and adds
-- the atomic, server-authoritative quota/entitlement/rewind mechanism.
--
-- Scope (intentionally limited to the security-critical surface):
--   - profiles.plan_tier / quota counters / usage_date / stripe_* fields
--   - the swipe/pass/rewind decision log (quota-gated mutation)
--   - the "interested" application row created by a right-swipe
--
-- Explicitly OUT of scope (unchanged, tracked as a follow-up in the report):
--   - profile content (skills/experience/resume/intent/location)
--   - application status progression / notes / "did you apply" feedback
--   - the `opportunities` / `matches` / `generated_materials` tables
-- Do not add tests/behavior for those here; they are not part of this pass.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. LINK PROFILES TO REAL AUTH IDENTITY
-- ------------------------------------------------------------------------------

-- Anonymous Supabase Auth users have no email; the column must allow that.
ALTER TABLE profiles ALTER COLUMN email DROP NOT NULL;

-- profiles.id must be the authenticated user's id, never a client-chosen value.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_fkey'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Quota/entitlement columns the current app model actually needs.
-- (001_initial_schema.sql only had the old, superseded `daily_evaluations_count`
--  model; it never had per-quota counters or a UTC usage_date.)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS daily_right_swipes_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_proposals_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_date DATE NOT NULL DEFAULT (timezone('utc', now()))::date,
  ADD COLUMN IF NOT EXISTS stripe_subscription_status TEXT;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_daily_right_swipes_count_nonneg CHECK (daily_right_swipes_count >= 0),
  ADD CONSTRAINT profiles_daily_proposals_count_nonneg CHECK (daily_proposals_count >= 0);

-- Auto-provision a free-tier profile row the instant a user (incl. anonymous
-- sign-in) is created, so the app never has to "get or create" one itself.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, plan_tier, usage_date)
  VALUES (NEW.id, NEW.email, NULL, 'free', (timezone('utc', now()))::date)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ------------------------------------------------------------------------------
-- 2. REPURPOSE `swipes` INTO THE APPEND-ONLY DECISION LOG
--    (table existed but was never written to by any code path)
-- ------------------------------------------------------------------------------

ALTER TABLE swipes DROP CONSTRAINT IF EXISTS uq_profile_opportunity_swipe;
ALTER TABLE swipes DROP CONSTRAINT IF EXISTS swipes_action_check;
ALTER TABLE swipes DROP CONSTRAINT IF EXISTS swipes_opportunity_id_fkey;

-- Opportunity ids in this app are provider-issued strings (curated/remotive/
-- arbeitnow/jobicy), not rows in the (separately unpopulated) `opportunities`
-- table — do not force a FK that doesn't match how jobs are actually sourced.
ALTER TABLE swipes ALTER COLUMN opportunity_id TYPE TEXT USING opportunity_id::text;

ALTER TABLE swipes
  ADD CONSTRAINT swipes_action_check CHECK (action IN ('interested', 'passed', 'rewind')),
  ADD COLUMN IF NOT EXISTS decision_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS rewound_decision_id UUID REFERENCES swipes(id);

CREATE INDEX IF NOT EXISTS idx_swipes_profile_created_at ON swipes(profile_id, created_at DESC);

-- `applications` likewise keys off the provider's string opportunity id.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_opportunity_id_fkey;
ALTER TABLE applications ALTER COLUMN opportunity_id TYPE TEXT USING opportunity_id::text;

-- ------------------------------------------------------------------------------
-- 3. LOCK DOWN DIRECT CLIENT WRITES TO ENTITLEMENT-BEARING TABLES
--    RLS proves ownership, not business rules — a client that owns a row can
--    still PATCH it directly over PostgREST unless we also revoke the grant.
--    All quota/plan/decision mutations must go through the SECURITY DEFINER
--    functions below, which run with elevated privilege independent of these
--    grants.
-- ------------------------------------------------------------------------------

REVOKE UPDATE, INSERT, DELETE ON profiles FROM authenticated, anon;
GRANT SELECT ON profiles TO authenticated, anon;
-- Only ever-safe, non-entitlement fields may be edited directly by the owner.
GRANT UPDATE (full_name, headline, avatar_url, raw_resume_text, resume_file_url)
  ON profiles TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON swipes FROM authenticated, anon;
GRANT SELECT ON swipes TO authenticated;

-- Applications may still be created (as a byproduct of a right-swipe, via the
-- functions below) and their non-quota status/notes may still be edited
-- directly by the owner for the existing tracker feature; only direct INSERT
-- is blocked so a client cannot manufacture "interested" state for free.
REVOKE INSERT ON applications FROM authenticated, anon;
GRANT UPDATE (status, notes, applied_at, updated_at) ON applications TO authenticated;

-- Drop the old RLS policies that granted blanket owner INSERT/UPDATE/DELETE —
-- the column-level GRANTs above are now the actual boundary; keep SELECT-own.
DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
DROP POLICY IF EXISTS "profiles_delete_own" ON profiles;
CREATE POLICY "profiles_update_own_safe_columns"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "swipes_insert_own" ON swipes;
DROP POLICY IF EXISTS "swipes_update_own" ON swipes;
DROP POLICY IF EXISTS "swipes_delete_own" ON swipes;

DROP POLICY IF EXISTS "applications_insert_own" ON applications;
CREATE POLICY "applications_update_own_safe_columns"
  ON applications FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

-- ------------------------------------------------------------------------------
-- 4. ATOMIC RIGHT-SWIPE QUOTA (reserve) + FINALIZE (persist decision + app)
--    Split in two because the expensive step (AI application-kit generation)
--    happens in Next.js between them and cannot be part of one SQL statement.
--    Ordering guarantee: reserve_right_swipe() is the ONLY gate; nothing else
--    (decision row, application row, AI call) happens unless it returns
--    allowed = true, and it either fully succeeds or changes nothing.
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reserve_right_swipe()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (timezone('utc', now()))::date;
  v_row profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  -- Row lock: serializes every concurrent quota/rewind operation for this
  -- user through this one row, which is what makes the check-then-increment
  -- below atomic instead of a TOCTOU race.
  SELECT * INTO v_row FROM profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  IF v_row.usage_date <> v_today THEN
    v_row.daily_right_swipes_count := 0;
    v_row.daily_proposals_count := 0;
    v_row.daily_evaluations_count := 0;
    v_row.usage_date := v_today;
  END IF;

  IF v_row.plan_tier <> 'pro' AND v_row.daily_right_swipes_count >= 15 THEN
    UPDATE profiles SET
      usage_date = v_row.usage_date,
      daily_right_swipes_count = v_row.daily_right_swipes_count,
      daily_proposals_count = v_row.daily_proposals_count,
      daily_evaluations_count = v_row.daily_evaluations_count
      WHERE id = v_uid;
    RETURN jsonb_build_object(
      'allowed', false, 'error', 'limit_reached', 'reason', 'swipes',
      'limit', 15, 'remaining', 0, 'planTier', v_row.plan_tier
    );
  END IF;

  v_row.daily_right_swipes_count := v_row.daily_right_swipes_count + 1;
  v_row.daily_evaluations_count := v_row.daily_evaluations_count + 1;

  UPDATE profiles SET
    usage_date = v_row.usage_date,
    daily_right_swipes_count = v_row.daily_right_swipes_count,
    daily_proposals_count = v_row.daily_proposals_count,
    daily_evaluations_count = v_row.daily_evaluations_count,
    updated_at = now()
    WHERE id = v_uid;

  RETURN jsonb_build_object(
    'allowed', true, 'planTier', v_row.plan_tier,
    'limit', 15,
    'remaining', CASE WHEN v_row.plan_tier = 'pro' THEN NULL
                       ELSE GREATEST(15 - v_row.daily_right_swipes_count, 0) END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_interested_swipe(
  p_opportunity_id TEXT,
  p_decision_snapshot JSONB
) RETURNS JSONB
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
  IF p_opportunity_id IS NULL OR length(p_opportunity_id) = 0 THEN
    RAISE EXCEPTION 'invalid_opportunity_id';
  END IF;

  INSERT INTO swipes (profile_id, opportunity_id, action, decision_snapshot)
  VALUES (v_uid, p_opportunity_id, 'interested', p_decision_snapshot);

  INSERT INTO applications (profile_id, opportunity_id, status)
  VALUES (v_uid, p_opportunity_id, 'interested')
  ON CONFLICT (profile_id, opportunity_id) DO UPDATE
    SET updated_at = now();

  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_pass(p_opportunity_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (timezone('utc', now()))::date;
  v_row profiles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_opportunity_id IS NULL OR length(p_opportunity_id) = 0 THEN
    RAISE EXCEPTION 'invalid_opportunity_id';
  END IF;

  -- Left swipes are unlimited, but usage_date still needs the same UTC
  -- rollover applied, and evaluations are still counted internally.
  SELECT * INTO v_row FROM profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  IF v_row.usage_date <> v_today THEN
    v_row.daily_right_swipes_count := 0;
    v_row.daily_proposals_count := 0;
    v_row.daily_evaluations_count := 0;
    v_row.usage_date := v_today;
  END IF;
  v_row.daily_evaluations_count := v_row.daily_evaluations_count + 1;

  UPDATE profiles SET
    usage_date = v_row.usage_date,
    daily_right_swipes_count = v_row.daily_right_swipes_count,
    daily_proposals_count = v_row.daily_proposals_count,
    daily_evaluations_count = v_row.daily_evaluations_count,
    updated_at = now()
    WHERE id = v_uid;

  INSERT INTO swipes (profile_id, opportunity_id, action)
  VALUES (v_uid, p_opportunity_id, 'passed');

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ------------------------------------------------------------------------------
-- 5. ATOMIC PROPOSAL QUOTA — reserve BEFORE generation, explicit rollback on
--    generation failure (per remediation spec; swipe path intentionally does
--    NOT roll back — see report).
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reserve_proposal()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (timezone('utc', now()))::date;
  v_row profiles%ROWTYPE;
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
    v_row.usage_date := v_today;
  END IF;

  IF v_row.plan_tier <> 'pro' AND v_row.daily_proposals_count >= 5 THEN
    UPDATE profiles SET
      usage_date = v_row.usage_date,
      daily_right_swipes_count = v_row.daily_right_swipes_count,
      daily_proposals_count = v_row.daily_proposals_count,
      daily_evaluations_count = v_row.daily_evaluations_count
      WHERE id = v_uid;
    RETURN jsonb_build_object(
      'allowed', false, 'error', 'limit_reached', 'reason', 'proposals',
      'limit', 5, 'remaining', 0, 'planTier', v_row.plan_tier
    );
  END IF;

  v_row.daily_proposals_count := v_row.daily_proposals_count + 1;

  UPDATE profiles SET
    usage_date = v_row.usage_date,
    daily_right_swipes_count = v_row.daily_right_swipes_count,
    daily_proposals_count = v_row.daily_proposals_count,
    daily_evaluations_count = v_row.daily_evaluations_count,
    updated_at = now()
    WHERE id = v_uid;

  RETURN jsonb_build_object(
    'allowed', true, 'planTier', v_row.plan_tier,
    'limit', 5,
    'remaining', CASE WHEN v_row.plan_tier = 'pro' THEN NULL
                       ELSE GREATEST(5 - v_row.daily_proposals_count, 0) END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_proposal_reservation()
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
    SET daily_proposals_count = GREATEST(daily_proposals_count - 1, 0),
        updated_at = now()
    WHERE id = v_uid;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ------------------------------------------------------------------------------
-- 6. ATOMIC REWIND — Pro-gated, own-history-only, one-shot (cannot be
--    replayed until a new swipe/pass happens), quota-restoring.
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rewind_last_decision()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_plan TEXT;
  v_last swipes%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  -- Same per-user row lock as the quota functions: serializes concurrent
  -- rewind calls so only one can ever act on a given decision.
  SELECT plan_tier INTO v_plan FROM profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  IF v_plan IS DISTINCT FROM 'pro' THEN
    RETURN jsonb_build_object('success', false, 'error', 'pro_required');
  END IF;

  -- The single most recent event of ANY kind for this user. If it is itself
  -- a 'rewind', the last real decision has already been undone and nothing
  -- further can be rewound until a new swipe/pass occurs — this is what
  -- makes rewind one-shot and immune to replay/concurrent duplication.
  SELECT * INTO v_last FROM swipes
    WHERE profile_id = v_uid
    ORDER BY created_at DESC
    LIMIT 1;

  IF v_last IS NULL OR v_last.action = 'rewind' THEN
    RETURN jsonb_build_object('success', false, 'error', 'nothing_to_rewind');
  END IF;

  INSERT INTO swipes (profile_id, opportunity_id, action, rewound_decision_id)
  VALUES (v_uid, v_last.opportunity_id, 'rewind', v_last.id);

  IF v_last.action = 'interested' THEN
    UPDATE profiles
      SET daily_right_swipes_count = GREATEST(daily_right_swipes_count - 1, 0),
          updated_at = now()
      WHERE id = v_uid;

    DELETE FROM applications
      WHERE profile_id = v_uid AND opportunity_id = v_last.opportunity_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'rewoundOpportunityId', v_last.opportunity_id, 'rewoundAction', v_last.action);
END;
$$;

-- Only the authenticated role ever needs to call these (anonymous Supabase
-- Auth sessions are still `authenticated`, not `anon`, once signed in).
REVOKE ALL ON FUNCTION public.reserve_right_swipe() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finalize_interested_swipe(TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_pass(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reserve_proposal() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rollback_proposal_reservation() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rewind_last_decision() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.reserve_right_swipe() TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_interested_swipe(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_pass(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_proposal() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_proposal_reservation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rewind_last_decision() TO authenticated;
