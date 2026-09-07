-- ==============================================================================
-- RemoteMatch — 006: server-authoritative application lifecycle
-- (RemoteMatch Outcome Data Foundation, P0)
--
-- Makes `applications.status` progression (interested -> applied -> interview
-- -> offer/rejected/withdrawn, plus archived as a display-only state) a real,
-- durable, server-enforced state machine instead of the client-local
-- `mock-seed.ts` / localStorage bookkeeping it has been until now. Every
-- transition is atomic with a durable `application_events` row.
--
-- Does NOT touch: matching/scoring, swipe mechanics, monetization/quota
-- rules, SEO. `swipes.decision_snapshot` (the score-at-decision-time record)
-- is untouched — this migration only adds what happens to an application
-- AFTER it exists.
--
-- ------------------------------------------------------------------------------
-- FINDING BEING CLOSED IN THIS SAME MIGRATION (by explicit requirement — this
-- must not ship as a later cleanup pass):
--
-- 004_fix_applications_grant.sql granted `authenticated` a raw
-- `UPDATE (status, notes, applied_at, updated_at) ON applications`, RLS-scoped
-- to the caller's own row, on the stated basis that "application status
-- changes are still client-local" at the time. They no longer are: from this
-- migration on, `transition_application_status()` is the only path that may
-- change `applications.status`. Leaving the raw grant in place would let any
-- verified user's browser call `supabase.from('applications').update(...)`
-- directly over the REST API and silently set an outcome status with no
-- corresponding `application_events` row — corrupting exactly the dataset
-- this migration exists to produce. The grant is revoked at the bottom of
-- this file, in the same migration that introduces the RPC replacing it.
-- ------------------------------------------------------------------------------

-- ------------------------------------------------------------------------------
-- 1. STATUS ENUM: add `withdrawn` as a distinct, genuine outcome, separate
--    from `archived` (a display/organization state — see the transition
--    function below for the full state machine this enables).
-- ------------------------------------------------------------------------------
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD CONSTRAINT applications_status_check
  CHECK (status IN ('interested', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'archived'));

-- ------------------------------------------------------------------------------
-- 2. TRANSITION TABLE (pure function, no side effects — trivially unit-testable
--    in isolation and reused by the RPC below).
--
--    interested -> applied -> interview -> offer
--                           -> rejected
--                 applied -> rejected
--    {interested, applied, interview} -> withdrawn
--    {interested, applied, interview, offer, rejected, withdrawn} -> archived
--
--    offer / rejected / withdrawn are genuine terminal OUTCOMES: none of them
--    transition to anything except `archived`. `archived` is a display state,
--    not an outcome, and is explicitly the one path allowed OUT of a terminal
--    state — the event history (not applications.status) remains the
--    authoritative record of what the real outcome was; see
--    get_application_outcome() below for how that's recovered.
--    `archived` itself is absorbing (no transitions out) in this version —
--    "un-archiving" is not a requirement of this milestone.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_application_transition(
  p_from TEXT,
  p_to TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_from = p_to THEN false
    WHEN p_from = 'interested' AND p_to IN ('applied', 'withdrawn', 'archived') THEN true
    WHEN p_from = 'applied' AND p_to IN ('interview', 'rejected', 'withdrawn', 'archived') THEN true
    WHEN p_from = 'interview' AND p_to IN ('offer', 'rejected', 'withdrawn', 'archived') THEN true
    WHEN p_from = 'offer' AND p_to = 'archived' THEN true
    WHEN p_from = 'rejected' AND p_to = 'archived' THEN true
    WHEN p_from = 'withdrawn' AND p_to = 'archived' THEN true
    ELSE false
  END;
$$;

-- ------------------------------------------------------------------------------
-- 3. THE ONLY MUTATION PATH: atomic status transition + durable event, row-
--    locked the same way the quota RPCs lock `profiles` (see
--    reserve_right_swipe in 003_security_remediation.sql) so two concurrent
--    transitions on the same application serialize rather than race.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_application_status(
  p_opportunity_id TEXT,
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

  SELECT * INTO v_app FROM applications
    WHERE profile_id = v_uid AND opportunity_id = p_opportunity_id
    FOR UPDATE;

  -- No INSERT path here by design: a row only exists for this
  -- (profile_id, opportunity_id) pair because finalize_interested_swipe()
  -- already created it. Ownership check IS the existence check — this RPC
  -- only ever transitions an application the caller already owns.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_valid_application_transition(v_app.status, p_new_status) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '22023',
      DETAIL = format('from %s to %s', v_app.status, p_new_status);
  END IF;

  UPDATE applications SET
    status = p_new_status,
    notes = COALESCE(p_notes, notes),
    applied_at = CASE WHEN p_new_status = 'applied' AND applied_at IS NULL THEN now() ELSE applied_at END,
    updated_at = now()
  WHERE id = v_app.id;

  -- Atomic with the status write above — same function, same transaction.
  -- The event's own created_at IS the authoritative "entered this state at"
  -- timestamp; it is deliberately not duplicated into event_payload.
  INSERT INTO application_events (application_id, event_type, event_payload)
  VALUES (v_app.id, 'status_changed', jsonb_build_object(
    'fromStatus', v_app.status, 'toStatus', p_new_status, 'notes', p_notes
  ));

  RETURN jsonb_build_object('success', true, 'status', p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_application_status(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_application_status(TEXT, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 4. FEEDBACK: replaces the (unauthenticated, non-persisting —
--    localStore.recordFeedback() no-ops server-side) body of
--    /api/applications/feedback. Represented as an application_events row
--    rather than a separate `application_feedback` table row — it has a real
--    call site (the match page's "did you apply?" prompt), so per the
--    stated bar it belongs in P0, but it does not need its own parallel
--    history table alongside application_events for what is, at its core,
--    a dated event with a payload. `application_feedback` is left in the
--    schema, unused; no demonstrated need to write to it.
--
--    When did_apply = 'applied', this also performs the status transition to
--    'applied' in the same call/transaction — one user action, one durable
--    fact, not two round trips that could partially fail.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_application_feedback(
  p_opportunity_id TEXT,
  p_did_apply TEXT,
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
  IF p_did_apply IS NULL OR p_did_apply NOT IN
    ('applied', 'did_not_apply', 'not_eligible', 'expired', 'changed_mind')
  THEN
    RAISE EXCEPTION 'invalid_feedback' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_app FROM applications
    WHERE profile_id = v_uid AND opportunity_id = p_opportunity_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO application_events (application_id, event_type, event_payload)
  VALUES (v_app.id, 'feedback_submitted', jsonb_build_object(
    'didApply', p_did_apply, 'notes', p_notes
  ));

  IF p_did_apply = 'applied' AND public.is_valid_application_transition(v_app.status, 'applied') THEN
    UPDATE applications SET
      status = 'applied',
      notes = COALESCE(p_notes, notes),
      applied_at = CASE WHEN applied_at IS NULL THEN now() ELSE applied_at END,
      updated_at = now()
    WHERE id = v_app.id;

    INSERT INTO application_events (application_id, event_type, event_payload)
    VALUES (v_app.id, 'status_changed', jsonb_build_object(
      'fromStatus', v_app.status, 'toStatus', 'applied', 'notes', p_notes
    ));
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_application_feedback(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_application_feedback(TEXT, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 4b. NOTES-ONLY EDIT: deliberately separate from transition_application_status
--     rather than allowing a same-status "transition" through it — a no-op
--     status transition has no well-defined meaning in the state machine
--     (is_valid_application_transition() correctly rejects p_from = p_to),
--     and a notes edit is not itself a lifecycle event. Recorded as
--     `note_added` (already part of the application_events event_type enum),
--     kept distinct from `status_changed` so the event history's transition
--     sequence stays exactly the sequence of real state changes.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_application_notes(
  p_opportunity_id TEXT,
  p_notes TEXT
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

  SELECT * INTO v_app FROM applications
    WHERE profile_id = v_uid AND opportunity_id = p_opportunity_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'application_not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE applications SET notes = p_notes, updated_at = now() WHERE id = v_app.id;

  INSERT INTO application_events (application_id, event_type, event_payload)
  VALUES (v_app.id, 'note_added', jsonb_build_object('notes', p_notes));

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.update_application_notes(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_application_notes(TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 5. OUTCOME RESOLUTION: `applications.status` alone is not enough once
--    `archived` is reachable from a terminal state — an archived row that was
--    actually rejected must still resolve to "rejected" for outcome analysis
--    (explicit requirement: "the analytics layer can still identify the
--    actual outcome as rejected, while the current UI state is archived").
--    This is the minimum read-side piece needed to satisfy that; it is not
--    an analytics dashboard (that's P1) — just the correct query, expressed
--    once, so every consumer (including the P0 integrity check itself) uses
--    the same definition of "true outcome" instead of re-deriving it ad hoc.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_application_outcome(p_application_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT event_payload->>'toStatus'
      FROM application_events
      WHERE application_id = p_application_id
        AND event_type = 'status_changed'
        AND event_payload->>'toStatus' IN ('offer', 'rejected', 'withdrawn')
      ORDER BY created_at DESC
      LIMIT 1
    ),
    (SELECT status FROM applications WHERE id = p_application_id)
  );
$$;

-- ------------------------------------------------------------------------------
-- 6. CLOSE THE LIVE BYPASS (see header) — now that the RPC above is the
--    complete replacement, the direct table grant has no remaining purpose.
--    SECURITY DEFINER functions do not need this grant to do their work.
-- ------------------------------------------------------------------------------
REVOKE UPDATE ON applications FROM authenticated, anon;
