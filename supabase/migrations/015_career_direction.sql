-- ==============================================================================
-- RemoteMatch — 015: career direction (Career Transition Matching V1)
--
-- Additive, forward-only. A single new column + a single-purpose RPC. Touches
-- NOTHING frozen: complete_onboarding, /api/onboarding, AFC, middleware,
-- engine.ts, swipes/decision snapshots, monetization, C1, C2 are all untouched.
--
-- career_direction:
--   'continue'      (DEFAULT) — match on proven experience. Exactly the v1
--                   behaviour. Every existing row backfills to this, so no
--                   current user's matching changes.
--   'change_fields' — the user has explicitly said they want to switch fields.
--                   An ADDITIVE, explanation-only transition-analysis layer
--                   then classifies eligible target-role opportunities as
--                   Direct / Transition / Stretch and surfaces "why this could
--                   fit" / "potential gaps". It does NOT alter eligibility, the
--                   fit-score formula, or feed ranking (V1).
--
-- Set ONLY from /settings via set_career_direction() below — never from
-- onboarding. Read via GET /api/profile.
-- ==============================================================================

ALTER TABLE profile_intents
  ADD COLUMN IF NOT EXISTS career_direction TEXT NOT NULL DEFAULT 'continue'
  CHECK (career_direction IN ('continue', 'change_fields'));

COMMENT ON COLUMN profile_intents.career_direction IS
  'continue (default) = match on proven experience (v1). change_fields = also '
  'run the additive career-transition explanation layer. Set by '
  'set_career_direction() from /settings only; read via GET /api/profile.';

-- ------------------------------------------------------------------------------
-- set_career_direction(p_direction) — the only writer. Scoped to auth.uid();
-- one user can never set another's. SECURITY DEFINER + auth.uid() gate mirrors
-- complete_onboarding()'s convention, but this is a separate, single-field
-- function and does NOT stamp onboarding_completed_at or touch anything else.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_career_direction(p_direction TEXT)
RETURNS TEXT
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
  IF p_direction IS NULL OR p_direction NOT IN ('continue', 'change_fields') THEN
    RAISE EXCEPTION 'invalid career_direction' USING ERRCODE = '23514';
  END IF;

  -- The caller always has a profiles row (handle_new_auth_user); they may not
  -- yet have a profile_intents row (un-onboarded). Upsert the single column,
  -- leaving every other intent field at its table default for a fresh row.
  INSERT INTO public.profile_intents (profile_id, career_direction, updated_at)
  VALUES (v_uid, p_direction, now())
  ON CONFLICT (profile_id) DO UPDATE SET
    career_direction = EXCLUDED.career_direction,
    updated_at       = now();

  RETURN p_direction;
END;
$$;

REVOKE ALL ON FUNCTION public.set_career_direction(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_career_direction(TEXT) TO authenticated;

-- ==============================================================================
-- DOWN:
--   DROP FUNCTION IF EXISTS public.set_career_direction(TEXT);
--   ALTER TABLE profile_intents DROP COLUMN IF EXISTS career_direction;
-- ==============================================================================
