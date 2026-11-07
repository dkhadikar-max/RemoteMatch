-- Resume Intelligence (PR B) — fix a genuine concurrency defect in upsert_resume_analysis()
-- on a brand-new key (no pre-existing resume_analyses row).
--
-- NOT APPLIED to any shared/persistent database. Prepared and verified only against a disposable,
-- throwaway PostgreSQL 18.4 instance created and torn down entirely within this session
-- (127.0.0.1:5544, never reachable outside this machine, dropped after verification — see
-- docs/resume-pr-b-live-run-2026-10-30.md for the full run record). Migrations 036, 037 and 038
-- are UNCHANGED by this file.
--
-- FINDING (reproduced live, 2026-10-30, via test/live-pg/resume-concurrency-live-suite.ts Section 3
-- — this is the CONFIRMATION of the mechanism hypothesis in docs/resume-pr-b-next-steps-
-- 2026-10-30.md §2 and docs/resume-pr-b-inventory-2026-10-30.md G3, not a new discovery):
--
-- On a brand-new key (no row yet for this profile_id/resume_version_id/mode/job_content_hash/
-- analysis_version), upsert_resume_analysis()'s `SELECT ... FOR UPDATE` (038:95-102) finds no row
-- to lock — there is nothing for a second concurrent caller to block against at that step, so both
-- callers reach the `INSERT ... ON CONFLICT (...) DO UPDATE SET ...` statement (038:118-136), which
-- has NO `WHERE` clause on the `DO UPDATE`. Postgres correctly serializes the two INSERTs at the
-- row level (the second blocks on the first's uncommitted row, then re-evaluates the conflict), but
-- because the `DO UPDATE` is unconditional, BOTH callers' `RETURNING resume_analyses.id INTO v_id`
-- succeeds and both reach `RETURN QUERY SELECT v_id, true` — i.e. BOTH report `wrote = true` for
-- what is, from the application's perspective, the SAME claim.
--
-- Observed effect in the live run: `test/live-pg/resume-concurrency-live-suite.ts` Section 3 (two
-- real, independent pg connections, `analyzeResume()` called concurrently for an identical,
-- previously-nonexistent key) — 3 of 4 assertions failed:
--   - both concurrent requests reported `persisted: true` (expected: exactly one)
--   - neither request was turned away with `already_in_progress` (expected: exactly one)
--   - the per-user daily quota was consumed TWICE for one logical analysis (`before=0 after=2`)
-- The ONE assertion that still passed — "exactly one resume_analyses row exists for this key" —
-- is why this escaped the row-count check alone: the second caller's unconditional `DO UPDATE`
-- overwrites the SAME row the first caller just inserted (same conflict target), so there is never
-- a duplicate ROW, only a duplicate CLAIM. A test that only counts rows, as several of the earlier,
-- narrower checks in this file's history did, cannot see this defect — only a test asserting on
-- the number of winners/losers (`persisted`) and the quota delta can.
--
-- FIX: add a `WHERE` guard to the `DO UPDATE`, mirroring the exact two conditions the function
-- already uses for its "existing row" early-return branches (038:104-116) — a prior `success` is
-- never clobbered, and a live (<3min) `pending` claim is never stolen. When that `WHERE` excludes
-- the update (another concurrent caller already owns this exact claim), the `INSERT ... RETURNING
-- ... INTO v_id` produces no row, so `v_id` is left NULL by ordinary PL/pgSQL `INTO` semantics (no
-- `STRICT`, so zero rows is not an error) — the new code below detects that and falls back to
-- re-reading the now-genuinely-existing row, returning its id with `wrote = false`, exactly the
-- same shape every other "someone else already has this" path in this function already returns.
--
-- Using `CREATE OR REPLACE FUNCTION` against the exact same signature (unchanged from 036/037/038)
-- preserves migration 037's ACL grants automatically — no GRANT/REVOKE needed here.
--
-- Exact signature (unchanged):
--   public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric)

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
    SELECT 1 FROM public.resume_versions rv WHERE rv.id = p_resume_version_id AND rv.profile_id = v_uid
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

  -- FIXED (2026-10-30, new-key race): the WHERE clause below is new. On a brand-new key the SELECT
  -- ... FOR UPDATE above locks nothing (no row exists), so two concurrent callers can both reach
  -- this INSERT. The WHERE mirrors the two early-return conditions above so a losing concurrent
  -- caller's conflict-triggered UPDATE is excluded rather than unconditionally applied — closing
  -- the exact gap the early-return checks already closed for the "row existed before this
  -- transaction started" case, but which an unconditional DO UPDATE left open for "a row was
  -- created by a sibling transaction that committed between this transaction's SELECT and INSERT".
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
  WHERE NOT (
    resume_analyses.status = 'success' AND EXCLUDED.status <> 'success'
  ) AND NOT (
    resume_analyses.status = 'pending' AND EXCLUDED.status = 'pending'
    AND resume_analyses.created_at > now() - interval '3 minutes'
  )
  RETURNING resume_analyses.id INTO v_id;

  IF v_id IS NULL THEN
    -- The WHERE guard excluded our write: a sibling transaction committed its own claim for this
    -- exact key between our SELECT ... FOR UPDATE (which found nothing) and our INSERT. Re-read
    -- the now-genuinely-existing row and report it the same way every other "someone else already
    -- has this" path in this function does: the real id, wrote = false.
    SELECT ra.id INTO v_id
    FROM public.resume_analyses ra
    WHERE ra.profile_id = v_uid
      AND ra.resume_version_id = p_resume_version_id
      AND ra.mode = p_mode
      AND ra.job_content_hash = p_job_content_hash
      AND ra.analysis_version = p_analysis_version;
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_id, true;
END;
$$;

COMMIT;

-- DOWN (manual, not automated):
--   Re-apply migration 038's CREATE OR REPLACE FUNCTION public.upsert_resume_analysis(...) body
--   verbatim (restores the unconditional DO UPDATE and the new-key race it allows — not expected
--   to ever be needed).
