-- M3: legacy employer applications are no longer a permanent second class.
--
-- Written as a FOLLOW-UP migration, stacked AFTER the M2 migration (apply_to_employer_job is
-- copied from it so the M2 lock fix is kept). It has not been applied anywhere.
--
-- "Legacy" means an employer application with no candidate link AND no recorded
-- application_submitted event: it was created before this PR's apply path existed.
--
-- 1. Re-applying to a job the candidate already applied to as a legacy row used to fail with
--    application_integrity_conflict ("contact support"). It is now a plain replay, as it was
--    before this PR: success, replayed=true, legacy=true, nothing written.
-- 2. A legacy rejected application could never be reconsidered, because the RPC required a
--    prior application_rejected event that pre-migration rejections do not have. It can now;
--    a linked row with a missing rejection event still raises rejection_event_missing.
--
-- Not done here: linking existing legacy rows (a data backfill that needs its own decision;
-- see the read-only diagnostic in docs/v2-m3-legacy-diagnostics.sql). Bodies are the latest
-- definitions copied verbatim apart from the two changes above.

CREATE OR REPLACE FUNCTION public.apply_to_employer_job(
  p_source_id uuid,p_cover_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_uid uuid:=auth.uid();
  v_submission public.employer_job_submissions%ROWTYPE;
  v_opportunity public.opportunities%ROWTYPE;
  v_eja public.employer_job_applications%ROWTYPE;
  v_app public.applications%ROWTYPE;
  v_existing public.employer_job_applications%ROWTYPE;
  v_event public.application_events%ROWTYPE;
  v_hiring_event public.hiring_decision_events%ROWTYPE;
  v_new_eja boolean:=false;
  v_old_status text;
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000'; END IF;
  IF p_source_id IS NULL OR (p_cover_note IS NOT NULL AND length(p_cover_note)>10000) THEN
    RAISE EXCEPTION 'invalid_application_request' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id=v_uid FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found' USING ERRCODE='P0002'; END IF;

  SELECT s.* INTO v_submission
  FROM public.employer_job_submissions s
  JOIN public.opportunities o ON o.id=s.published_opportunity_id
  WHERE o.source='employerdirect' AND o.source_id=p_source_id::text
    AND s.status='published' AND o.status='active'
  FOR SHARE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_accepting_applications' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_opportunity FROM public.opportunities
  WHERE id=v_submission.published_opportunity_id FOR SHARE;
  IF NOT FOUND OR v_opportunity.canonical_id IS NULL OR length(btrim(v_opportunity.canonical_id))=0 THEN
    RAISE EXCEPTION 'canonical_identity_missing' USING ERRCODE='P0002';
  END IF;

  INSERT INTO public.employer_job_applications(submission_id,opportunity_id,candidate_profile_id,cover_note)
  VALUES(v_submission.id,v_opportunity.id,v_uid,coalesce(p_cover_note,''))
  ON CONFLICT DO NOTHING RETURNING * INTO v_eja;
  IF FOUND THEN
    v_new_eja:=true;
  ELSE
    SELECT * INTO v_existing FROM public.employer_job_applications
    WHERE candidate_profile_id=v_uid AND opportunity_id=v_opportunity.id FOR UPDATE;
    IF NOT FOUND OR v_existing.submission_id<>v_submission.id THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    v_eja:=v_existing;
  END IF;

  IF NOT v_new_eja THEN
    IF v_eja.candidate_application_id IS NULL THEN
      -- No link and no recorded submission means the row predates the audit trail (legacy).
      -- Applying again is then a replay: report the existing application and change nothing.
      -- A missing link on a row that DOES have its submission event is a broken link.
      IF NOT EXISTS (
          SELECT 1 FROM public.hiring_decision_events
          WHERE employer_application_id=v_eja.id AND action='application_submitted'
        ) THEN
        RETURN jsonb_build_object('success',true,'replayed',true,'legacy',true,
          'application',jsonb_build_object('id',v_eja.id,'status',v_eja.status,'submitted_at',v_eja.submitted_at),
          'candidateApplication',NULL);
      END IF;
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO v_app FROM public.applications
    WHERE id=v_eja.candidate_application_id AND profile_id=v_uid
      AND opportunity_id=v_opportunity.canonical_id
      AND application_channel='remotematch_direct'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001'; END IF;

    SELECT * INTO v_event FROM public.application_events
    WHERE event_type='direct_application_submitted' AND employer_application_id=v_eja.id;
    SELECT * INTO v_hiring_event FROM public.hiring_decision_events
    WHERE company_id=v_submission.company_id
      AND idempotency_key='application-submitted:'||v_eja.id::text;

    IF v_event.id IS NULL OR v_event.application_id<>v_app.id
       OR v_event.event_payload->>'source' IS DISTINCT FROM 'remotematch_direct'
       OR v_event.event_payload->>'submission_id' IS DISTINCT FROM v_submission.id::text
       OR v_event.event_payload->>'employer_application_id' IS DISTINCT FROM v_eja.id::text
       OR v_event.occurred_at IS NULL
       OR v_hiring_event.id IS NULL
       OR v_hiring_event.subject_type<>'application'
       OR v_hiring_event.employer_application_id<>v_eja.id
       OR v_hiring_event.submission_id<>v_submission.id
       OR v_hiring_event.opportunity_id<>v_opportunity.id
       OR v_hiring_event.candidate_profile_id IS DISTINCT FROM v_uid
       OR v_hiring_event.actor_role<>'candidate'
       OR v_hiring_event.action<>'application_submitted'
       OR v_hiring_event.previous_state IS NOT NULL
       OR v_hiring_event.new_state<>'submitted' THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('success',true,'replayed',true,
      'application',jsonb_build_object('id',v_eja.id,'status',v_eja.status,'submitted_at',v_eja.submitted_at),
      'candidateApplication',jsonb_build_object('id',v_app.id,'status',v_app.status,'applied_at',v_app.applied_at));
  END IF;

  SELECT * INTO v_app FROM public.applications
  WHERE profile_id=v_uid AND opportunity_id=v_opportunity.canonical_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.applications(profile_id,opportunity_id,status,applied_at,application_channel)
    VALUES(v_uid,v_opportunity.canonical_id,'applied',v_now,'remotematch_direct')
    RETURNING * INTO v_app;
    INSERT INTO public.application_events(application_id,event_type,event_payload,employer_application_id)
    VALUES(v_app.id,'status_changed',
      jsonb_build_object('fromStatus',NULL,'toStatus','applied','source','direct_apply'),v_eja.id);
  ELSE
    IF v_app.status='interested' AND v_app.application_channel='external' THEN
      v_old_status:=v_app.status;
      UPDATE public.applications SET status='applied',applied_at=coalesce(applied_at,v_now),
        application_channel='remotematch_direct',updated_at=v_now
      WHERE id=v_app.id RETURNING * INTO v_app;
      INSERT INTO public.application_events(application_id,event_type,event_payload,employer_application_id)
      VALUES(v_app.id,'status_changed',
        jsonb_build_object('fromStatus',v_old_status,'toStatus','applied','source','direct_apply'),v_eja.id);
    ELSIF v_app.status='applied' AND v_app.application_channel='external' THEN
      UPDATE public.applications SET application_channel='remotematch_direct',updated_at=v_now
      WHERE id=v_app.id RETURNING * INTO v_app;
    ELSE
      RAISE EXCEPTION 'application_state_conflict' USING ERRCODE='P0001';
    END IF;
  END IF;

  UPDATE public.employer_job_applications SET candidate_application_id=v_app.id
  WHERE id=v_eja.id AND candidate_application_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001'; END IF;

  -- created_at and occurred_at are the same actual event time for live apply.
  v_now:=clock_timestamp();
  INSERT INTO public.application_events(
    application_id,event_type,event_payload,employer_application_id,created_at,occurred_at
  ) VALUES(
    v_app.id,'direct_application_submitted',
    jsonb_build_object('source','remotematch_direct','submission_id',v_submission.id,
                       'employer_application_id',v_eja.id),
    v_eja.id,v_now,v_now
  );

  INSERT INTO public.hiring_decision_events(
    company_id,submission_id,opportunity_id,candidate_profile_id,subject_type,
    employer_application_id,actor_id,actor_role,action,previous_state,new_state,idempotency_key
  ) VALUES(
    v_submission.company_id,v_submission.id,v_opportunity.id,v_uid,'application',
    v_eja.id,v_uid,'candidate','application_submitted',NULL,'submitted',
    'application-submitted:'||v_eja.id::text
  );

  RETURN jsonb_build_object('success',true,'replayed',false,
    'application',jsonb_build_object('id',v_eja.id,'status',v_eja.status,'submitted_at',v_eja.submitted_at),
    'candidateApplication',jsonb_build_object('id',v_app.id,'status',v_app.status,'applied_at',v_app.applied_at));
END;
$$;

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
       OR v_event.previous_state IS DISTINCT FROM p_expected_status
       OR v_event.new_state <> p_new_status
       OR v_event.reason_code IS DISTINCT FROM p_reason_code
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
    -- A rejection recorded before the audit trail existed (legacy: no link, no recorded
    -- submission) has no event to correct. It may still be reconsidered; the reconsideration
    -- event itself starts the trail and has no corrected event. Anywhere else a missing
    -- rejection event is a real integrity problem.
    IF v_corrects IS NULL AND NOT (
         v_eja.candidate_application_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM public.hiring_decision_events
            WHERE employer_application_id=v_eja.id AND action='application_submitted'
         )
       ) THEN
      RAISE EXCEPTION 'rejection_event_missing' USING ERRCODE='P0001';
    END IF;
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

REVOKE ALL ON FUNCTION public.apply_to_employer_job(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_to_employer_job(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.transition_employer_application(uuid,uuid,uuid,text,text,text,text) TO service_role;

-- Self-check: fail the migration if a definition did not take effect.
DO $check$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid='public.apply_to_employer_job(uuid,text)'::regprocedure;
  IF v_src NOT LIKE '%''legacy'',true%' OR v_src NOT LIKE '%profiles WHERE id=v_uid FOR NO KEY UPDATE%' THEN
    RAISE EXCEPTION 'm3 self-check: apply_to_employer_job is missing the legacy replay or the M2 lock fix';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE oid='public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)'::regprocedure;
  IF v_src NOT LIKE '%v_corrects IS NULL AND NOT (%' THEN
    RAISE EXCEPTION 'm3 self-check: transition_employer_application still rejects every legacy reconsideration';
  END IF;
  IF v_src NOT LIKE '%v_event.previous_state IS DISTINCT FROM p_expected_status%'
     OR v_src NOT LIKE '%v_event.reason_code IS DISTINCT FROM p_reason_code%' THEN
    RAISE EXCEPTION 'm3 self-check: transition_employer_application lost the idempotency payload binding';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
