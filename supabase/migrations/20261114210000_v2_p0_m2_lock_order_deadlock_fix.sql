-- M2: remove deadlocks between candidate writes and employer decisions.
--
-- Written as a FOLLOW-UP migration because the PR's own migrations are already applied on
-- the isolated project. It has not been applied anywhere.
--
-- Cause 1 (archive): set_application_archived locked the candidate row, then inserted an
--   event whose foreign key needs a share lock on the employer row.
--   transition_employer_application holds the employer row FOR UPDATE and then waits for
--   the candidate row. Each waited on the other. Fix: lock the employer row first, then the
--   candidate row, which is the order every other writer already uses.
--
-- Cause 2 (profile lock): apply_to_employer_job, transition_application_status and
--   rewind_last_decision took the profile row FOR UPDATE before the employer row.
--   hiring_decision_events.candidate_profile_id references profiles, so an employer
--   decision's event insert needs FOR KEY SHARE on that same profile row, which FOR UPDATE
--   blocks while the candidate side waits for the employer row. Fix: FOR NO KEY UPDATE. It
--   still serialises writers of the same profile but does not block foreign-key checks.
--
-- Function bodies are the latest definitions copied verbatim; only lock statements change.
-- Privileges are restated and unchanged.

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
    PERFORM 1 FROM public.profiles WHERE id=v_uid FOR NO KEY UPDATE;
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

    -- Idempotent replay: if the application is already in the requested target
    -- state AND the deterministic hiring_decision_events row for this exact
    -- transition already exists, this is a retry of an already-committed
    -- transition (e.g. a client retrying after a timeout), not a real conflict.
    -- Must be checked before the p_expected_status comparison below, because on
    -- a genuine replay v_app.status now equals p_new_status, not p_expected_status.
    v_employer_new_status:=CASE p_new_status
      WHEN 'withdrawn' THEN 'withdrawn' WHEN 'offer_declined' THEN 'offer_declined' ELSE NULL END;
    IF v_employer_new_status IS NOT NULL AND v_app.status=p_new_status AND v_eja.status=v_employer_new_status
       AND EXISTS (
         SELECT 1 FROM public.hiring_decision_events
         WHERE employer_application_id=v_eja.id
           AND idempotency_key='candidate-transition:'||v_eja.id::text||':'||v_employer_new_status
       ) THEN
      RETURN jsonb_build_object('success',true,'status',p_new_status,'replayed',true);
    END IF;

    IF v_app.status<>p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;
    IF NOT public.is_valid_linked_application_transition(v_app.status,p_new_status,'candidate') THEN
      RAISE EXCEPTION 'managed_by_employer_or_invalid_transition' USING ERRCODE='22023';
    END IF;
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

  -- Idempotent replay: if the application is already in the requested target
  -- state AND the most recent recorded event for it is exactly this
  -- expected->new transition, this is a retry of an already-committed
  -- transition, not a real conflict. Matching only the LATEST event (not any
  -- historical one) avoids treating a legitimately repeated transition
  -- (e.g. interested -> applied -> withdrawn -> applied -> withdrawn again)
  -- as a stale replay of the earlier one.
  IF v_app.status=p_new_status AND EXISTS (
    SELECT 1 FROM (
      SELECT event_payload FROM public.application_events
      WHERE application_id=v_app.id AND event_type='status_changed'
      ORDER BY created_at DESC LIMIT 1
    ) last_event
    WHERE (last_event.event_payload->>'fromStatus')=p_expected_status
      AND (last_event.event_payload->>'toStatus')=p_new_status
  ) THEN
    RETURN jsonb_build_object('success',true,'status',p_new_status,'replayed',true);
  END IF;

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

CREATE OR REPLACE FUNCTION public.set_application_archived(
  p_opportunity_id text,p_archived boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_uid uuid:=auth.uid();
  v_app_id uuid;
  v_link_id uuid;
  v_app public.applications%ROWTYPE;
  v_eja public.employer_job_applications%ROWTYPE;
  v_target timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000'; END IF;
  IF p_archived IS NULL THEN RAISE EXCEPTION 'invalid_archive_request' USING ERRCODE='22023'; END IF;

  -- Find the candidate row and its link WITHOUT locking, so the employer row can be locked
  -- first. The lock order for every writer is employer row, then candidate row.
  SELECT id INTO v_app_id FROM public.applications
  WHERE profile_id=v_uid AND opportunity_id=p_opportunity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;
  SELECT e.id INTO v_link_id FROM public.employer_job_applications e
  WHERE e.candidate_application_id=v_app_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_direct_application' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_eja FROM public.employer_job_applications WHERE id=v_link_id FOR UPDATE;
  IF NOT FOUND OR v_eja.candidate_application_id IS DISTINCT FROM v_app_id THEN
    RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_app FROM public.applications
  WHERE id=v_app_id AND profile_id=v_uid AND opportunity_id=p_opportunity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001'; END IF;

  IF v_eja.candidate_profile_id IS DISTINCT FROM v_uid
     OR v_eja.opportunity_id IS DISTINCT FROM (
       SELECT id FROM public.opportunities WHERE canonical_id=v_app.opportunity_id LIMIT 1
     ) THEN
    RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
  END IF;
  IF (v_app.archived_at IS NOT NULL)=p_archived THEN
    RETURN jsonb_build_object('success',true,'changed',false,'archived',p_archived);
  END IF;
  v_target:=CASE WHEN p_archived THEN now() ELSE NULL END;
  UPDATE public.applications SET archived_at=v_target,updated_at=now() WHERE id=v_app.id;
  INSERT INTO public.application_events(application_id,event_type,event_payload,employer_application_id)
  VALUES(v_app.id,CASE WHEN p_archived THEN 'archived' ELSE 'unarchived' END,
    jsonb_build_object('archived',p_archived),v_eja.id);
  RETURN jsonb_build_object('success',true,'changed',true,'archived',p_archived);
END;
$$;

CREATE OR REPLACE FUNCTION public.rewind_last_decision()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_uid uuid:=auth.uid();
  v_plan text;
  v_last public.swipes%ROWTYPE;
  v_app public.applications%ROWTYPE;
  v_eja public.employer_job_applications%ROWTYPE;
  v_link_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000'; END IF;
  SELECT plan_tier INTO v_plan FROM public.profiles WHERE id=v_uid FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
  IF v_plan IS DISTINCT FROM 'pro' THEN RETURN jsonb_build_object('success',false,'error','pro_required'); END IF;

  SELECT * INTO v_last FROM public.swipes WHERE profile_id=v_uid ORDER BY created_at DESC LIMIT 1;
  IF v_last.id IS NULL OR v_last.action='rewind' THEN
    RETURN jsonb_build_object('success',false,'error','nothing_to_rewind');
  END IF;

  IF v_last.action='interested' THEN
    SELECT * INTO v_app FROM public.applications
    WHERE profile_id=v_uid AND opportunity_id=v_last.opportunity_id;
    IF FOUND THEN
      SELECT id INTO v_link_id FROM public.employer_job_applications
      WHERE candidate_application_id=v_app.id;
      IF v_link_id IS NOT NULL THEN
        SELECT * INTO v_eja FROM public.employer_job_applications WHERE id=v_link_id FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','status_conflict'); END IF;
        SELECT * INTO v_app FROM public.applications WHERE id=v_app.id AND profile_id=v_uid FOR UPDATE;
        IF NOT FOUND OR v_eja.candidate_profile_id IS DISTINCT FROM v_uid
           OR v_eja.candidate_application_id IS DISTINCT FROM v_app.id THEN
          RETURN jsonb_build_object('success',false,'error','status_conflict');
        END IF;
        RETURN jsonb_build_object('success',false,'error','application_submitted');
      ELSE
        SELECT * INTO v_app FROM public.applications WHERE id=v_app.id AND profile_id=v_uid FOR UPDATE;
        IF FOUND AND v_app.status IS DISTINCT FROM 'interested' THEN
          RETURN jsonb_build_object('success',false,'error','application_state_conflict');
        END IF;
        -- Re-check for a link under the lock: the first lookup above (line ~395) was
        -- unlocked, so a concurrent apply_to_employer_job could have linked this exact
        -- application between that read and this lock being granted. Relying only on
        -- v_app.status matching 'interested' is not a sufficient guard: nothing proves a
        -- link cannot be created without changing that status. Re-check explicitly and
        -- take the same conflict path as the IF branch above, instead of falling through
        -- to the unconditional DELETE below (PR #120 review remediation).
        IF FOUND AND EXISTS (
          SELECT 1 FROM public.employer_job_applications WHERE candidate_application_id=v_app.id
        ) THEN
          RETURN jsonb_build_object('success',false,'error','application_submitted');
        END IF;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.swipes(profile_id,opportunity_id,action,rewound_decision_id)
  VALUES(v_uid,v_last.opportunity_id,'rewind',v_last.id);
  IF v_last.action='interested' THEN
    UPDATE public.swipes SET enrichment_claim_id=NULL,enrichment_claimed_at=NULL WHERE id=v_last.id;
    UPDATE public.profiles SET daily_right_swipes_count=greatest(daily_right_swipes_count-1,0),updated_at=now()
    WHERE id=v_uid;
    DELETE FROM public.applications WHERE profile_id=v_uid AND opportunity_id=v_last.opportunity_id;
  END IF;
  RETURN jsonb_build_object('success',true,'rewoundOpportunityId',v_last.opportunity_id,'rewoundAction',v_last.action);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_to_employer_job(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_to_employer_job(uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.transition_application_status(text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.transition_application_status(text,text,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.set_application_archived(text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_application_archived(text,boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.rewind_last_decision() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rewind_last_decision() TO authenticated;

-- Self-check: fail the migration if a definition did not take effect.
DO $check$
DECLARE
  v_src text;
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.apply_to_employer_job(uuid,text)',
    'public.transition_application_status(text,text,text,text)',
    'public.rewind_last_decision()'
  ] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF v_src LIKE '%profiles WHERE id=v_uid FOR UPDATE%'
       OR v_src NOT LIKE '%profiles WHERE id=v_uid FOR NO KEY UPDATE%' THEN
      RAISE EXCEPTION 'm2 self-check: % still locks the profile FOR UPDATE', v_fn;
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.set_application_archived(text,boolean)'::regprocedure;
  IF position('employer_job_applications WHERE id=v_link_id FOR UPDATE' IN v_src) = 0
     OR position('WHERE id=v_app_id AND profile_id=v_uid AND opportunity_id=p_opportunity_id FOR UPDATE' IN v_src) = 0
     OR position('employer_job_applications WHERE id=v_link_id FOR UPDATE' IN v_src)
        > position('WHERE id=v_app_id AND profile_id=v_uid AND opportunity_id=p_opportunity_id FOR UPDATE' IN v_src) THEN
    RAISE EXCEPTION 'm2 self-check: set_application_archived must lock the employer row before the candidate row';
  END IF;
END
$check$;
