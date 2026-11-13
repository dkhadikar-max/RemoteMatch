-- Recovered verbatim from the applied migration ledger on isolated project remotematch-paidtest.
-- Version: 20261112185730
-- Name: v2_p0_m3_link_integrity_guards


-- Correct linked-application id comparison and harden both sides of the link.
CREATE OR REPLACE FUNCTION public.guard_employer_application_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_profile uuid;
  v_opportunity_id uuid;
BEGIN
  IF NEW.candidate_application_id IS NULL THEN RETURN NEW; END IF;
  SELECT a.profile_id,o.id INTO v_profile,v_opportunity_id
  FROM public.applications a
  JOIN public.opportunities o ON o.canonical_id=a.opportunity_id
  WHERE a.id=NEW.candidate_application_id;
  IF NOT FOUND OR v_profile IS DISTINCT FROM NEW.candidate_profile_id
     OR v_opportunity_id IS DISTINCT FROM NEW.opportunity_id THEN
    RAISE EXCEPTION 'candidate_employer_application_link_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS employer_application_link_guard ON public.employer_job_applications;
CREATE TRIGGER employer_application_link_guard
BEFORE INSERT OR UPDATE OF candidate_application_id,candidate_profile_id,opportunity_id
ON public.employer_job_applications
FOR EACH ROW EXECUTE FUNCTION public.guard_employer_application_link();

CREATE OR REPLACE FUNCTION public.guard_linked_candidate_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF (NEW.profile_id IS DISTINCT FROM OLD.profile_id
      OR NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id)
     AND EXISTS (
       SELECT 1 FROM public.employer_job_applications e
       WHERE e.candidate_application_id=OLD.id
     ) THEN
    RAISE EXCEPTION 'linked_candidate_application_identity_is_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS linked_candidate_identity_guard ON public.applications;
CREATE TRIGGER linked_candidate_identity_guard
BEFORE UPDATE OF profile_id,opportunity_id ON public.applications
FOR EACH ROW EXECUTE FUNCTION public.guard_linked_candidate_identity();

CREATE OR REPLACE FUNCTION public.transition_application_status(
  p_opportunity_id text,p_expected_status text,p_new_status text,p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_uid uuid:=auth.uid();
  v_app public.applications%ROWTYPE;
  v_eja public.employer_job_applications%ROWTYPE;
  v_link_id uuid;
  v_canonical text;
  v_expected_candidate_status text;
  v_employer_new_status text;
  v_event_action text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000'; END IF;
  IF p_new_status IS NULL OR p_new_status NOT IN
    ('interested','applied','interview','offer','rejected','withdrawn','archived','offer_declined','hired')
    OR p_expected_status IS NULL OR p_expected_status NOT IN
    ('interested','applied','interview','offer','rejected','withdrawn','archived','offer_declined','hired') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE='22023';
  END IF;

  SELECT e.id INTO v_link_id
  FROM public.applications a
  JOIN public.employer_job_applications e ON e.candidate_application_id=a.id
  WHERE a.profile_id=v_uid AND a.opportunity_id=p_opportunity_id
  LIMIT 1;

  IF v_link_id IS NOT NULL THEN
    PERFORM 1 FROM public.profiles WHERE id=v_uid FOR UPDATE;
    SELECT * INTO v_eja FROM public.employer_job_applications WHERE id=v_link_id FOR UPDATE;
    IF NOT FOUND OR v_eja.candidate_profile_id IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO v_app FROM public.applications
    WHERE id=v_eja.candidate_application_id AND profile_id=v_uid FOR UPDATE;
    IF NOT FOUND OR v_eja.candidate_application_id IS DISTINCT FROM v_app.id
       OR v_app.opportunity_id IS DISTINCT FROM p_opportunity_id THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    SELECT canonical_id INTO v_canonical FROM public.opportunities WHERE id=v_eja.opportunity_id;
    IF v_app.opportunity_id IS DISTINCT FROM v_canonical THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;

    v_expected_candidate_status:=CASE v_eja.status
      WHEN 'submitted' THEN 'applied' WHEN 'reviewing' THEN 'applied' WHEN 'shortlisted' THEN 'applied'
      WHEN 'interviewing' THEN 'interview' WHEN 'offered' THEN 'offer'
      WHEN 'rejected' THEN 'rejected' WHEN 'hired' THEN 'hired'
      WHEN 'withdrawn' THEN 'withdrawn' WHEN 'offer_declined' THEN 'offer_declined'
      ELSE NULL END;
    IF v_expected_candidate_status IS NULL OR v_app.status IS DISTINCT FROM v_expected_candidate_status THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    IF v_app.status<>p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;
    IF NOT public.is_valid_linked_application_transition(v_app.status,p_new_status,'candidate') THEN
      RAISE EXCEPTION 'managed_by_employer_or_invalid_transition' USING ERRCODE='22023';
    END IF;

    v_employer_new_status:=CASE p_new_status
      WHEN 'withdrawn' THEN 'withdrawn' WHEN 'offer_declined' THEN 'offer_declined' ELSE NULL END;
    IF v_employer_new_status IS NULL THEN RAISE EXCEPTION 'managed_by_employer' USING ERRCODE='22023'; END IF;

    UPDATE public.employer_job_applications SET status=v_employer_new_status,updated_at=now() WHERE id=v_eja.id;
    UPDATE public.applications SET status=p_new_status,notes=coalesce(p_notes,notes),updated_at=now() WHERE id=v_app.id;

    INSERT INTO public.application_events(application_id,event_type,event_payload,employer_application_id)
    VALUES(v_app.id,'status_changed',
      jsonb_build_object('fromStatus',v_app.status,'toStatus',p_new_status,'notes',p_notes,
                         'source','candidate','employer_application_id',v_eja.id),v_eja.id);

    v_event_action:=CASE p_new_status WHEN 'withdrawn' THEN 'application_withdrawn'
      WHEN 'offer_declined' THEN 'offer_declined' ELSE 'candidate_status_changed' END;
    INSERT INTO public.hiring_decision_events(
      company_id,submission_id,opportunity_id,candidate_profile_id,subject_type,
      employer_application_id,actor_id,actor_role,action,previous_state,new_state,idempotency_key
    )
    SELECT s.company_id,v_eja.submission_id,v_eja.opportunity_id,v_uid,'application',
      v_eja.id,v_uid,'candidate',v_event_action,v_eja.status,v_employer_new_status,
      'candidate-transition:'||v_eja.id::text||':'||v_employer_new_status
    FROM public.employer_job_submissions s WHERE s.id=v_eja.submission_id;
    RETURN jsonb_build_object('success',true,'status',p_new_status);
  END IF;

  IF p_new_status NOT IN ('interested','applied','interview','offer','rejected','withdrawn','archived')
     OR p_expected_status NOT IN ('interested','applied','interview','offer','rejected','withdrawn','archived') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_app FROM public.applications
  WHERE profile_id=v_uid AND opportunity_id=p_opportunity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;
  IF v_app.status<>p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;
  IF NOT public.is_valid_application_transition(v_app.status,p_new_status) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE='22023';
  END IF;
  UPDATE public.applications SET status=p_new_status,notes=coalesce(p_notes,notes),
    applied_at=CASE WHEN p_new_status='applied' AND applied_at IS NULL THEN now() ELSE applied_at END,
    updated_at=now() WHERE id=v_app.id;
  INSERT INTO public.application_events(application_id,event_type,event_payload)
  VALUES(v_app.id,'status_changed',jsonb_build_object('fromStatus',v_app.status,'toStatus',p_new_status,'notes',p_notes));
  RETURN jsonb_build_object('success',true,'status',p_new_status);
END;
$$;

-- Preserve the employer-side SECURITY INVOKER contract; add canonical identity validation.
CREATE OR REPLACE FUNCTION public.transition_employer_application(
  p_company_id uuid,p_application_id uuid,p_actor_id uuid,
  p_expected_status text,p_new_status text,p_reason_code text,p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_member_role text;
  v_eja public.employer_job_applications%ROWTYPE;
  v_app public.applications%ROWTYPE;
  v_event public.hiring_decision_events%ROWTYPE;
  v_corrects uuid;
  v_canonical text;
  v_candidate_status text;
  v_action text;
  v_reason_required boolean:=false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF p_company_id IS NULL OR p_application_id IS NULL OR p_actor_id IS NULL
     OR p_expected_status IS NULL OR p_new_status IS NULL
     OR p_idempotency_key IS NULL OR length(btrim(p_idempotency_key))=0
     OR length(p_idempotency_key)>200 THEN
    RAISE EXCEPTION 'invalid_transition_request' USING ERRCODE='22023';
  END IF;
  SELECT role INTO v_member_role FROM public.company_members
  WHERE company_id=p_company_id AND profile_id=p_actor_id
    AND status='active' AND role IN ('owner','admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'employer_forbidden' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_event FROM public.hiring_decision_events
  WHERE company_id=p_company_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_event.subject_type<>'application'
       OR v_event.employer_application_id<>p_application_id
       OR v_event.new_state<>p_new_status
       OR v_event.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('success',true,'replayed',true,'status',v_event.new_state,'eventId',v_event.id);
  END IF;

  SELECT e.* INTO v_eja
  FROM public.employer_job_applications e
  JOIN public.employer_job_submissions s ON s.id=e.submission_id
  WHERE e.id=p_application_id AND s.company_id=p_company_id
  FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;
  IF v_eja.status<>p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;
  IF NOT public.is_valid_employer_application_transition(v_eja.status,p_new_status,'employer') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE='22023';
  END IF;

  v_reason_required:=p_new_status='rejected'
    OR (v_eja.status='interviewing' AND p_new_status='shortlisted')
    OR (v_eja.status='rejected' AND p_new_status='reviewing');
  IF v_reason_required AND p_reason_code IS NULL THEN RAISE EXCEPTION 'reason_required' USING ERRCODE='22023'; END IF;
  IF p_reason_code IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.hiring_decision_reason_codes WHERE reason_code=p_reason_code
  ) THEN RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE='22023'; END IF;

  IF v_eja.candidate_application_id IS NULL THEN RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_app FROM public.applications WHERE id=v_eja.candidate_application_id FOR UPDATE;
  SELECT canonical_id INTO v_canonical FROM public.opportunities WHERE id=v_eja.opportunity_id;
  IF NOT FOUND OR v_app.profile_id IS DISTINCT FROM v_eja.candidate_profile_id
     OR v_app.application_channel<>'remotematch_direct'
     OR v_app.opportunity_id IS DISTINCT FROM v_canonical THEN
    RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
  END IF;

  IF v_eja.status='rejected' AND p_new_status='reviewing' THEN
    SELECT id INTO v_corrects FROM public.hiring_decision_events
    WHERE employer_application_id=v_eja.id AND action='application_rejected'
    ORDER BY created_at DESC LIMIT 1;
    IF v_corrects IS NULL THEN RAISE EXCEPTION 'rejection_event_missing' USING ERRCODE='P0001'; END IF;
  END IF;

  v_candidate_status:=CASE p_new_status
    WHEN 'submitted' THEN 'applied' WHEN 'reviewing' THEN 'applied' WHEN 'shortlisted' THEN 'applied'
    WHEN 'interviewing' THEN 'interview' WHEN 'offered' THEN 'offer'
    WHEN 'rejected' THEN 'rejected' WHEN 'hired' THEN 'hired'
    WHEN 'withdrawn' THEN 'withdrawn' WHEN 'offer_declined' THEN 'offer_declined' ELSE NULL END;
  IF v_candidate_status IS NULL THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE='22023'; END IF;

  IF v_app.status<>v_candidate_status THEN
    IF v_eja.status='rejected' AND p_new_status='reviewing' THEN
      IF NOT public.is_valid_linked_application_transition(v_app.status,v_candidate_status,'system_correction') THEN
        RAISE EXCEPTION 'candidate_state_conflict' USING ERRCODE='P0001';
      END IF;
    ELSIF NOT public.is_valid_linked_application_transition(v_app.status,v_candidate_status,'employer_sync') THEN
      RAISE EXCEPTION 'candidate_state_conflict' USING ERRCODE='P0001';
    END IF;
  END IF;

  v_action:=CASE
    WHEN v_eja.status='rejected' AND p_new_status='reviewing' THEN 'rejection_reconsidered'
    WHEN p_new_status='rejected' THEN 'application_rejected'
    WHEN p_new_status='hired' THEN 'application_hired'
    WHEN p_new_status='interviewing' THEN 'interview_started'
    WHEN p_new_status='offered' THEN 'offer_extended'
    WHEN p_new_status='shortlisted' THEN 'shortlisted'
    WHEN p_new_status='reviewing' THEN 'review_started'
    ELSE 'application_status_changed' END;

  UPDATE public.employer_job_applications SET status=p_new_status,updated_at=now() WHERE id=v_eja.id;
  INSERT INTO public.hiring_decision_events(
    company_id,submission_id,opportunity_id,candidate_profile_id,subject_type,
    employer_application_id,actor_id,actor_role,action,reason_code,
    previous_state,new_state,corrects_event_id,idempotency_key
  )
  SELECT p_company_id,v_eja.submission_id,v_eja.opportunity_id,v_eja.candidate_profile_id,
    'application',v_eja.id,p_actor_id,v_member_role,v_action,p_reason_code,
    v_eja.status,p_new_status,v_corrects,p_idempotency_key;

  IF v_app.status<>v_candidate_status THEN
    UPDATE public.applications SET status=v_candidate_status,updated_at=now() WHERE id=v_app.id;
    INSERT INTO public.application_events(application_id,event_type,event_payload,employer_application_id)
    VALUES(v_app.id,'status_changed',
      jsonb_build_object('fromStatus',v_app.status,'toStatus',v_candidate_status,
                         'source','employer_sync','employer_application_id',v_eja.id),v_eja.id);
  END IF;
  RETURN jsonb_build_object('success',true,'replayed',false,'status',p_new_status,
    'candidateStatus',v_candidate_status);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_application_status(text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.transition_application_status(text,text,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.transition_employer_application(uuid,uuid,uuid,text,text,text,text) TO service_role;

