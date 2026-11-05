-- Resume Intelligence (PR B) — fix a column-ambiguity defect in upsert_resume_analysis().
--
-- NOT APPLIED. Prepared only, pending review and separate authorization — see
-- docs/resume-pr-b-live-harness-run-2026-10-23.md for the live-run finding this fixes.
-- Migrations 036 and 037 are UNCHANGED by this file (preserved exactly as applied).
--
-- FINDING (discovered only by actually EXECUTING this function against real PostgreSQL —
-- running the live concurrency harness against the disposable instance at
-- postgresql://postgres@127.0.0.1:5433/postgres, 2026-10-23): upsert_resume_analysis() fails on
-- EVERY call with:
--   ERROR: column reference "id" is ambiguous (SQLSTATE 42702)
-- Root cause: the function is declared `RETURNS TABLE (id UUID, wrote BOOLEAN)` (036:257). In
-- PL/pgSQL, a RETURNS TABLE clause's output columns become ordinary variables in scope for the
-- entire function body — so the bare identifier `id` is no longer just a possible column name, it
-- is ALSO a variable. The function's own ownership check —
--     IF NOT EXISTS (
--       SELECT 1 FROM resume_versions WHERE id = p_resume_version_id AND profile_id = v_uid
--     ) THEN
-- (036:276-278) — references `id` unqualified inside that subquery. Postgres cannot tell whether
-- that `id` means `resume_versions.id` (the column) or the function's own `id` OUT variable, and
-- raises 42702. This happens on every single call, including calls that would otherwise succeed —
-- it is not specific to the ownership-denial path that first surfaced it live.
--
-- EXHAUSTIVE CHECK (per the review that produced this migration): every reference to `id` or
-- `wrote` in upsert_resume_analysis()'s body was individually inspected. The ONLY ambiguous one is
-- the line above. Every other `id`-like reference in the function is already safe:
--   - `v_existing.id` (two occurrences) — qualified via RECORD field access, never ambiguous.
--   - `resume_analyses.id` in the `RETURNING ... INTO v_id` clause — already explicitly qualified.
--   - `v_id`, `v_uid` — distinct variable names, not the bare identifier `id`.
--   - `profile_id`, `resume_version_id`, `opportunity_id`, etc. — distinct column/parameter names
--     ending in `_id`, never confused with the bare `id` OUT variable.
-- The other 4 functions in migration 036 (`create_resume_version`, `record_resume_suggestion_
-- decision`, `reserve_resume_analysis`, `refund_resume_analysis`) each have at least one bare
-- `WHERE id = ...` reference too (036:181, 367, 416/438/452/481), but NONE of them declares
-- `RETURNS TABLE` with a column named `id` — they `RETURN UUID`/`JSONB`/`VOID`, and their own
-- DECLARE blocks never introduce a variable literally named `id` (only `v_id`, `v_uid`, `v_row`,
-- etc.). So this specific collision is unique to upsert_resume_analysis() and does not recur
-- anywhere else in migration 036.
--
-- FIX: qualify the two columns in that one subquery with an explicit table alias (`rv`), removing
-- any ambiguity. Nothing else in the function changes. Using CREATE OR REPLACE FUNCTION against
-- the SAME signature (name + exact argument types, unchanged) preserves the function's existing
-- GRANTs — migration 037 already revoked the implicit PUBLIC/anon EXECUTE grant and re-granted
-- EXECUTE to authenticated for this exact signature; replacing the body without changing the
-- signature does not reset that. No GRANT/REVOKE statement is needed or included in this file.
--
-- Exact signature (unchanged from 036/037):
--   public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric)

\set ON_ERROR_STOP on
BEGIN;

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
SET search_path = public
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
  -- FIXED (was: `SELECT 1 FROM resume_versions WHERE id = p_resume_version_id AND profile_id =
  -- v_uid` — ambiguous against this function's own `id` OUT variable). Explicit alias `rv`
  -- removes the ambiguity; behavior is otherwise identical.
  IF NOT EXISTS (
    SELECT 1 FROM resume_versions rv WHERE rv.id = p_resume_version_id AND rv.profile_id = v_uid
  ) THEN
    RAISE EXCEPTION 'resume_version_id does not belong to caller' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
  FROM resume_analyses
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

  INSERT INTO resume_analyses (
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

COMMIT;

-- DOWN (manual, not automated):
--   Re-apply migration 036's original CREATE OR REPLACE FUNCTION public.upsert_resume_analysis(...)
--   body verbatim (restores the ambiguous, non-functional version — not expected to ever be needed).
