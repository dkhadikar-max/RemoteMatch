-- ==============================================================================
-- RemoteMatch — 017: Unified Search Profile (ticket J)
--
-- Additive, forward-only. One grouped, PARTIAL-update RPC covering the
-- load-bearing "search profile" facts that onboarding collects but that had
-- no post-onboarding edit path: profile_intents.{target_roles,
-- employment_types, years_of_experience, min_salary} and
-- profile_locations.{current_country, work_preference}.
--
-- Deliberately does NOT touch: complete_onboarding() (frozen, AFC),
-- profile_skills / profile_skill_dismissals (stay add_profile_skill()-only,
-- ticket I), current_timezone / allowed_countries / willing_timezones
-- (audited as currently unused by any matching/eligibility code — left alone,
-- not repurposed), career_direction (set_career_direction(), migration 015,
-- untouched), engine.ts / ranking / eligibility / swipe / decision snapshots
-- (all frozen; this only ever changes future scoring INPUTS, exactly the
-- established precedent from 015/016).
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.update_search_preferences(
  p_target_roles        TEXT[]  DEFAULT NULL,
  p_employment_types    TEXT[]  DEFAULT NULL,
  p_years_of_experience TEXT    DEFAULT NULL,
  p_min_salary          NUMERIC DEFAULT NULL,
  p_work_preference     TEXT    DEFAULT NULL,
  p_current_country     TEXT    DEFAULT NULL
)
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

  -- Every parameter here defaults to NULL, and NULL always means "the caller
  -- did not supply this field, leave it unchanged" — never "clear it". A
  -- caller wanting to actually change a value must send a valid, non-null
  -- value for that field.
  IF p_target_roles IS NOT NULL AND COALESCE(array_length(p_target_roles, 1), 0) = 0 THEN
    RAISE EXCEPTION 'target_roles must be non-empty when supplied' USING ERRCODE = '23514';
  END IF;
  IF p_employment_types IS NOT NULL AND COALESCE(array_length(p_employment_types, 1), 0) = 0 THEN
    RAISE EXCEPTION 'employment_types must be non-empty when supplied' USING ERRCODE = '23514';
  END IF;
  IF p_years_of_experience IS NOT NULL
     AND p_years_of_experience NOT IN ('0-1', '2-3', '4-6', '7-10', '10+') THEN
    RAISE EXCEPTION 'invalid years_of_experience' USING ERRCODE = '23514';
  END IF;
  IF p_work_preference IS NOT NULL
     AND p_work_preference NOT IN ('worldwide', 'my_country', 'selected_countries') THEN
    RAISE EXCEPTION 'invalid work_preference' USING ERRCODE = '23514';
  END IF;
  IF p_current_country IS NOT NULL AND btrim(p_current_country) = '' THEN
    RAISE EXCEPTION 'current_country cannot be empty' USING ERRCODE = '23514';
  END IF;
  IF p_min_salary IS NOT NULL AND p_min_salary < 0 THEN
    RAISE EXCEPTION 'min_salary cannot be negative' USING ERRCODE = '23514';
  END IF;

  -- profile_intents: upsert, only the supplied columns move. A fresh row
  -- (shouldn't happen behind the onboarding middleware gate, but defensive)
  -- gets the same table defaults complete_onboarding would have used.
  INSERT INTO public.profile_intents
    (profile_id, target_roles, employment_types, years_of_experience, min_salary, updated_at)
  VALUES (
    v_uid,
    COALESCE(p_target_roles, ARRAY[]::TEXT[]),
    COALESCE(p_employment_types, ARRAY['Full-time']::TEXT[]),
    COALESCE(p_years_of_experience, '2-3'),
    p_min_salary,
    now()
  )
  ON CONFLICT (profile_id) DO UPDATE SET
    target_roles        = COALESCE(p_target_roles, profile_intents.target_roles),
    employment_types    = COALESCE(p_employment_types, profile_intents.employment_types),
    years_of_experience = COALESCE(p_years_of_experience, profile_intents.years_of_experience),
    min_salary          = COALESCE(p_min_salary, profile_intents.min_salary),
    updated_at           = now();

  IF p_work_preference IS NOT NULL OR p_current_country IS NOT NULL THEN
    INSERT INTO public.profile_locations (profile_id, current_country, work_preference)
    VALUES (v_uid, COALESCE(p_current_country, 'Worldwide'), COALESCE(p_work_preference, 'worldwide'))
    ON CONFLICT (profile_id) DO UPDATE SET
      current_country = COALESCE(p_current_country, profile_locations.current_country),
      work_preference = COALESCE(p_work_preference, profile_locations.work_preference);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.update_search_preferences(TEXT[], TEXT[], TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_search_preferences(TEXT[], TEXT[], TEXT, NUMERIC, TEXT, TEXT) TO authenticated;

-- ==============================================================================
-- DOWN:
--   DROP FUNCTION IF EXISTS public.update_search_preferences(TEXT[], TEXT[], TEXT, NUMERIC, TEXT, TEXT);
--   -- profile_intents / profile_locations rows this RPC updated are left in
--   -- place — a DOWN removes the editor, not the data it wrote.
-- ==============================================================================
