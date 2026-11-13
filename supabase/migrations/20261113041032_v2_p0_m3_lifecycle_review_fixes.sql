-- V2 P0 M3 review fixes.
-- This follow-up migration preserves the byte-for-byte source of the already-applied
-- 20261112185212 migration and hardens its employer lifecycle RPC in place.
-- Legacy employer applications without candidate_application_id remain auditable
-- and transitionable; candidate status synchronization applies only to verified links.
-- Idempotency lookup occurs after the employer application row lock so same-key
-- concurrent retries observe and replay the first committed decision.

CREATE OR REPLACE FUNCTION public.transition_employer_application(
  p_company_id uuid,
  p_application_id uuid,
  p_actor_id uuid,
  p_expected_status text,
  p_new_status text,
  p_reason_code text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member_role text;
  v_eja public.employer_job_applications%ROWTYPE;
  v_submission public.employer_job_submissions%ROWTYPE;
  v_app public.applications%ROWTYPE;
  v_event public.hiring_decision_events%ROWTYPE;
  v_corrects uuid;
  v_candidate_status text;
  v_actor_role text;
  v_action text;
  v_reason_required boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';
  END IF;
  IF p_company_id IS NULL OR p_application_id IS NULL OR p_actor_id IS NULL
     OR p_expected_status IS NULL OR p_new_status IS NULL
     OR p_idempotency_key IS NULL OR length(btrim(p_idempotency_key))=0
     OR length(p_idempotency_key)>200 THEN
    RAISE EXCEPTION 'invalid_transition_request' USING ERRCODE='22023';
  END IF;

  SELECT role INTO v_member_role
  FROM public.company_members
  WHERE company_id=p_company_id AND profile_id=p_actor_id
    AND status='active' AND role IN ('owner','admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'employer_forbidden' USING ERRCODE='42501'; END IF;
  v_actor_role := v_member_role;

  SELECT e.* INTO v_eja
  FROM public.employer_job_applications e
  JOIN public.employer_job_submissions s ON s.id=e.submission_id
  WHERE e.id=p_application_id AND s.company_id=p_company_id
  FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_event
  FROM public.hiring_decision_events
  WHERE company_id=p_company_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_event.subject_type <> 'application'
       OR v_event.employer_application_id <> p_application_id
       OR v_event.new_state <> p_new_status
       OR v_event.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('success',true,'replayed',true,
      'status',v_event.new_state,'eventId',v_event.id);
  END IF;

  IF v_eja.status <> p_expected_status THEN
    RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003';
  END IF;
  IF NOT public.is_valid_employer_application_transition(v_eja.status,p_new_status,'employer') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE='22023';
  END IF;

  v_reason_required :=
    p_new_status='rejected'
    OR (v_eja.status='interviewing' AND p_new_status='shortlisted')
    OR (v_eja.status='rejected' AND p_new_status='reviewing');
  IF v_reason_required AND p_reason_code IS NULL THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE='22023';
  END IF;
  IF p_reason_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.hiring_decision_reason_codes WHERE reason_code=p_reason_code
  ) THEN RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_submission FROM public.employer_job_submissions
  WHERE id=v_eja.submission_id AND company_id=p_company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001'; END IF;

  -- Legacy employer applications predate candidate_application_id. They
  -- remain manageable and auditable, but candidate-side state synchronization
  -- is applied only when a verified direct-application link exists.
  IF v_eja.candidate_application_id IS NOT NULL THEN
    SELECT * INTO v_app FROM public.applications
    WHERE id=v_eja.candidate_application_id
    FOR UPDATE;
    IF NOT FOUND OR v_app.profile_id IS DISTINCT FROM v_eja.candidate_profile_id
       OR v_app.application_channel <> 'remotematch_direct' THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
  END IF;

  IF v_eja.status='rejected' AND p_new_status='reviewing' THEN
    SELECT id INTO v_corrects FROM public.hiring_decision_events
    WHERE employer_application_id=v_eja.id AND action='application_rejected'
    ORDER BY created_at DESC LIMIT 1;
    IF v_corrects IS NULL THEN RAISE EXCEPTION 'rejection_event_missing' USING ERRCODE='P0001'; END IF;
  END IF;

  v_candidate_status := CASE p_new_status
    WHEN 'submitted' THEN 'applied'
    WHEN 'reviewing' THEN 'applied'
    WHEN 'shortlisted' THEN 'applied'
    WHEN 'interviewing' THEN 'interview'
    WHEN 'offered' THEN 'offer'
    WHEN 'rejected' THEN 'rejected'
    WHEN 'hired' THEN 'hired'
    WHEN 'withdrawn' THEN 'withdrawn'
    WHEN 'offer_declined' THEN 'offer_declined'
    ELSE NULL END;

  IF v_candidate_status IS NULL THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE='22023'; END IF;

  IF v_eja.candidate_application_id IS NOT NULL AND v_app.status <> v_candidate_status THEN
    IF v_eja.status='rejected' AND p_new_status='reviewing' THEN
      IF NOT public.is_valid_linked_application_transition(v_app.status,v_candidate_status,'system_correction') THEN
        RAISE EXCEPTION 'candidate_state_conflict' USING ERRCODE='P0001';
      END IF;
    ELSE
      IF NOT public.is_valid_linked_application_transition(v_app.status,v_candidate_status,'employer_sync') THEN
        RAISE EXCEPTION 'candidate_state_conflict' USING ERRCODE='P0001';
      END IF;
    END IF;
  END IF;

  v_action := CASE
    WHEN v_eja.status='rejected' AND p_new_status='reviewing' THEN 'rejection_reconsidered'
    WHEN p_new_status='rejected' THEN 'application_rejected'
    WHEN p_new_status='hired' THEN 'application_hired'
    WHEN p_new_status='interviewing' THEN 'interview_started'
    WHEN p_new_status='offered' THEN 'offer_extended'
    WHEN p_new_status='shortlisted' THEN 'shortlisted'
    WHEN p_new_status='reviewing' THEN 'review_started'
    ELSE 'application_status_changed'
  END;

  UPDATE public.employer_job_applications
  SET status=p_new_status,updated_at=now()
  WHERE id=v_eja.id;

  INSERT INTO public.hiring_decision_events(
    company_id,submission_id,opportunity_id,candidate_profile_id,
    subject_type,employer_application_id,actor_id,actor_role,action,
    reason_code,previous_state,new_state,corrects_event_id,idempotency_key
  ) VALUES (
    p_company_id,v_eja.submission_id,v_eja.opportunity_id,v_eja.candidate_profile_id,
    'application',v_eja.id,p_actor_id,v_actor_role,v_action,
    p_reason_code,v_eja.status,p_new_status,v_corrects,p_idempotency_key
  ) RETURNING * INTO v_event;

  IF v_eja.candidate_application_id IS NOT NULL AND v_app.status <> v_candidate_status THEN
    UPDATE public.applications
    SET status=v_candidate_status,updated_at=now()
    WHERE id=v_app.id;

    INSERT INTO public.application_events(
      application_id,event_type,event_payload,employer_application_id
    ) VALUES (
      v_app.id,'status_changed',
      jsonb_build_object('fromStatus',v_app.status,'toStatus',v_candidate_status,
                         'source','employer_sync','employer_application_id',v_eja.id),
      v_eja.id
    );
  END IF;

  RETURN jsonb_build_object('success',true,'replayed',false,
    'status',p_new_status,'candidateStatus',CASE WHEN v_eja.candidate_application_id IS NOT NULL THEN v_candidate_status ELSE NULL END,'eventId',v_event.id);
END;
$$;

NOTIFY pgrst, 'reload schema';
