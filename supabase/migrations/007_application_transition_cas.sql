-- ==============================================================================
-- RemoteMatch — 007: compare-and-swap semantics for application transitions
--
-- Fixes a genuine concurrency defect found by test/outcome-lifecycle-suite.ts
-- against 006_outcome_lifecycle.sql: `FOR UPDATE` gives serialization, but
-- serialization is not the same thing as compare-and-swap. Under READ
-- COMMITTED, a `SELECT ... FOR UPDATE` that blocked on a locked row, once
-- unblocked, re-reads the row's just-committed values rather than the
-- blocked transaction's original snapshot. So two concurrent requests
-- issued from the SAME observed state (`applied`) — one to `interview`, one
-- to `rejected` — could both succeed: the second one, after the first
-- committed `applied -> interview`, would see the row already at
-- `interview` and legitimately continue `interview -> rejected`. That
-- violates the actual invariant: two competing transitions issued from the
-- same observed state must not both succeed.
--
-- Fix: the caller must state which status it observed
-- (`p_expected_status`), and the RPC now rejects with a distinct
-- `status_conflict` error if the row's actual current status has since
-- diverged from that — standard optimistic-concurrency / compare-and-swap,
-- layered on top of (not instead of) the existing row lock. The row lock
-- still matters: it's what makes the compare-and-swap check itself atomic
-- with the transition it guards, rather than a check-then-act race of its
-- own.
--
-- Does NOT touch: matching/scoring, swipe mechanics, quota/entitlement,
-- Stripe, SEO, job supply, authentication policy. Only
-- transition_application_status() changes — record_application_feedback()
-- and update_application_notes() are untouched (neither one accepts a
-- client-claimed target status to compare against; feedback only ever
-- conditionally cascades toward 'applied' based on whatever the row's
-- actual locked-read status is, which was never subject to this defect).
-- ==============================================================================

-- The old 3-argument signature is a DIFFERENT overload from the new
-- 4-argument one in Postgres — CREATE OR REPLACE would not remove it, and
-- leaving it callable would mean the vulnerable, non-CAS path is still
-- reachable. It must be dropped explicitly, in this same migration.
DROP FUNCTION IF EXISTS public.transition_application_status(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.transition_application_status(
  p_opportunity_id TEXT,
  p_expected_status TEXT,
  p_new_status TEXT,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_app applications%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_new_status IS NULL OR p_new_status NOT IN
    ('interested', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'archived')
  THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_expected_status IS NULL OR p_expected_status NOT IN
    ('interested', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'archived')
  THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;

  -- 1. Lock the row.
  SELECT * INTO v_app FROM applications
    WHERE profile_id = v_uid AND opportunity_id = p_opportunity_id
    FOR UPDATE;

  -- 2. Ownership: no INSERT path here by design (see 006) — existence under
  --    this (profile_id, opportunity_id) pair IS the ownership check.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Compare-and-swap: reject if the row has moved since the caller last
  --    observed it, BEFORE checking whether the requested transition would
  --    otherwise be valid. This is what makes two concurrent requests from
  --    the same observed state resolve to exactly one winner.
  IF v_app.status <> p_expected_status THEN
    RAISE EXCEPTION 'status_conflict' USING ERRCODE = '40001',
      DETAIL = format('expected %s but was %s', p_expected_status, v_app.status);
  END IF;

  -- 4. Only now validate the requested transition.
  IF NOT public.is_valid_application_transition(v_app.status, p_new_status) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023',
      DETAIL = format('from %s to %s', v_app.status, p_new_status);
  END IF;

  -- 5/6. Update + durable event, atomic with the check above (same lock,
  -- same transaction, same function).
  UPDATE applications SET
    status = p_new_status,
    notes = COALESCE(p_notes, notes),
    applied_at = CASE WHEN p_new_status = 'applied' AND applied_at IS NULL THEN now() ELSE applied_at END,
    updated_at = now()
  WHERE id = v_app.id;

  INSERT INTO application_events (application_id, event_type, event_payload)
  VALUES (v_app.id, 'status_changed', jsonb_build_object(
    'fromStatus', v_app.status, 'toStatus', p_new_status, 'notes', p_notes
  ));

  RETURN jsonb_build_object('success', true, 'status', p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_application_status(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_application_status(TEXT, TEXT, TEXT, TEXT) TO authenticated;
