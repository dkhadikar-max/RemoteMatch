-- ==============================================================================
-- Resume Intelligence (PR B) — ownership-aware finalization, splitting "finalize"
-- out of upsert_resume_analysis() into its own, narrower RPC.
--
-- NOT APPLIED to any shared/persistent database. Local worktree only. A new forward
-- migration, per this project's established discipline of never editing an
-- already-applied migration in place -- even though 036-040 are themselves still
-- unapplied anywhere real, each prior fix (037/038/039) was already its own file for
-- the same reason: keep each concern's own history separately auditable.
--
-- FINDING (Stage 6 delivery review + follow-up read-only trace, 2026-11-02):
-- upsert_resume_analysis() enforces NO attempt ownership at finalization time. Its
-- only write-guard is `NOT (existing.status='success' AND EXCLUDED.status<>'success')`
-- -- this protects exactly one direction (an existing success is never clobbered by a
-- LATER non-success write). Every other combination is unprotected: a stale worker's
-- own 'success' write can silently overwrite a NEWER attempt's success, pending, or
-- unavailable row, incrementing attempt_number again on top of it. Confirmed by
-- tracing all 4 real finalize call sites in resume-intelligence-service.ts (each
-- transitions pending -> success|unavailable for the SAME attempt that request itself
-- claimed) -- none of them, nor the RPC itself, ever checks that attempt_number is
-- still current before writing.
--
-- FIX: a new, narrower finalize_resume_analysis(analysis_id, expected_attempt_number,
-- ...) RPC. upsert_resume_analysis() keeps the claim/reclaim/retry responsibility
-- (MAY reclaim a stale/terminal row, MUST increment attempt_number on every
-- successful claim) -- its result-writing parameters are removed (migration 040's own
-- "vestigial parameters" note, now an approved step, not just an idea) since every
-- real call site only ever claims with status='pending'/result=NULL/etc. Finalize
-- (MUST NOT reclaim, MUST NOT increment attempt_number, fails closed on any mismatch)
-- becomes its own function, keyed by analysis_id directly rather than the composite
-- dedup key, verifying `attempt_number = p_expected_attempt_number AND status =
-- 'pending'` atomically under the SAME row lock as the write itself.
--
-- Two safeguards locked into this design before implementation (2026-11-02):
--   A. finalize_resume_analysis() accepts only p_status IN ('success','unavailable')
--      -- confirmed by the same trace that 'insufficient_input' never reaches a
--      finalize call (it returns at step 2, before any claim exists).
--   B. Provider-spend accounting (ai_call_events/ai_spend_ledger, written inside
--      runModelCall() at step 6) is untouched by this migration and already
--      structurally independent of finalize's own outcome -- that recording happens
--      strictly BEFORE finalize is ever reached, so a stale_attempt rejection here can
--      never erase or reverse an actual provider call. No change needed for this.
-- refund_resume_analysis() also needs NO change: its ownership check already never
-- depends on current status/attempt_number (historical-refund-by-design), so a
-- refund for attempt 1 keeps working after attempt 2 acquires the row.
-- ==============================================================================

\set ON_ERROR_STOP on
BEGIN;

-- ------------------------------------------------------------------------------
-- 1. upsert_resume_analysis() trimmed to claim-only. Every real call site ever
--    passed p_status='pending'/p_result=NULL/p_source_ai=false/p_model=NULL/
--    p_prompt_tokens=NULL/p_completion_tokens=NULL/p_cost_usd=NULL -- those are now
--    hardcoded internally rather than accepted as parameters, so a caller can no
--    longer even ATTEMPT to write a result through this function. Claim/reclaim
--    logic (the two early-return rejection guards, the INSERT...ON CONFLICT DO
--    UPDATE with its WHERE guard, attempt_number increment, created_at refresh) is
--    otherwise completely unchanged from migration 040 -- this is a parameter trim,
--    not a behavior change to the claim path itself.
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric);

CREATE FUNCTION public.upsert_resume_analysis(
  p_resume_version_id UUID,
  p_mode              TEXT,
  p_opportunity_id    TEXT,
  p_job_content_hash  TEXT,
  p_analysis_version  TEXT
)
RETURNS TABLE (id UUID, wrote BOOLEAN, attempt_number INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_existing RECORD;
  v_id       UUID;
  v_attempt  INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_mode NOT IN ('general', 'target_job') THEN
    RAISE EXCEPTION 'invalid mode' USING ERRCODE = '23514';
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

  IF v_existing.id IS NOT NULL AND v_existing.status = 'success' THEN
    -- A prior success is never clobbered by a new claim attempt for the same key.
    -- Rejection: attempt_number/created_at untouched, reported as-is.
    RETURN QUERY SELECT v_existing.id, false, v_existing.attempt_number;
    RETURN;
  END IF;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'pending'
     AND v_existing.created_at > now() - interval '3 minutes' THEN
    -- Another request already claimed this exact key and is still inside its 3-minute window.
    -- Rejection: attempt_number/created_at untouched, reported as-is.
    RETURN QUERY SELECT v_existing.id, false, v_existing.attempt_number;
    RETURN;
  END IF;

  -- Successful-claim path (fresh key, terminal-row retry, or stale-pending
  -- recovery -- all three reach here identically). attempt_number/created_at are
  -- refreshed ONLY here, never on a rejection above. Always claims as 'pending' --
  -- finalize_resume_analysis() is the only path that ever writes a terminal status.
  INSERT INTO public.resume_analyses (
    profile_id, resume_version_id, mode, opportunity_id, job_content_hash, analysis_version,
    status, result, source_ai, model, prompt_tokens, completion_tokens, cost_usd,
    created_at, updated_at, attempt_number
  )
  VALUES (
    v_uid, p_resume_version_id, p_mode, p_opportunity_id, p_job_content_hash, p_analysis_version,
    'pending', NULL, false, NULL, NULL, NULL, NULL,
    now(), now(), 1
  )
  ON CONFLICT (profile_id, resume_version_id, mode, job_content_hash, analysis_version) DO UPDATE SET
    opportunity_id    = EXCLUDED.opportunity_id,
    status            = 'pending',
    result            = NULL,
    source_ai         = false,
    model             = NULL,
    prompt_tokens     = NULL,
    completion_tokens = NULL,
    cost_usd          = NULL,
    updated_at        = now(),
    created_at        = now(),
    attempt_number    = resume_analyses.attempt_number + 1
  WHERE NOT (
    resume_analyses.status = 'success'
  ) AND NOT (
    resume_analyses.status = 'pending'
    AND resume_analyses.created_at > now() - interval '3 minutes'
  )
  RETURNING resume_analyses.id, resume_analyses.attempt_number INTO v_id, v_attempt;

  IF v_id IS NULL THEN
    -- The WHERE guard excluded our write: a sibling transaction committed its own claim for
    -- this exact key between our SELECT ... FOR UPDATE (which found nothing, on a brand-new
    -- key) and our INSERT. Re-read the now-genuinely-existing row.
    SELECT ra.id, ra.attempt_number INTO v_id, v_attempt
    FROM public.resume_analyses ra
    WHERE ra.profile_id = v_uid
      AND ra.resume_version_id = p_resume_version_id
      AND ra.mode = p_mode
      AND ra.job_content_hash = p_job_content_hash
      AND ra.analysis_version = p_analysis_version;
    RETURN QUERY SELECT v_id, false, v_attempt;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_id, true, v_attempt;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_resume_analysis(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_resume_analysis(uuid, text, text, text, text) TO authenticated;

-- ------------------------------------------------------------------------------
-- 2. finalize_resume_analysis(p_analysis_id, p_expected_attempt_number, ...) --
--    completes ONLY the attempt that currently owns the claim. Keyed by analysis_id
--    directly (the caller already holds it from its own earlier claim), not the
--    composite dedup key. Never reclaims, never increments attempt_number, never
--    refreshes created_at's "claim ownership" meaning -- those stay exclusively
--    upsert_resume_analysis()'s responsibility. Fails closed (stale_attempt) rather
--    than silently writing whenever ownership no longer holds.
-- ------------------------------------------------------------------------------
CREATE FUNCTION public.finalize_resume_analysis(
  p_analysis_id             UUID,
  p_expected_attempt_number INT,
  p_status                  TEXT,
  p_result                  JSONB,
  p_source_ai               BOOLEAN,
  p_model                   TEXT,
  p_prompt_tokens           INTEGER,
  p_completion_tokens       INTEGER,
  p_cost_usd                NUMERIC
)
RETURNS TABLE (id UUID, finalized BOOLEAN, result TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_existing RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  -- Safeguard A (locked 2026-11-02): only the 2 statuses any real caller ever uses.
  -- 'insufficient_input' never reaches a finalize call (returns at step 2, before any
  -- claim exists) and 'pending' is exclusively upsert_resume_analysis()'s own value.
  IF p_status NOT IN ('success', 'unavailable') THEN
    RAISE EXCEPTION 'invalid status for finalize' USING ERRCODE = '23514';
  END IF;
  -- Hardening: a NULL p_expected_attempt_number must never reach the ownership check below.
  -- `<>` against NULL evaluates to NULL (SQL three-valued logic), and `NULL OR false` is also
  -- NULL -- which PL/pgSQL's IF treats as FALSE, silently SKIPPING the rejection branch and
  -- falling through to the UPDATE whenever the row happens to still be 'pending'. Reject NULL
  -- explicitly and unconditionally, before that comparison is ever evaluated, so this can never
  -- depend on the application layer never passing one.
  IF p_expected_attempt_number IS NULL THEN
    RETURN QUERY SELECT p_analysis_id, false, 'invalid_attempt'::text;
    RETURN;
  END IF;

  -- Column reference qualified with the table name (ra.id, not bare id) -- the SAME 42702
  -- ambiguity defect migration 038 fixed in upsert_resume_analysis() recurs here for the same
  -- reason: this function's own RETURNS TABLE (id UUID, ...) makes `id` an implicit PL/pgSQL
  -- variable that collides with a bare `id` column reference. Caught live (2026-11-02) by this
  -- exact live suite, not by the static suite, which only checks source-text shape, not whether
  -- Postgres can actually parse it.
  SELECT * INTO v_existing FROM public.resume_analyses ra WHERE ra.id = p_analysis_id AND ra.profile_id = v_uid FOR UPDATE;

  IF v_existing.id IS NULL THEN
    RETURN QUERY SELECT p_analysis_id, false, 'invalid_attempt'::text;
    RETURN;
  END IF;

  -- The ownership check: BOTH conditions, atomically, under the same row lock as the
  -- write below. attempt_number must still be the one this caller's own claim holds,
  -- AND the row must still actually be 'pending' (never already finalized by someone
  -- else for this exact attempt, and never a row that has moved on to a newer claim).
  -- IS DISTINCT FROM (not <>) so a NULL attempt_number on the row -- never expected in
  -- practice, since the column is NOT NULL, but a belt-and-suspenders match for the same
  -- NULL-logic hazard just closed above -- still correctly rejects rather than silently
  -- falling through.
  IF v_existing.attempt_number IS DISTINCT FROM p_expected_attempt_number OR v_existing.status <> 'pending' THEN
    RETURN QUERY SELECT v_existing.id, false, 'stale_attempt'::text;
    RETURN;
  END IF;

  -- Safeguard B (locked 2026-11-02): this UPDATE is the only place the result/model/
  -- token/cost fields are written, inside the SAME transaction as the ownership check
  -- above -- a stale caller never reaches this statement at all. Provider-spend
  -- accounting (ai_call_events/ai_spend_ledger) is entirely separate, already written
  -- by the time this function is ever called, and is not touched here in either
  -- direction.
  -- WHERE resume_analyses.id (qualified, not bare id) -- same 42702 hazard as the SELECT above.
  UPDATE public.resume_analyses SET
    status            = p_status,
    result            = p_result,
    source_ai         = p_source_ai,
    model             = p_model,
    prompt_tokens     = p_prompt_tokens,
    completion_tokens = p_completion_tokens,
    cost_usd          = p_cost_usd,
    updated_at        = now()
  WHERE resume_analyses.id = p_analysis_id;

  RETURN QUERY SELECT v_existing.id, true, 'finalized'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_resume_analysis(uuid, int, text, jsonb, boolean, text, integer, integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_resume_analysis(uuid, int, text, jsonb, boolean, text, integer, integer, numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==============================================================================
-- DOWN (manual, not automated):
--   DROP FUNCTION IF EXISTS public.finalize_resume_analysis(uuid, int, text, jsonb, boolean, text, integer, integer, numeric);
--   DROP FUNCTION IF EXISTS public.upsert_resume_analysis(uuid, text, text, text, text);
--   -- Restore migration 040's 12-param upsert_resume_analysis(...) body if rolling back
--   -- (claim + finalize combined, with the no-ownership-guard gap this migration fixes).
-- ==============================================================================
