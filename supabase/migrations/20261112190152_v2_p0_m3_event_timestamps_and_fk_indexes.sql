-- Recovered verbatim from the applied migration ledger on isolated project remotematch-paidtest.
-- Version: 20261112190152
-- Name: v2_p0_m3_event_timestamps_and_fk_indexes


-- Accurate insertion timestamps and missing FK indexes for M2/M3.
ALTER TABLE public.application_events
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE public.employer_job_applications
  ALTER COLUMN submitted_at SET DEFAULT clock_timestamp();
ALTER TABLE public.hiring_decision_events
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE INDEX IF NOT EXISTS idx_application_events_application_id
  ON public.application_events(application_id);
CREATE INDEX IF NOT EXISTS idx_application_events_employer_application_id
  ON public.application_events(employer_application_id);
CREATE INDEX IF NOT EXISTS idx_employer_job_applications_opportunity_id
  ON public.employer_job_applications(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_hiring_decision_events_actor_id
  ON public.hiring_decision_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_hiring_decision_events_candidate_profile_id
  ON public.hiring_decision_events(candidate_profile_id);
CREATE INDEX IF NOT EXISTS idx_hiring_decision_events_corrects_event_id
  ON public.hiring_decision_events(corrects_event_id);
CREATE INDEX IF NOT EXISTS idx_hiring_decision_events_opportunity_id
  ON public.hiring_decision_events(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_hiring_decision_events_reason_code
  ON public.hiring_decision_events(reason_code);
CREATE INDEX IF NOT EXISTS idx_hiring_decision_events_submission_id
  ON public.hiring_decision_events(submission_id);

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
  PERFORM 1 FROM public.profiles WHERE id=v_uid FOR UPDATE;
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
REVOKE ALL ON FUNCTION public.apply_to_employer_job(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_to_employer_job(uuid,text) TO authenticated;

