-- ==============================================================================
-- Resume Intelligence (PR B) — durable reconciliation sweep for orphaned per-attempt
-- quota reservations (the operational-risk follow-up from the Stage 6 delivery
-- review, specified 2026-11-02, implemented this same day once ownership-aware
-- finalization — migration 041 — closed the stale-worker prerequisite).
--
-- NOT APPLIED to any shared/persistent database. Local worktree only.
--
-- REVISION TO THE ORIGINAL SPECIFICATION, found during THIS implementation pass:
-- the spec as written said this sweep would "call the existing refund_resume_
-- analysis() RPC using the original attempt identifiers," requiring no new
-- migration at all. That assumption does not hold. refund_resume_analysis()
-- derives its caller's identity from auth.uid() and checks ownership against it
-- -- by design, since every other RPC in this project is scoped to exactly one
-- authenticated user's own session. A reconciliation sweep is categorically
-- different: it must act across MANY different users' orphaned rows in one run,
-- and there is no single "logged in user" it can authenticate as to satisfy that
-- check for each of them in turn. This migration instead adds ONE new,
-- deliberately narrow, service-role-only function that performs the EXACT SAME
-- refund logic as refund_resume_analysis() (same idempotency check, same
-- cross-day usage_date safeguard, same event shape and reason field) but scans
-- across all profiles rather than being scoped to one caller's own auth.uid().
--
-- Detection (3 eligibility branches, matching the locked design exactly, zero new
-- columns needed -- all of this is derivable from migration 040's own schema):
--   (a) Superseded attempt (orphan.attempt_number < resume_analyses.attempt_number)
--       -- structurally abandoned, no grace period needed.
--   (b) Current attempt, terminal failure (status IN ('unavailable','insufficient_
--       input')), finalized more than 10 minutes ago -- avoids racing an in-flight
--       finalize that hasn't run yet.
--   (c) Current attempt, still 'pending', created more than 60 minutes ago --
--       deliberately far past the 3-minute reclaim window, so nobody is still
--       plausibly about to reclaim it through the normal path.
-- Never touches status='success' (correctly never refunded) or a fresh live
-- attempt within its own grace window (could still be legitimately in-flight).
--
-- Lock ordering matches reserve_resume_analysis()/refund_resume_analysis()
-- exactly -- profiles FIRST, then the specific resume_analyses row -- to avoid a
-- deadlock against a live request processing the SAME row concurrently with a
-- sweep run. Each candidate is processed inside its own PL/pgSQL exception
-- block (an implicit savepoint): one failed candidate is recorded and the loop
-- continues, never aborting the whole sweep (Deep's explicit requirement) --
-- while every row this run DID successfully process still commits together when
-- the function itself returns without an uncaught exception.
-- ==============================================================================

\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION public.reconcile_resume_quota_orphans(p_dry_run boolean DEFAULT false)
RETURNS TABLE (analysis_id UUID, attempt_number INT, reconciled BOOLEAN, detail TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orphan RECORD;
  v_profile_found BOOLEAN;
  v_already_refunded BOOLEAN;
BEGIN
  -- Restricted to service_role only -- this function scans and writes across
  -- EVERY user's data, categorically unlike every other RPC in this project
  -- (which are all scoped to auth.uid()). No authenticated/anon caller, however
  -- it might otherwise be invoked, can ever get past this check.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'reconcile_resume_quota_orphans is service-role only' USING ERRCODE = '42501';
  END IF;

  -- Plain, UNLOCKED detection read. Real locks are acquired per-candidate below,
  -- in the same order reserve/refund themselves use -- this cursor snapshot is
  -- deliberately not authoritative; everything it finds is re-verified under
  -- lock before any write.
  FOR v_orphan IN
    SELECT r.analysis_id, r.attempt_number, r.usage_date AS reserved_usage_date, ra.profile_id
    FROM public.resume_quota_events r
    JOIN public.resume_analyses ra ON ra.id = r.analysis_id
    WHERE r.event_type = 'reserved'
      AND NOT EXISTS (
        SELECT 1 FROM public.resume_quota_events r2
        WHERE r2.analysis_id = r.analysis_id AND r2.attempt_number = r.attempt_number AND r2.event_type = 'refunded'
      )
      AND (
        r.attempt_number < ra.attempt_number
        OR (r.attempt_number = ra.attempt_number AND ra.status IN ('unavailable', 'insufficient_input') AND ra.updated_at < now() - interval '10 minutes')
        OR (r.attempt_number = ra.attempt_number AND ra.status = 'pending' AND ra.created_at < now() - interval '60 minutes')
      )
  LOOP
    IF p_dry_run THEN
      RETURN QUERY SELECT v_orphan.analysis_id, v_orphan.attempt_number, false, 'dry_run'::text;
      CONTINUE;
    END IF;

    BEGIN
      -- Lock order: profiles FIRST, then the specific resume_analyses row --
      -- matches reserve_resume_analysis()/refund_resume_analysis() exactly, so
      -- this sweep can never deadlock against a live request on the same row.
      SELECT true INTO v_profile_found FROM public.profiles WHERE id = v_orphan.profile_id FOR UPDATE;
      IF v_profile_found IS NULL THEN
        RETURN QUERY SELECT v_orphan.analysis_id, v_orphan.attempt_number, false, 'profile_not_found'::text;
        CONTINUE;
      END IF;
      PERFORM 1 FROM public.resume_analyses WHERE id = v_orphan.analysis_id FOR UPDATE;

      -- Re-verify idempotency under the lock -- time has passed since the
      -- unlocked detection read above, and this is the real safety net: running
      -- this sweep repeatedly, or two overlapping runs concurrently, must never
      -- double-refund the same attempt.
      -- Column references qualified with the table alias (rqe.analysis_id, not bare
      -- analysis_id) -- the SAME 42702 ambiguity class migrations 038 and 041 each hit before:
      -- this function's own RETURNS TABLE (analysis_id UUID, attempt_number INT, ...) makes both
      -- names implicit PL/pgSQL variables that collide with a bare column reference. Caught live
      -- (2026-11-02) by this exact live suite -- and correctly isolated to just this one
      -- candidate by the EXCEPTION WHEN OTHERS block around it, proving that isolation works.
      SELECT EXISTS (
        SELECT 1 FROM public.resume_quota_events rqe
        WHERE rqe.analysis_id = v_orphan.analysis_id AND rqe.attempt_number = v_orphan.attempt_number AND rqe.event_type = 'refunded'
      ) INTO v_already_refunded;

      IF v_already_refunded THEN
        RETURN QUERY SELECT v_orphan.analysis_id, v_orphan.attempt_number, false, 'already_refunded'::text;
      ELSE
        -- Same cross-day safety as refund_resume_analysis(): only decrement if
        -- the CURRENT profile usage_date still matches the ORIGINAL
        -- reservation's own usage_date. A no-op UPDATE (0 rows touched) when it
        -- doesn't -- the exact same behavior as refund_resume_analysis()'s own
        -- IF branch, just expressed as a conditional UPDATE instead of an IF.
        UPDATE public.profiles SET daily_resume_analyses_count = GREATEST(0, daily_resume_analyses_count - 1)
          WHERE id = v_orphan.profile_id AND usage_date = v_orphan.reserved_usage_date;

        INSERT INTO public.resume_quota_events (analysis_id, attempt_number, event_type, usage_date, reason)
          VALUES (v_orphan.analysis_id, v_orphan.attempt_number, 'refunded', v_orphan.reserved_usage_date, 'reconciliation_sweep');

        RETURN QUERY SELECT v_orphan.analysis_id, v_orphan.attempt_number, true, 'refunded'::text;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One failed candidate must never abort the whole sweep (Deep's explicit
      -- requirement). This EXCEPTION block is an implicit savepoint: it rolls
      -- back only this iteration's own (uncommitted) work, then lets the LOOP
      -- continue to the next candidate. Everything already returned by earlier
      -- iterations still commits together once the whole function returns
      -- normally -- nothing here aborts the outer, single-call transaction.
      RETURN QUERY SELECT v_orphan.analysis_id, v_orphan.attempt_number, false, ('error: ' || SQLERRM)::text;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_resume_quota_orphans(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_resume_quota_orphans(boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==============================================================================
-- DOWN (manual, not automated):
--   DROP FUNCTION IF EXISTS public.reconcile_resume_quota_orphans(boolean);
-- ==============================================================================
