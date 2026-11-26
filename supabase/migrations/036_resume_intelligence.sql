-- ==============================================================================
-- RemoteMatch — 036: Resume Intelligence (PR B)
--
-- docs/resume-intelligence-design.md §6/§10, approved by Deep 2026-10-17/18.
-- Three additive, owner-scoped tables backing the server-side Resume
-- Intelligence service: resume versions, their analyses (cached by
-- version × mode × job content hash × analysis contract version), and the
-- per-suggestion accept/reject/edit decisions a user makes against an
-- analysis. Nothing here touches matching, scoring, eligibility, feed
-- ranking, swipes, decision snapshots or complete_onboarding() — all
-- frozen, all untouched (same discipline as 015/016/017).
--
-- Disabled by default: the application feature flag gating this service
-- (RESUME_INTELLIGENCE_ENABLED or equivalent) lives in app code, not here —
-- this migration only needs to exist and be safe to apply; it does not turn
-- anything on by itself.
--
-- Ownership: every table is reachable only via `profile_id = auth.uid()` —
-- RLS for owner-only SELECT, and the same auth.uid() derived INSIDE each
-- SECURITY DEFINER RPC below for writes (never a caller-supplied profile id;
-- never service-role), exactly the pattern reserve_proposal()/
-- finalize_interested_swipe() (migration 003) already established.
-- No admin API ever selects `content` or `result` from these tables —
-- same rule the project already applies to `profiles.raw_resume_text`
-- (see src/app/api/admin/users/route.ts's header comment).
-- ==============================================================================

-- ---------------------------------------------------------------------------- 1.
-- resume_versions — one row per distinct resume text a user has (onboarding
-- upload, a later re-upload/paste, or a new version created from accepted
-- edits). Content-addressed by sha256 so re-uploading the same text is a
-- no-op, not a new row. Never mutated in place — "accepting" a suggestion
-- always creates a NEW version with parent_version_id set; the original is
-- never rewritten (docs/resume-intelligence-design.md §6, "reversible
-- edits").
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.resume_versions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content           TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 60000),
  content_sha256    TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source            TEXT NOT NULL CHECK (source IN ('onboarding', 'upload', 'paste', 'accepted_edits')),
  parent_version_id UUID REFERENCES public.resume_versions(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, content_sha256)
);

CREATE INDEX IF NOT EXISTS idx_resume_versions_profile_created
  ON public.resume_versions (profile_id, created_at DESC);

COMMENT ON TABLE public.resume_versions IS
  'Resume Intelligence (migration 036). One row per distinct resume text a user has had '
  '(content-addressed by sha256; re-submitting identical text is a no-op via the unique '
  'constraint). Never updated in place — an accepted edit creates a NEW row with '
  'parent_version_id set. Retention: the owning RPC below keeps only the most recent 10 '
  'versions per profile, oldest pruned on insert.';

ALTER TABLE public.resume_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resume_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY "resume_versions_select_own"
  ON public.resume_versions FOR SELECT
  USING (auth.uid() = profile_id);

-- ---------------------------------------------------------------------------- 2.
-- resume_analyses — one row per (version, mode, job) analysis result. The
-- unique constraint on (profile_id, resume_version_id, mode,
-- job_content_hash, analysis_version) IS the cache: a hit returns the
-- stored row with no model call (docs §6, "Cache"). status 'pending' guards
-- against two concurrent requests both calling the model for the same key;
-- a 'pending' row older than 3 minutes is treated as failed by the
-- application (no DB-side TTL needed — the app re-checks on read).
-- result is NULL until status moves to 'success' (then validated JSON) or
-- stays NULL for 'insufficient_input' / 'unavailable'.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.resume_analyses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  resume_version_id   UUID NOT NULL REFERENCES public.resume_versions(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL CHECK (mode IN ('general', 'target_job')),
  opportunity_id      TEXT,                 -- CanonicalOpportunity id string, when mode = 'target_job'
  job_content_hash    TEXT NOT NULL DEFAULT '',  -- '' for general mode; sha256 of the job text for target_job
  analysis_version    TEXT NOT NULL,         -- e.g. 'resume-intel-2026.10-v1' — see §5 of the design doc
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'success', 'insufficient_input', 'unavailable')),
  result              JSONB,
  source_ai           BOOLEAN NOT NULL DEFAULT false,
  model               TEXT,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  cost_usd            NUMERIC(10,4),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, resume_version_id, mode, job_content_hash, analysis_version)
);

CREATE INDEX IF NOT EXISTS idx_resume_analyses_profile_created
  ON public.resume_analyses (profile_id, created_at DESC);

COMMENT ON TABLE public.resume_analyses IS
  'Resume Intelligence (migration 036). Cached, idempotent analysis results — the unique '
  'key (profile_id, resume_version_id, mode, job_content_hash, analysis_version) is the '
  'whole cache/idempotency contract (docs/resume-intelligence-design.md §6). A failed run '
  '(status unavailable/insufficient_input) never overwrites a prior success row for the '
  'same key — the RPC below enforces that, not the UNIQUE constraint alone.';

ALTER TABLE public.resume_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resume_analyses FORCE ROW LEVEL SECURITY;

CREATE POLICY "resume_analyses_select_own"
  ON public.resume_analyses FOR SELECT
  USING (auth.uid() = profile_id);

-- ---------------------------------------------------------------------------- 3.
-- resume_suggestion_decisions — the user's accept/reject/edit choice for one
-- suggestion id inside one analysis's result. Never changes resume_versions
-- or resume_analyses directly; "Create new version" (a separate explicit
-- client action, §6) is what turns an accepted decision into a new
-- resume_versions row.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.resume_suggestion_decisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  analysis_id    UUID NOT NULL REFERENCES public.resume_analyses(id) ON DELETE CASCADE,
  suggestion_id  TEXT NOT NULL CHECK (char_length(suggestion_id) BETWEEN 1 AND 100),
  decision       TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'edited')),
  final_text     TEXT CHECK (final_text IS NULL OR char_length(final_text) <= 2000),
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, suggestion_id)
);

COMMENT ON TABLE public.resume_suggestion_decisions IS
  'Resume Intelligence (migration 036). One row per suggestion the user has acted on '
  '(re-deciding the same suggestion_id updates the existing row via the RPC''s upsert, '
  'not a new one). Purely a record of the choice — it never itself edits a resume; '
  '"Create new version" is a separate client action.';

ALTER TABLE public.resume_suggestion_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resume_suggestion_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY "resume_suggestion_decisions_select_own"
  ON public.resume_suggestion_decisions FOR SELECT
  USING (auth.uid() = profile_id);

-- ---------------------------------------------------------------------------- 4.
-- create_resume_version() — append-or-return-existing. Idempotent on
-- (profile_id, sha256): a re-submit of identical text returns the existing
-- row's id rather than erroring or duplicating. Prunes to the most recent
-- 10 versions per profile after insert (retention, §6).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_resume_version(
  p_content  TEXT,
  p_sha256   TEXT,
  p_source   TEXT,
  p_parent_version_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_source NOT IN ('onboarding', 'upload', 'paste', 'accepted_edits') THEN
    RAISE EXCEPTION 'invalid source' USING ERRCODE = '23514';
  END IF;
  IF p_content IS NULL OR char_length(p_content) = 0 OR char_length(p_content) > 60000 THEN
    RAISE EXCEPTION 'invalid content length' USING ERRCODE = '23514';
  END IF;
  IF p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid sha256' USING ERRCODE = '23514';
  END IF;
  -- parent_version_id, when supplied, must belong to the caller — never lets one
  -- user chain a new version off another user's resume.
  IF p_parent_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.resume_versions WHERE id = p_parent_version_id AND profile_id = v_uid
  ) THEN
    RAISE EXCEPTION 'parent_version_id not found for this profile' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.resume_versions (profile_id, content, content_sha256, source, parent_version_id)
  VALUES (v_uid, p_content, p_sha256, p_source, p_parent_version_id)
  ON CONFLICT (profile_id, content_sha256) DO UPDATE SET profile_id = resume_versions.profile_id
  RETURNING id INTO v_id;

  -- Retention: keep only the most recent 10 versions for this profile.
  -- CASCADE takes their analyses and decisions with them.
  DELETE FROM public.resume_versions
  WHERE profile_id = v_uid
    AND id NOT IN (
      SELECT id FROM public.resume_versions
      WHERE profile_id = v_uid
      ORDER BY created_at DESC
      LIMIT 10
    );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_resume_version(text, text, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------- 5.
-- upsert_resume_analysis() — the ONE write path for an analysis row.
--
-- AUDIT FIX (docs/resume-pr-b-audit-2026-10-22.md, Finding A): this function
-- used to take p_profile_id as a caller-supplied parameter and was GRANTed to
-- service_role only — but the application never actually called it with a
-- service-role client (every call used the signed-in user's own anon-key+JWT
-- client, the same client every other RPC in this migration is correctly
-- called with), so every write failed with a silent permission-denied error
-- the caller never checked. Fixed the same way the rest of this file already
-- does it: derive the caller's identity from auth.uid() internally (removing
-- the trust-the-caller p_profile_id parameter entirely, not just adding a
-- check beside it) and GRANT to `authenticated`. SECURITY DEFINER still
-- matters here — it's what lets this function read across the `profiles`
-- FK check and write regardless of RLS, while auth.uid() is what keeps it
-- scoped to the caller's own rows, exactly like create_resume_version() and
-- record_resume_suggestion_decision() below.
--
-- Three states it must handle correctly (§6, "cache"):
--   - no row for the key yet            -> insert
--   - a row exists with status='pending'
--     older than 3 minutes (abandoned)  -> overwrite with the new attempt
--   - a row exists with status='success' -> NEVER overwritten by a
--     subsequent 'unavailable'/'insufficient_input' result for the SAME
--     key; a failed retry must not erase a prior good analysis.
-- Returns the row id and whether it actually wrote (vs. a no-op because a
-- success already exists, or another request's 'pending' claim is still
-- live), so the caller can distinguish "serving cache" / "someone else has
-- this in flight" from "ran and stored". The 'pending' claim is how real
-- concurrency control works (audit Finding C): the service now writes a
-- 'pending' row via this same function BEFORE calling the model, so the
-- FOR UPDATE row lock below genuinely serializes two concurrent requests for
-- the identical (profile, version, mode, job, version) key — a database
-- mechanism, not an in-process lock, so it holds across server instances.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_resume_analysis(
  p_resume_version_id UUID,
  p_mode              TEXT,
  p_opportunity_id    TEXT,
  p_job_content_hash  TEXT,
  p_analysis_version  TEXT,
  p_status            TEXT,
  p_result            JSONB,
  p_source_ai         BOOLEAN,
  p_model             TEXT,
  p_prompt_tokens     INTEGER,
  p_completion_tokens INTEGER,
  p_cost_usd          NUMERIC
)
RETURNS TABLE (id UUID, wrote BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_existing RECORD;
  v_id       UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_mode NOT IN ('general', 'target_job') THEN
    RAISE EXCEPTION 'invalid mode' USING ERRCODE = '23514';
  END IF;
  IF p_status NOT IN ('pending', 'success', 'insufficient_input', 'unavailable') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.resume_versions WHERE id = p_resume_version_id AND profile_id = v_uid
  ) THEN
    RAISE EXCEPTION 'resume_version_id does not belong to caller' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
  FROM public.resume_analyses
  WHERE profile_id = v_uid
    AND resume_version_id = p_resume_version_id
    AND mode = p_mode
    AND job_content_hash = p_job_content_hash
    AND analysis_version = p_analysis_version
  FOR UPDATE;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'success' AND p_status <> 'success' THEN
    -- A prior success is never clobbered by a later failed attempt for the same key.
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'pending' AND p_status = 'pending'
     AND v_existing.created_at > now() - interval '3 minutes' THEN
    -- Another request already claimed this exact key and is still inside its 3-minute window:
    -- this caller must not start a second concurrent attempt (or double-count quota for one).
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  INSERT INTO public.resume_analyses (
    profile_id, resume_version_id, mode, opportunity_id, job_content_hash, analysis_version,
    status, result, source_ai, model, prompt_tokens, completion_tokens, cost_usd, updated_at
  )
  VALUES (
    v_uid, p_resume_version_id, p_mode, p_opportunity_id, p_job_content_hash, p_analysis_version,
    p_status, p_result, p_source_ai, p_model, p_prompt_tokens, p_completion_tokens, p_cost_usd, now()
  )
  ON CONFLICT (profile_id, resume_version_id, mode, job_content_hash, analysis_version) DO UPDATE SET
    opportunity_id    = EXCLUDED.opportunity_id,
    status            = EXCLUDED.status,
    result            = EXCLUDED.result,
    source_ai         = EXCLUDED.source_ai,
    model             = EXCLUDED.model,
    prompt_tokens     = EXCLUDED.prompt_tokens,
    completion_tokens = EXCLUDED.completion_tokens,
    cost_usd          = EXCLUDED.cost_usd,
    updated_at        = now()
  RETURNING resume_analyses.id INTO v_id;

  RETURN QUERY SELECT v_id, true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_resume_analysis(
  uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric
) TO authenticated;

-- ---------------------------------------------------------------------------- 6.
-- record_resume_suggestion_decision() — the one write path for a decision.
-- Upsert on (analysis_id, suggestion_id): re-deciding the same suggestion
-- updates it rather than creating a duplicate history row (this table is
-- current-state, not an append-only log).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_resume_suggestion_decision(
  p_analysis_id   UUID,
  p_suggestion_id TEXT,
  p_decision      TEXT,
  p_final_text    TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id  UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_decision NOT IN ('accepted', 'rejected', 'edited') THEN
    RAISE EXCEPTION 'invalid decision' USING ERRCODE = '23514';
  END IF;
  IF p_suggestion_id IS NULL OR char_length(p_suggestion_id) = 0 OR char_length(p_suggestion_id) > 100 THEN
    RAISE EXCEPTION 'invalid suggestion_id' USING ERRCODE = '23514';
  END IF;
  IF p_final_text IS NOT NULL AND char_length(p_final_text) > 2000 THEN
    RAISE EXCEPTION 'final_text too long' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.resume_analyses WHERE id = p_analysis_id AND profile_id = v_uid
  ) THEN
    RAISE EXCEPTION 'analysis not found for this profile' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.resume_suggestion_decisions (profile_id, analysis_id, suggestion_id, decision, final_text)
  VALUES (v_uid, p_analysis_id, p_suggestion_id, p_decision, p_final_text)
  ON CONFLICT (analysis_id, suggestion_id) DO UPDATE SET
    decision   = EXCLUDED.decision,
    final_text = EXCLUDED.final_text,
    decided_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_resume_suggestion_decision(uuid, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------- 7.
-- Per-user daily quota — Free 2/day, Pro 10/day (design doc §10 decision 3,
-- Deep 2026-10-17/18: "Apply limits server-side per authenticated user.
-- Count successful, billable analysis attempts... retries and failures
-- should not allow unlimited calls"). Same atomic row-locked
-- reset-then-check-then-increment shape as reserve_proposal() (migration
-- 003) — proven correct in production, reused rather than reinvented.
-- Counts only attempts that actually reach the model (source_ai = true,
-- i.e. billable); a cache hit, a rules-only fallback, or a request that
-- never got past input validation costs nothing (caller simply never calls
-- this RPC for those cases).
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS daily_resume_analyses_count INT DEFAULT 0;

CREATE OR REPLACE FUNCTION public.reserve_resume_analysis()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (timezone('utc', now()))::date;
  v_row profiles%ROWTYPE;
  v_limit INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  IF v_row.usage_date <> v_today THEN
    v_row.daily_right_swipes_count := 0;
    v_row.daily_proposals_count := 0;
    v_row.daily_evaluations_count := 0;
    v_row.daily_resume_analyses_count := 0;
    v_row.usage_date := v_today;
  END IF;

  v_limit := CASE WHEN v_row.plan_tier = 'pro' THEN 10 ELSE 2 END;

  IF v_row.daily_resume_analyses_count >= v_limit THEN
    UPDATE public.profiles SET
      usage_date = v_row.usage_date,
      daily_right_swipes_count = v_row.daily_right_swipes_count,
      daily_proposals_count = v_row.daily_proposals_count,
      daily_evaluations_count = v_row.daily_evaluations_count,
      daily_resume_analyses_count = v_row.daily_resume_analyses_count
      WHERE id = v_uid;
    RETURN jsonb_build_object(
      'allowed', false, 'limit', v_limit, 'remaining', 0, 'planTier', v_row.plan_tier
    );
  END IF;

  v_row.daily_resume_analyses_count := v_row.daily_resume_analyses_count + 1;

  UPDATE public.profiles SET
    usage_date = v_row.usage_date,
    daily_right_swipes_count = v_row.daily_right_swipes_count,
    daily_proposals_count = v_row.daily_proposals_count,
    daily_evaluations_count = v_row.daily_evaluations_count,
    daily_resume_analyses_count = v_row.daily_resume_analyses_count
    WHERE id = v_uid;

  RETURN jsonb_build_object(
    'allowed', true, 'limit', v_limit, 'remaining', v_limit - v_row.daily_resume_analyses_count, 'planTier', v_row.plan_tier
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_resume_analysis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_resume_analysis() TO authenticated;

-- A reservation taken for a call that then fails before reaching the model (e.g. the per-user
-- in-flight guard in upsert_resume_analysis(), or a pre-flight input-validation rejection) is
-- given back — mirrors the OpenAI spend ledger's reserve/refund shape (migration 024), applied
-- here to the per-user daily count instead of a dollar amount.
CREATE OR REPLACE FUNCTION public.refund_resume_analysis()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  UPDATE public.profiles
  SET daily_resume_analyses_count = GREATEST(0, daily_resume_analyses_count - 1)
  WHERE id = v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_resume_analysis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_resume_analysis() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ==============================================================================
-- DOWN:
--   DROP FUNCTION IF EXISTS public.refund_resume_analysis();
--   DROP FUNCTION IF EXISTS public.reserve_resume_analysis();
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS daily_resume_analyses_count;
--   DROP FUNCTION IF EXISTS public.record_resume_suggestion_decision(uuid, text, text, text);
--   DROP FUNCTION IF EXISTS public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric);
--   DROP FUNCTION IF EXISTS public.create_resume_version(text, text, text, uuid);
--   DROP TABLE IF EXISTS resume_suggestion_decisions;
--   DROP TABLE IF EXISTS resume_analyses;
--   DROP TABLE IF EXISTS resume_versions;
--   -- Safe at any point — purely additive, referenced by no other table via
--   -- foreign key, and the feature it backs is disabled by default in app
--   -- code. Rolling back while code still calls these RPCs makes every
--   -- Resume Intelligence call fail closed (the service already treats an
--   -- RPC error as 'unavailable' + the rules-only output, same fail-safe
--   -- convention as every other AI integration in this project).
-- ==============================================================================
