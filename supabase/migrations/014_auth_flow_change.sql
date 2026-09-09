-- ==============================================================================
-- RemoteMatch — 014: Auth Flow Change (AFC)
--
-- Per docs/auth-flow-change-plan.md (APPROVED WITH CONDITIONS) + docs/q5-findings-memo.md.
-- Supabase Auth stays the identity/session system. This migration supports the
-- move from the password grant to the passwordless OTP / magic-link grant, and
-- makes onboarding server-backed (delivers P-INT).
--
-- Additive and downstream-safe. NOT touched: opportunities, demand_gap_snapshots
-- and every other C2 object (frozen at fe092b5), swipes, applications, all
-- existing RLS policies, the supply-sync path.
--
-- Four things:
--   1. profiles.onboarding_completed_at  — NULL = onboarding not complete.
--      SERVER-WRITTEN ONLY. Deliberately NOT added to the `authenticated`
--      column-level GRANT UPDATE list (003/005). The only writer is the
--      complete_onboarding() SECURITY DEFINER function below.
--   2. handle_new_auth_user()  — extended to copy the name captured at signup
--      (raw_user_meta_data->>'full_name') into profiles.full_name. Existing
--      behavior (auto-provision a free-tier row, ON CONFLICT DO NOTHING) is
--      otherwise unchanged.
--   3. complete_onboarding()  — one atomic SECURITY DEFINER function that
--      validates + writes the onboarding sub-tables for the CALLER
--      (auth.uid(), never a parameter) and stamps onboarding_completed_at.
--   4. Grant hygiene  — REVOKE the stray blanket `anon` privileges on the
--      profile sub-tables (002's `GRANT ALL ... TO anon` predates FORCE RLS;
--      the RLS policies already neutralise it, but anon should have nothing).
--   5. Backfill  — onboarding_completed_at = created_at for users with real
--      product activity (swipes/applications). Per Q5 this is ~1 row (the one
--      real user); the 93 anonymous rows have no activity and are NOT matched.
--      (Anonymous-row deletion is a separate operational cleanup, not here.)
-- ==============================================================================

-- --------------------------------------------------------------------------- 1.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN profiles.onboarding_completed_at IS
  'Set by public.complete_onboarding() only. NULL => route the user to /onboarding. '
  'Not in any authenticated column GRANT — the client cannot set it.';

-- --------------------------------------------------------------------------- 2.
-- Extend the new-user trigger to carry the signup name. `ON CONFLICT DO NOTHING`
-- and every other aspect of 003's version is preserved.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, plan_tier, usage_date)
  VALUES (
    NEW.id,
    NEW.email,
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
    'free',
    (timezone('utc', now()))::date
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Trigger definition itself is unchanged from 003; re-assert it idempotently.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- --------------------------------------------------------------------------- 3.
-- Atomic onboarding completion. Writes ONLY the caller's own rows: profile_id is
-- always auth.uid(), never a parameter, so one user can never write another's
-- profile. SECURITY DEFINER so it can set onboarding_completed_at (no client
-- GRANT) and write the sub-tables in one transaction; the auth.uid() gate makes
-- that safe. Mirrors the 003/006 RPC conventions exactly.
CREATE OR REPLACE FUNCTION public.complete_onboarding(
  p_full_name            TEXT,
  p_headline             TEXT,
  p_employment_types     TEXT[],
  p_target_roles         TEXT[],
  p_years_of_experience  TEXT,
  p_min_salary           NUMERIC,
  p_preferred_currency   TEXT,
  p_skills               JSONB,   -- [{ "name": TEXT, "isPrimary": BOOL }]
  p_work_preference      TEXT,
  p_current_country      TEXT,
  p_current_timezone     TEXT,
  p_allowed_countries    TEXT[],
  p_willing_timezones    TEXT[],
  p_raw_resume_text      TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_now   TIMESTAMPTZ := now();
  v_skill JSONB;
  v_name  TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  -- ---- validation: every required section must be present + well-formed ----
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;
  IF p_full_name IS NULL OR btrim(p_full_name) = '' THEN
    RAISE EXCEPTION 'onboarding_invalid: full_name' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(array_length(p_employment_types, 1), 0) = 0 THEN
    RAISE EXCEPTION 'onboarding_invalid: employment_types' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(array_length(p_target_roles, 1), 0) = 0 THEN
    RAISE EXCEPTION 'onboarding_invalid: target_roles' USING ERRCODE = '23514';
  END IF;
  IF p_years_of_experience IS NULL
     OR p_years_of_experience NOT IN ('0-1', '2-3', '4-6', '7-10', '10+') THEN
    RAISE EXCEPTION 'onboarding_invalid: years_of_experience' USING ERRCODE = '23514';
  END IF;
  IF p_work_preference IS NULL
     OR p_work_preference NOT IN ('worldwide', 'my_country', 'selected_countries') THEN
    RAISE EXCEPTION 'onboarding_invalid: work_preference' USING ERRCODE = '23514';
  END IF;
  IF p_current_country IS NULL OR btrim(p_current_country) = '' THEN
    RAISE EXCEPTION 'onboarding_invalid: current_country' USING ERRCODE = '23514';
  END IF;
  IF p_skills IS NULL OR jsonb_typeof(p_skills) <> 'array' OR jsonb_array_length(p_skills) = 0 THEN
    RAISE EXCEPTION 'onboarding_invalid: skills' USING ERRCODE = '23514';
  END IF;

  -- ---- profiles content (NOT onboarding_completed_at yet) ----
  v_name := btrim(p_full_name);
  UPDATE public.profiles
     SET full_name       = v_name,
         headline         = NULLIF(btrim(COALESCE(p_headline, '')), ''),
         raw_resume_text  = NULLIF(p_raw_resume_text, ''),
         updated_at       = v_now
   WHERE id = v_uid;

  -- ---- intent (UNIQUE profile_id) ----
  INSERT INTO public.profile_intents
    (profile_id, employment_types, target_roles, years_of_experience,
     min_salary, preferred_currency, updated_at)
  VALUES
    (v_uid, p_employment_types, p_target_roles, p_years_of_experience,
     p_min_salary, COALESCE(NULLIF(p_preferred_currency, ''), 'USD'), v_now)
  ON CONFLICT (profile_id) DO UPDATE SET
    employment_types    = EXCLUDED.employment_types,
    target_roles        = EXCLUDED.target_roles,
    years_of_experience = EXCLUDED.years_of_experience,
    min_salary          = EXCLUDED.min_salary,
    preferred_currency  = EXCLUDED.preferred_currency,
    updated_at          = v_now;

  -- ---- location (UNIQUE profile_id) ----
  INSERT INTO public.profile_locations
    (profile_id, current_country, current_timezone, work_preference,
     allowed_countries, willing_timezones)
  VALUES
    (v_uid, btrim(p_current_country),
     COALESCE(NULLIF(btrim(COALESCE(p_current_timezone, '')), ''), 'UTC'),
     p_work_preference,
     COALESCE(p_allowed_countries, ARRAY[]::TEXT[]),
     COALESCE(p_willing_timezones, ARRAY[]::TEXT[]))
  ON CONFLICT (profile_id) DO UPDATE SET
    current_country   = EXCLUDED.current_country,
    current_timezone  = EXCLUDED.current_timezone,
    work_preference   = EXCLUDED.work_preference,
    allowed_countries = EXCLUDED.allowed_countries,
    willing_timezones = EXCLUDED.willing_timezones;

  -- ---- skills: replace-all for this profile ----
  DELETE FROM public.profile_skills WHERE profile_id = v_uid;
  FOR v_skill IN SELECT value FROM jsonb_array_elements(p_skills)
  LOOP
    IF btrim(COALESCE(v_skill->>'name', '')) <> '' THEN
      INSERT INTO public.profile_skills (profile_id, skill_name, is_primary)
      VALUES (v_uid, btrim(v_skill->>'name'),
              COALESCE((v_skill->>'isPrimary')::BOOLEAN, FALSE));
    END IF;
  END LOOP;

  -- ---- the completion stamp — the ONLY writer of this column ----
  UPDATE public.profiles SET onboarding_completed_at = v_now WHERE id = v_uid;

  RETURN v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_onboarding(
  TEXT, TEXT, TEXT[], TEXT[], TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT[], TEXT[], TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_onboarding(
  TEXT, TEXT, TEXT[], TEXT[], TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT[], TEXT[], TEXT
) TO authenticated;

-- --------------------------------------------------------------------------- 4.
-- Grant hygiene. 002 issued a blanket `GRANT ALL ON ALL TABLES ... TO anon`
-- before FORCE RLS + the owner-scoped policies existed. anon should hold nothing
-- on the profile sub-tables. authenticated keeps its grant (RLS still scopes it
-- per-row via `auth.uid() = profile_id`).
REVOKE ALL ON profile_intents     FROM anon;
REVOKE ALL ON profile_skills      FROM anon;
REVOKE ALL ON profile_locations   FROM anon;
REVOKE ALL ON profile_experiences FROM anon;

-- --------------------------------------------------------------------------- 5.
-- Backfill: users with demonstrated product activity are treated as already
-- onboarded (their localStorage profile is device-local and not migrated; they
-- can edit it from /settings later). Everyone else — including every anonymous
-- row — is left NULL and will be routed to /onboarding on next sign-in.
UPDATE public.profiles p
   SET onboarding_completed_at = p.created_at
 WHERE p.onboarding_completed_at IS NULL
   AND (
     EXISTS (SELECT 1 FROM public.swipes s       WHERE s.profile_id = p.id)
     OR EXISTS (SELECT 1 FROM public.applications a WHERE a.profile_id = p.id)
   );

-- ==============================================================================
-- DOWN:
--   DROP FUNCTION IF EXISTS public.complete_onboarding(
--     TEXT, TEXT, TEXT[], TEXT[], TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT[], TEXT[], TEXT);
--   ALTER TABLE profiles DROP COLUMN IF EXISTS onboarding_completed_at;  -- backfilled values are derived, disposable
--   -- restore handle_new_auth_user() to the 003 body (without the full_name copy)
--   -- grants: the anon REVOKEs can stay (anon should never have had them)
-- ==============================================================================
