-- ==============================================================================
-- RemoteMatch — 016: Resume Match Opportunities ("Grow your matches", ticket I)
--
-- Additive, forward-only. Two capabilities:
--   1. add_profile_skill()  — append ONE skill to the caller's profile after the
--      user explicitly confirms they have it. complete_onboarding() still owns
--      the full replace; this never deletes or reorders.
--   2. profile_skill_dismissals + dismiss_profile_skill() — records "I don't
--      have this" per user so the suggestion list stops re-surfacing a skill
--      the user rejected.
--
-- Touches NOTHING frozen: engine.ts / the fit-score formula / hard eligibility /
-- feed ranking / swipes / decision snapshots / complete_onboarding / AFC /
-- middleware / monetization / C1 / C2 are all untouched. No existing table's
-- columns are altered. Adding a skill legitimately changes the caller's own
-- computeScreeningFit inputs on the next feed load — that is the user's real
-- profile changing from their own confirmation, not a matcher change.
-- ==============================================================================

-- ---------------------------------------------------------------------------- 1.
-- add_profile_skill(p_skill_name) — idempotent single-skill append. Scoped to
-- auth.uid(); one user can never write another's. Mirrors set_career_direction()
-- (migration 015): SECURITY DEFINER + explicit auth.uid() gate, single purpose,
-- stamps nothing else.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_profile_skill(p_skill_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_name TEXT := btrim(coalesce(p_skill_name, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF v_name = '' OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'invalid skill_name' USING ERRCODE = '23514';
  END IF;

  -- No-op when the caller already has a case-insensitive match — the suggestion
  -- list already excludes owned skills, this is just defence in depth.
  IF EXISTS (
    SELECT 1 FROM public.profile_skills
    WHERE profile_id = v_uid AND lower(skill_name) = lower(v_name)
  ) THEN
    RETURN v_name;
  END IF;

  INSERT INTO public.profile_skills (profile_id, skill_name, is_primary)
  VALUES (v_uid, v_name, false);

  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.add_profile_skill(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_profile_skill(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------- 2.
-- profile_skill_dismissals — one row per (user, normalized-skill-key) the user
-- has said "I don't have this" for. Owner-scoped RLS, exactly like
-- profile_skills (migration 002).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profile_skill_dismissals (
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  skill_key  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, skill_key)
);

ALTER TABLE public.profile_skill_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_skill_dismissals FORCE ROW LEVEL SECURITY;

CREATE POLICY "profile_skill_dismissals_select_own"
  ON public.profile_skill_dismissals FOR SELECT
  USING (auth.uid() = profile_id);

CREATE POLICY "profile_skill_dismissals_insert_own"
  ON public.profile_skill_dismissals FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_skill_dismissals_delete_own"
  ON public.profile_skill_dismissals FOR DELETE
  USING (auth.uid() = profile_id);

REVOKE ALL ON public.profile_skill_dismissals FROM anon;
GRANT SELECT, INSERT, DELETE ON public.profile_skill_dismissals TO authenticated;

-- ---------------------------------------------------------------------------- 3.
-- dismiss_profile_skill(p_skill_key) — idempotent insert of one dismissal.
-- Caller passes the already-normalized key (lower/trim/alias applied
-- client-and-server-side by src/lib/resume/skill-opportunities.ts).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dismiss_profile_skill(p_skill_key TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_key TEXT := lower(btrim(coalesce(p_skill_key, '')));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF v_key = '' OR char_length(v_key) > 80 THEN
    RAISE EXCEPTION 'invalid skill_key' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.profile_skill_dismissals (profile_id, skill_key)
  VALUES (v_uid, v_key)
  ON CONFLICT (profile_id, skill_key) DO NOTHING;

  RETURN v_key;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_profile_skill(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_profile_skill(TEXT) TO authenticated;

-- ==============================================================================
-- DOWN:
--   DROP FUNCTION IF EXISTS public.dismiss_profile_skill(TEXT);
--   DROP FUNCTION IF EXISTS public.add_profile_skill(TEXT);
--   DROP TABLE IF EXISTS public.profile_skill_dismissals;
--   -- profile_skills rows added via add_profile_skill are indistinguishable
--   -- from onboarding skills by design; a DOWN does not remove them.
-- ==============================================================================
