-- Recovered verbatim from the applied migration ledger on isolated project remotematch-paidtest.
-- Version: 20261112185212
-- Name: v2_p0_m2_m3_application_lifecycle


-- RemoteMatch V2 P0 M2/M3 isolated implementation.
-- Deliberately excludes M1/M4/M5/M6 and D1 profile-deletion changes.

-- M2: link candidate and employer applications without changing existing history.
ALTER TABLE public.employer_job_applications
  ADD COLUMN candidate_application_id uuid NULL
  REFERENCES public.applications(id) ON DELETE SET NULL;

ALTER TABLE public.applications
  ADD COLUMN application_channel text NOT NULL DEFAULT 'external'
  CHECK (application_channel IN ('external','remotematch_direct')),
  ADD COLUMN archived_at timestamptz NULL;

CREATE UNIQUE INDEX uq_eja_candidate_opportunity
  ON public.employer_job_applications(candidate_profile_id, opportunity_id);
CREATE UNIQUE INDEX uq_eja_candidate_application
  ON public.employer_job_applications(candidate_application_id)
  WHERE candidate_application_id IS NOT NULL;

-- Extend candidate status vocabulary only for linked applications.
ALTER TABLE public.applications DROP CONSTRAINT applications_status_check;
ALTER TABLE public.applications ADD CONSTRAINT applications_status_check
  CHECK (status = ANY (ARRAY[
    'interested','applied','interview','offer','rejected','withdrawn','archived',
    'offer_declined','hired'
  ]::text[]));

ALTER TABLE public.employer_job_applications DROP CONSTRAINT employer_job_applications_status_check;
ALTER TABLE public.employer_job_applications ADD CONSTRAINT employer_job_applications_status_check
  CHECK (status = ANY (ARRAY[
    'submitted','reviewing','shortlisted','interviewing','offered',
    'rejected','hired','withdrawn','offer_declined'
  ]::text[]));

-- Typed event relationship and a truthful event-occurrence timestamp.
ALTER TABLE public.application_events
  ADD COLUMN employer_application_id uuid NULL
    REFERENCES public.employer_job_applications(id) ON DELETE RESTRICT,
  ADD COLUMN occurred_at timestamptz NULL;

ALTER TABLE public.application_events DROP CONSTRAINT application_events_event_type_check;
ALTER TABLE public.application_events ADD CONSTRAINT application_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'status_changed','feedback_submitted','interview_scheduled',
    'offer_received','rejection_received','note_added',
    'direct_application_submitted','archived','unarchived'
  ]::text[]));

CREATE UNIQUE INDEX uq_application_events_direct_submission
  ON public.application_events(employer_application_id)
  WHERE event_type = 'direct_application_submitted';

-- Close direct client event forgery. Keep events_insert_own because the
-- table is FORCE RLS and existing SECURITY DEFINER writers were tested.
REVOKE INSERT ON public.application_events FROM authenticated;
REVOKE INSERT ON public.application_events FROM anon;

-- M3: compact reason-code vocabulary; no free-text audit notes.
CREATE TABLE public.hiring_decision_reason_codes (
  reason_code text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO public.hiring_decision_reason_codes(reason_code, description) VALUES
 ('strong_experience','Strong relevant experience'),
 ('relevant_achievements','Relevant achievements'),
 ('strong_technical_skills','Strong technical skills'),
 ('transferable_capabilities','Transferable capabilities'),
 ('insufficient_experience','Insufficient experience'),
 ('missing_mandatory_qualification','Missing mandatory qualification'),
 ('location_ineligible','Location ineligible'),
 ('poor_role_fit','Poor role fit'),
 ('insufficient_evidence','Insufficient evidence'),
 ('position_filled','Position filled'),
 ('candidate_withdrew','Candidate withdrew'),
 ('other','Other recorded reason');

CREATE TABLE public.hiring_decision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  submission_id uuid NOT NULL REFERENCES public.employer_job_submissions(id) ON DELETE RESTRICT,
  opportunity_id uuid NOT NULL REFERENCES public.opportunities(id) ON DELETE RESTRICT,
  candidate_profile_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('application','sourcing')),
  employer_application_id uuid NULL
    REFERENCES public.employer_job_applications(id) ON DELETE RESTRICT,
  -- M6 adds the FK when employer_candidate_decisions is introduced.
  sourcing_decision_id uuid NULL,
  actor_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('candidate','owner','admin','member','system')),
  action text NOT NULL,
  reason_code text NULL REFERENCES public.hiring_decision_reason_codes(reason_code),
  previous_state text NULL,
  new_state text NOT NULL,
  corrects_event_id uuid NULL REFERENCES public.hiring_decision_events(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hiring_decision_events_subject_check CHECK (
    (subject_type = 'application' AND employer_application_id IS NOT NULL AND sourcing_decision_id IS NULL)
    OR
    (subject_type = 'sourcing' AND employer_application_id IS NULL AND sourcing_decision_id IS NOT NULL)
  ),
  CONSTRAINT hiring_decision_events_company_idempotency_key UNIQUE(company_id,idempotency_key)
);

CREATE INDEX hiring_decision_events_application_created_idx
  ON public.hiring_decision_events(employer_application_id,created_at DESC);
CREATE INDEX hiring_decision_events_company_created_idx
  ON public.hiring_decision_events(company_id,created_at DESC);

ALTER TABLE public.hiring_decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hiring_decision_events FORCE ROW LEVEL SECURITY;
CREATE POLICY hiring_decision_events_service_role_all
  ON public.hiring_decision_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.hiring_decision_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.hiring_decision_events TO service_role;
REVOKE UPDATE, DELETE ON public.hiring_decision_events FROM service_role;

CREATE OR REPLACE FUNCTION public.guard_hiring_decision_event_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hiring_decision_events_are_append_only' USING ERRCODE = '42501';
  END IF;

  -- Permit only FK-driven identity nulling required by the recorded D1 model.
  IF (to_jsonb(NEW) - 'candidate_profile_id' - 'actor_id')
       IS DISTINCT FROM
     (to_jsonb(OLD) - 'candidate_profile_id' - 'actor_id') THEN
    RAISE EXCEPTION 'hiring_decision_events_are_append_only' USING ERRCODE = '42501';
  END IF;
  IF (OLD.candidate_profile_id IS NOT NULL AND NEW.candidate_profile_id IS DISTINCT FROM NULL)
     OR (OLD.actor_id IS NOT NULL AND NEW.actor_id IS DISTINCT FROM NULL) THEN
    RAISE EXCEPTION 'hiring_decision_event_identity_may_only_be_nulled' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hiring_decision_events_immutable
BEFORE UPDATE OR DELETE ON public.hiring_decision_events
FOR EACH ROW EXECUTE FUNCTION public.guard_hiring_decision_event_immutability();

CREATE OR REPLACE FUNCTION public.is_valid_linked_application_transition(
  p_from text, p_to text, p_actor text
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_from = p_to THEN false
    WHEN p_actor = 'employer_sync' AND p_from = 'applied' AND p_to IN ('interview','rejected') THEN true
    WHEN p_actor = 'employer_sync' AND p_from = 'interview' AND p_to IN ('offer','rejected','applied') THEN true
    WHEN p_actor = 'employer_sync' AND p_from = 'offer' AND p_to IN ('rejected','hired') THEN true
    WHEN p_actor = 'candidate' AND p_from IN ('applied','interview','offer') AND p_to = 'withdrawn' THEN true
    WHEN p_actor = 'candidate' AND p_from = 'offer' AND p_to = 'offer_declined' THEN true
    WHEN p_actor = 'system_correction' AND p_from = 'rejected' AND p_to = 'applied' THEN true
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_employer_application_transition(
  p_from text, p_to text, p_actor text
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_from = p_to THEN false
    WHEN p_actor = 'employer' AND p_from = 'submitted' AND p_to IN ('reviewing','shortlisted','rejected') THEN true
    WHEN p_actor = 'employer' AND p_from = 'reviewing' AND p_to IN ('shortlisted','rejected') THEN true
    WHEN p_actor = 'employer' AND p_from = 'shortlisted' AND p_to IN ('reviewing','interviewing','rejected') THEN true
    WHEN p_actor = 'employer' AND p_from = 'interviewing' AND p_to IN ('shortlisted','offered','rejected') THEN true
    WHEN p_actor = 'employer' AND p_from = 'offered' AND p_to IN ('hired','rejected') THEN true
    WHEN p_actor = 'employer' AND p_from = 'rejected' AND p_to = 'reviewing' THEN true
    WHEN p_actor = 'candidate' AND p_from IN ('submitted','reviewing','shortlisted','interviewing','offered') AND p_to = 'withdrawn' THEN true
    WHEN p_actor = 'candidate' AND p_from = 'offered' AND p_to = 'offer_declined' THEN true
    ELSE false
  END;
$$;

-- Direct apply is candidate-session authenticated and atomic across both records.
CREATE OR REPLACE FUNCTION public.apply_to_employer_job(
  p_source_id uuid, p_cover_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_submission public.employer_job_submissions%ROWTYPE;
  v_opportunity public.opportunities%ROWTYPE;
  v_eja public.employer_job_applications%ROWTYPE;
  v_app public.applications%ROWTYPE;
  v_existing_eja public.employer_job_applications%ROWTYPE;
  v_event public.application_events%ROWTYPE;
  v_hiring_event public.hiring_decision_events%ROWTYPE;
  v_new_eja boolean := false;
  v_new_app boolean := false;
  v_old_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000'; END IF;
  IF p_source_id IS NULL OR p_cover_note IS NOT NULL AND length(p_cover_note) > 10000 THEN
    RAISE EXCEPTION 'invalid_application_request' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM public.profiles WHERE id=v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found' USING ERRCODE='P0002'; END IF;

  SELECT s.* INTO v_submission
  FROM public.employer_job_submissions s
  JOIN public.opportunities o ON o.id=s.published_opportunity_id
  WHERE o.source='employerdirect'
    AND o.source_id=p_source_id::text
    AND s.status='published'
    AND o.status='active'
  FOR SHARE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_accepting_applications' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_opportunity
  FROM public.opportunities
  WHERE id=v_submission.published_opportunity_id
  FOR SHARE;
  IF NOT FOUND OR v_opportunity.canonical_id IS NULL OR length(btrim(v_opportunity.canonical_id))=0 THEN
    RAISE EXCEPTION 'canonical_identity_missing' USING ERRCODE='P0002';
  END IF;

  INSERT INTO public.employer_job_applications(
    submission_id,opportunity_id,candidate_profile_id,cover_note
  ) VALUES (
    v_submission.id,v_opportunity.id,v_uid,coalesce(p_cover_note,'')
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_eja;

  IF FOUND THEN
    v_new_eja := true;
  ELSE
    SELECT * INTO v_existing_eja
    FROM public.employer_job_applications
    WHERE candidate_profile_id=v_uid AND opportunity_id=v_opportunity.id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    IF v_existing_eja.submission_id <> v_submission.id THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    v_eja := v_existing_eja;
  END IF;

  -- A pre-existing employer row is a replay only when the complete pair and
  -- both audit facts are already present and agree exactly.
  IF NOT v_new_eja THEN
    IF v_eja.candidate_application_id IS NULL THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO v_app FROM public.applications
    WHERE id=v_eja.candidate_application_id
      AND profile_id=v_uid
      AND opportunity_id=v_opportunity.canonical_id
      AND application_channel='remotematch_direct'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001'; END IF;

    SELECT * INTO v_event FROM public.application_events
    WHERE event_type='direct_application_submitted'
      AND employer_application_id=v_eja.id;
    SELECT * INTO v_hiring_event FROM public.hiring_decision_events
    WHERE company_id=v_submission.company_id
      AND idempotency_key='application-submitted:'||v_eja.id::text;
    IF v_event.id IS NULL OR v_event.application_id <> v_app.id
       OR v_hiring_event.id IS NULL
       OR v_hiring_event.employer_application_id <> v_eja.id
       OR v_hiring_event.submission_id <> v_submission.id
       OR v_hiring_event.opportunity_id <> v_opportunity.id
       OR v_hiring_event.candidate_profile_id IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('success',true,'replayed',true,
      'application',jsonb_build_object('id',v_eja.id,'status',v_eja.status,'submitted_at',v_eja.submitted_at),
      'candidateApplication',jsonb_build_object('id',v_app.id,'status',v_app.status,'applied_at',v_app.applied_at));
  END IF;

  SELECT * INTO v_app
  FROM public.applications
  WHERE profile_id=v_uid AND opportunity_id=v_opportunity.canonical_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.applications(
      profile_id,opportunity_id,status,applied_at,application_channel
    ) VALUES (
      v_uid,v_opportunity.canonical_id,'applied',v_now,'remotematch_direct'
    ) RETURNING * INTO v_app;
    v_new_app := true;
    INSERT INTO public.application_events(
      application_id,event_type,event_payload,employer_application_id
    ) VALUES (
      v_app.id,'status_changed',
      jsonb_build_object('fromStatus',NULL,'toStatus','applied','source','direct_apply'),
      v_eja.id
    );
  ELSE
    IF v_app.status='interested' AND v_app.application_channel='external' THEN
      v_old_status := v_app.status;
      UPDATE public.applications
      SET status='applied',
          applied_at=coalesce(applied_at,v_now),
          application_channel='remotematch_direct',
          updated_at=v_now
      WHERE id=v_app.id
      RETURNING * INTO v_app;
      INSERT INTO public.application_events(
        application_id,event_type,event_payload,employer_application_id
      ) VALUES (
        v_app.id,'status_changed',
        jsonb_build_object('fromStatus',v_old_status,'toStatus','applied','source','direct_apply'),
        v_eja.id
      );
    ELSIF v_app.status='applied' AND v_app.application_channel='external' THEN
      -- Preserve applied_at byte-for-byte for an already-applied manual row.
      UPDATE public.applications
      SET application_channel='remotematch_direct',updated_at=v_now
      WHERE id=v_app.id
      RETURNING * INTO v_app;
    ELSE
      RAISE EXCEPTION 'application_state_conflict' USING ERRCODE='P0001';
    END IF;
  END IF;

  UPDATE public.employer_job_applications
  SET candidate_application_id=v_app.id
  WHERE id=v_eja.id AND candidate_application_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001'; END IF;

  INSERT INTO public.application_events(
    application_id,event_type,event_payload,employer_application_id,occurred_at
  ) VALUES (
    v_app.id,'direct_application_submitted',
    jsonb_build_object('source','remotematch_direct','submission_id',v_submission.id,
                       'employer_application_id',v_eja.id),
    v_eja.id,v_now
  );

  INSERT INTO public.hiring_decision_events(
    company_id,submission_id,opportunity_id,candidate_profile_id,
    subject_type,employer_application_id,actor_id,actor_role,action,
    previous_state,new_state,idempotency_key
  ) VALUES (
    v_submission.company_id,v_submission.id,v_opportunity.id,v_uid,
    'application',v_eja.id,v_uid,'candidate','application_submitted',
    NULL,'submitted','application-submitted:'||v_eja.id::text
  );

  RETURN jsonb_build_object('success',true,'replayed',false,
    'application',jsonb_build_object('id',v_eja.id,'status',v_eja.status,'submitted_at',v_eja.submitted_at),
    'candidateApplication',jsonb_build_object('id',v_app.id,'status',v_app.status,'applied_at',v_app.applied_at));
END;
$$;

REVOKE ALL ON FUNCTION public.apply_to_employer_job(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_to_employer_job(uuid,text) TO authenticated;

-- Employer decision RPC: SECURITY INVOKER, callable only with service_role.
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

  SELECT e.* INTO v_eja
  FROM public.employer_job_applications e
  JOIN public.employer_job_submissions s ON s.id=e.submission_id
  WHERE e.id=p_application_id AND s.company_id=p_company_id
  FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;

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

  IF v_eja.candidate_application_id IS NOT NULL THEN
    SELECT * INTO v_app FROM public.applications
    WHERE id=v_eja.candidate_application_id
    FOR UPDATE;
    IF NOT FOUND OR v_app.profile_id IS DISTINCT FROM v_eja.candidate_profile_id
       OR v_app.application_channel <> 'remotematch_direct' THEN
      RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'application_integrity_conflict' USING ERRCODE='P0001';
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

  IF v_app.status <> v_candidate_status THEN
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

  IF v_app.status <> v_candidate_status THEN
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
    'status',p_new_status,'candidateStatus',v_candidate_status,'eventId',v_event.id);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)
  TO service_role;

-- Candidate lifecycle: linked rows use the separate matrix; external rows
-- retain the original transition matrix and behavior.
CREATE OR REPLACE FUNCTION public.transition_application_status(
  p_opportunity_id text,
  p_expected_status text,
  p_new_status text,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_app public.applications%ROWTYPE;
  v_eja public.employer_job_applications%ROWTYPE;
  v_link_id uuid;
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

  -- Unlocked link lookup, then profile -> employer -> candidate lock order.
  SELECT candidate_application_id INTO v_link_id
  FROM public.employer_job_applications
  WHERE candidate_profile_id=v_uid
    AND candidate_application_id IN (
      SELECT id FROM public.applications
      WHERE profile_id=v_uid AND opportunity_id=p_opportunity_id
    )
  LIMIT 1;

  IF v_link_id IS NOT NULL THEN
    PERFORM 1 FROM public.profiles WHERE id=v_uid FOR UPDATE;
    SELECT * INTO v_eja FROM public.employer_job_applications
    WHERE candidate_application_id=v_link_id AND candidate_profile_id=v_uid
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;
    SELECT * INTO v_app FROM public.applications
    WHERE id=v_link_id AND profile_id=v_uid
    FOR UPDATE;
    IF NOT FOUND OR v_eja.candidate_application_id IS DISTINCT FROM v_app.id THEN
      RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003';
    END IF;
    IF v_app.status <> p_expected_status THEN
      RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003';
    END IF;
    IF NOT public.is_valid_linked_application_transition(v_app.status,p_new_status,'candidate') THEN
      RAISE EXCEPTION 'managed_by_employer_or_invalid_transition' USING ERRCODE='22023';
    END IF;

    v_employer_new_status := CASE p_new_status
      WHEN 'withdrawn' THEN 'withdrawn'
      WHEN 'offer_declined' THEN 'offer_declined'
      ELSE NULL END;
    IF v_employer_new_status IS NULL THEN
      RAISE EXCEPTION 'managed_by_employer' USING ERRCODE='22023';
    END IF;

    UPDATE public.employer_job_applications
    SET status=v_employer_new_status,updated_at=now()
    WHERE id=v_eja.id;

    UPDATE public.applications
    SET status=p_new_status,
        notes=coalesce(p_notes,notes),
        updated_at=now()
    WHERE id=v_app.id;

    INSERT INTO public.application_events(
      application_id,event_type,event_payload,employer_application_id
    ) VALUES (
      v_app.id,'status_changed',
      jsonb_build_object('fromStatus',v_app.status,'toStatus',p_new_status,'notes',p_notes,
                         'source','candidate','employer_application_id',v_eja.id),
      v_eja.id
    );

    v_event_action := CASE p_new_status
      WHEN 'withdrawn' THEN 'application_withdrawn'
      WHEN 'offer_declined' THEN 'offer_declined'
      ELSE 'candidate_status_changed' END;

    INSERT INTO public.hiring_decision_events(
      company_id,submission_id,opportunity_id,candidate_profile_id,
      subject_type,employer_application_id,actor_id,actor_role,action,
      previous_state,new_state,idempotency_key
    )
    SELECT s.company_id,v_eja.submission_id,v_eja.opportunity_id,v_uid,
      'application',v_eja.id,v_uid,'candidate',v_event_action,
      v_eja.status,v_employer_new_status,
      'candidate-transition:'||v_eja.id::text||':'||v_employer_new_status
    FROM public.employer_job_submissions s
    WHERE s.id=v_eja.submission_id;

    RETURN jsonb_build_object('success',true,'status',p_new_status);
  END IF;

  -- Legacy external application path: same matrix and status semantics.
  IF p_new_status NOT IN ('interested','applied','interview','offer','rejected','withdrawn','archived')
     OR p_expected_status NOT IN ('interested','applied','interview','offer','rejected','withdrawn','archived') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_app FROM public.applications
  WHERE profile_id=v_uid AND opportunity_id=p_opportunity_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;
  IF v_app.status <> p_expected_status THEN RAISE EXCEPTION 'status_conflict' USING ERRCODE='P0003'; END IF;
  IF NOT public.is_valid_application_transition(v_app.status,p_new_status) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE='22023';
  END IF;

  UPDATE public.applications
  SET status=p_new_status,notes=coalesce(p_notes,notes),
      applied_at=CASE WHEN p_new_status='applied' AND applied_at IS NULL THEN now() ELSE applied_at END,
      updated_at=now()
  WHERE id=v_app.id;

  INSERT INTO public.application_events(application_id,event_type,event_payload)
  VALUES (v_app.id,'status_changed',
    jsonb_build_object('fromStatus',v_app.status,'toStatus',p_new_status,'notes',p_notes));

  RETURN jsonb_build_object('success',true,'status',p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_application_status(text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.transition_application_status(text,text,text,text) TO authenticated;

-- Archive is a candidate visibility preference for linked applications only.
CREATE OR REPLACE FUNCTION public.set_application_archived(
  p_opportunity_id text, p_archived boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_app public.applications%ROWTYPE;
  v_eja public.employer_job_applications%ROWTYPE;
  v_target timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000'; END IF;
  IF p_archived IS NULL THEN RAISE EXCEPTION 'invalid_archive_request' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_app FROM public.applications
  WHERE profile_id=v_uid AND opportunity_id=p_opportunity_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'application_not_found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_eja FROM public.employer_job_applications
  WHERE candidate_application_id=v_app.id AND candidate_profile_id=v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_direct_application' USING ERRCODE='22023'; END IF;

  IF (v_app.archived_at IS NOT NULL)=p_archived THEN
    RETURN jsonb_build_object('success',true,'changed',false,'archived',p_archived);
  END IF;
  v_target := CASE WHEN p_archived THEN now() ELSE NULL END;
  UPDATE public.applications SET archived_at=v_target,updated_at=now() WHERE id=v_app.id;
  INSERT INTO public.application_events(
    application_id,event_type,event_payload,employer_application_id
  ) VALUES (
    v_app.id,CASE WHEN p_archived THEN 'archived' ELSE 'unarchived' END,
    jsonb_build_object('archived',p_archived),v_eja.id
  );
  RETURN jsonb_build_object('success',true,'changed',true,'archived',p_archived);
END;
$$;

REVOKE ALL ON FUNCTION public.set_application_archived(text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_application_archived(text,boolean) TO authenticated;

-- Rewind must not erase a linked application or progressed candidate history.
CREATE OR REPLACE FUNCTION public.rewind_last_decision()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_plan text;
  v_last public.swipes%ROWTYPE;
  v_app public.applications%ROWTYPE;
  v_eja public.employer_job_applications%ROWTYPE;
  v_link_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000'; END IF;
  SELECT plan_tier INTO v_plan FROM public.profiles WHERE id=v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
  IF v_plan IS DISTINCT FROM 'pro' THEN
    RETURN jsonb_build_object('success',false,'error','pro_required');
  END IF;

  SELECT * INTO v_last FROM public.swipes
  WHERE profile_id=v_uid ORDER BY created_at DESC LIMIT 1;
  IF v_last.id IS NULL OR v_last.action='rewind' THEN
    RETURN jsonb_build_object('success',false,'error','nothing_to_rewind');
  END IF;

  IF v_last.action='interested' THEN
    SELECT * INTO v_app FROM public.applications
    WHERE profile_id=v_uid AND opportunity_id=v_last.opportunity_id;
    IF FOUND THEN
      SELECT id INTO v_link_id FROM public.employer_job_applications
      WHERE candidate_application_id=v_app.id AND candidate_profile_id=v_uid;
      IF v_link_id IS NOT NULL THEN
        SELECT * INTO v_eja FROM public.employer_job_applications
        WHERE id=v_link_id AND candidate_profile_id=v_uid FOR UPDATE;
        SELECT * INTO v_app FROM public.applications
        WHERE id=v_app.id AND profile_id=v_uid FOR UPDATE;
        IF v_eja.candidate_application_id=v_app.id THEN
          RETURN jsonb_build_object('success',false,'error','application_submitted');
        END IF;
      ELSE
        SELECT * INTO v_app FROM public.applications
        WHERE id=v_app.id AND profile_id=v_uid FOR UPDATE;
        IF FOUND AND v_app.status IS DISTINCT FROM 'interested' THEN
          RETURN jsonb_build_object('success',false,'error','application_state_conflict');
        END IF;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.swipes(profile_id,opportunity_id,action,rewound_decision_id)
  VALUES (v_uid,v_last.opportunity_id,'rewind',v_last.id);

  IF v_last.action='interested' THEN
    UPDATE public.swipes SET enrichment_claim_id=NULL,enrichment_claimed_at=NULL
    WHERE id=v_last.id;
    UPDATE public.profiles
    SET daily_right_swipes_count=greatest(daily_right_swipes_count-1,0),updated_at=now()
    WHERE id=v_uid;
    DELETE FROM public.applications
    WHERE profile_id=v_uid AND opportunity_id=v_last.opportunity_id;
  END IF;

  RETURN jsonb_build_object('success',true,
    'rewoundOpportunityId',v_last.opportunity_id,'rewoundAction',v_last.action);
END;
$$;

REVOKE ALL ON FUNCTION public.rewind_last_decision() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rewind_last_decision() TO authenticated;

-- Explicit post-migration privilege assertions fail the migration closed.
DO $$
BEGIN
  IF has_table_privilege('authenticated','public.application_events','INSERT')
     OR has_table_privilege('anon','public.application_events','INSERT') THEN
    RAISE EXCEPTION 'application_events_client_insert_privilege_remains';
  END IF;
  IF NOT has_function_privilege('authenticated','public.apply_to_employer_job(uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.apply_to_employer_job(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'apply_rpc_execute_grants_invalid';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)','EXECUTE')
     OR has_function_privilege('authenticated',
      'public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'employer_transition_rpc_execute_grants_invalid';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

