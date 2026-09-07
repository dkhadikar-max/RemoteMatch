-- ==============================================================================
-- RemoteMatch — 008: replace the reserved SQLSTATE used for status_conflict
--
-- 007_application_transition_cas.sql raised the new `status_conflict` error
-- with `USING ERRCODE = '40001'` (the standard, reserved PostgreSQL
-- serialization_failure class). Observed behavior: a request hitting this
-- specific path took ~125 seconds before finally surfacing as a generic 500,
-- while every other custom exception in the same function
-- (application_not_found -> 'P0002', invalid_transition/invalid_status ->
-- '22023') returns immediately. That strongly implicates the reserved
-- SQLSTATE '40001' as the cause — some layer in the request/database stack
-- appears to treat it specially (its exact identity is not established here,
-- and the fix does not depend on knowing it) — but the fix does not require
-- knowing exactly which layer: just stop using a reserved, semantically-
-- loaded class for an application-level error.
--
-- Fix: use a custom, non-reserved SQLSTATE from the same 'P000x' convention
-- already established for application_not_found ('P0002') -> 'P0003' for
-- status_conflict. The error NAME ('status_conflict') and everything else —
-- transition rules, CAS logic, locking, the API's mapping to HTTP 409 — are
-- unchanged.
-- ==============================================================================

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
  --    ERRCODE changed from '40001' to 'P0003' by this migration — see
  --    header. The error NAME is unchanged.
  IF v_app.status <> p_expected_status THEN
    RAISE EXCEPTION 'status_conflict' USING ERRCODE = 'P0003',
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
