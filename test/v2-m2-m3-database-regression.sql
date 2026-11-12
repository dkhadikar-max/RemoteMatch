-- RemoteMatch V2 P0 M2/M3 database regression contract.
-- Read-only: run against the isolated remotematch-paidtest project after
-- applying the seven migrations. No fixture rows are inserted or modified.
DO $$
DECLARE
  v_count integer;
  v_def text;
BEGIN
  -- Schema/link contract.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='employer_job_applications' AND column_name='candidate_application_id') THEN
    RAISE EXCEPTION 'missing employer_job_applications.candidate_application_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='applications' AND column_name='application_channel') OR
     NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='applications' AND column_name='archived_at') THEN
    RAISE EXCEPTION 'missing candidate application channel/archive columns';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='application_events' AND column_name='employer_application_id') OR
     NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='application_events' AND column_name='occurred_at') THEN
    RAISE EXCEPTION 'missing typed application event link/timestamp';
  END IF;
  IF to_regclass('public.hiring_decision_events') IS NULL OR to_regclass('public.hiring_decision_reason_codes') IS NULL THEN
    RAISE EXCEPTION 'missing M3 audit tables';
  END IF;

  -- Direct client event forgery must remain impossible.
  IF has_table_privilege('authenticated','public.application_events','INSERT') OR
     has_table_privilege('anon','public.application_events','INSERT') THEN
    RAISE EXCEPTION 'client INSERT privilege remains on application_events';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policy
  WHERE polrelid='public.application_events'::regclass AND polcmd='a';
  IF v_count <> 0 THEN RAISE EXCEPTION 'application_events INSERT policy remains'; END IF;

  -- Append-only audit and reference vocabulary remain server-controlled.
  IF has_table_privilege('authenticated','public.hiring_decision_events','SELECT') OR
     has_table_privilege('anon','public.hiring_decision_events','SELECT') OR
     has_table_privilege('authenticated','public.hiring_decision_events','INSERT') OR
     has_table_privilege('anon','public.hiring_decision_events','INSERT') THEN
    RAISE EXCEPTION 'hiring decision audit table is exposed to client roles';
  END IF;
  IF has_table_privilege('authenticated','public.hiring_decision_reason_codes','INSERT') OR
     has_table_privilege('anon','public.hiring_decision_reason_codes','INSERT') OR
     has_table_privilege('service_role','public.hiring_decision_reason_codes','INSERT') THEN
    RAISE EXCEPTION 'reason-code vocabulary is writable by an application role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.application_events'::regclass AND relforcerowsecurity) OR
     NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.hiring_decision_events'::regclass AND relforcerowsecurity) OR
     NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.hiring_decision_reason_codes'::regclass AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'FORCE RLS missing from one or more lifecycle event/reference tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.hiring_decision_events'::regclass AND tgname='hiring_decision_events_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'append-only hiring decision trigger missing';
  END IF;

  -- RPC grants and execution context.
  IF NOT has_function_privilege('authenticated','public.apply_to_employer_job(uuid,text)','EXECUTE') OR
     has_function_privilege('anon','public.apply_to_employer_job(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'direct apply RPC grants are incorrect';
  END IF;
  IF NOT has_function_privilege('authenticated','public.set_application_archived(text,boolean)','EXECUTE') OR
     has_function_privilege('anon','public.set_application_archived(text,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'archive RPC grants are incorrect';
  END IF;
  IF NOT has_function_privilege('service_role','public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)','EXECUTE') OR
     has_function_privilege('authenticated','public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'employer transition RPC grants are incorrect';
  END IF;
  SELECT prosecdef INTO v_count FROM pg_proc WHERE oid='public.apply_to_employer_job(uuid,text)'::regprocedure;
  IF v_count <> 1 THEN RAISE EXCEPTION 'direct apply RPC must be SECURITY DEFINER'; END IF;
  SELECT prosecdef INTO v_count FROM pg_proc WHERE oid='public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)'::regprocedure;
  IF v_count <> 0 THEN RAISE EXCEPTION 'employer transition RPC must be SECURITY INVOKER'; END IF;

  -- State-machine characterization.
  IF NOT public.is_valid_linked_application_transition('applied','interview','employer_sync') OR
     NOT public.is_valid_linked_application_transition('interview','offer','employer_sync') OR
     NOT public.is_valid_linked_application_transition('offer','withdrawn','candidate') OR
     NOT public.is_valid_linked_application_transition('offer','offer_declined','candidate') OR
     NOT public.is_valid_linked_application_transition('rejected','applied','system_correction') THEN
    RAISE EXCEPTION 'an approved linked candidate transition is missing';
  END IF;
  IF public.is_valid_linked_application_transition('applied','offer','candidate') OR
     public.is_valid_linked_application_transition('applied','rejected','candidate') OR
     public.is_valid_linked_application_transition('offer','hired','candidate') THEN
    RAISE EXCEPTION 'an unapproved linked candidate transition is allowed';
  END IF;
  IF NOT public.is_valid_employer_application_transition('submitted','reviewing','employer') OR
     NOT public.is_valid_employer_application_transition('interviewing','offered','employer') OR
     NOT public.is_valid_employer_application_transition('offered','hired','employer') OR
     NOT public.is_valid_employer_application_transition('rejected','reviewing','employer') THEN
    RAISE EXCEPTION 'an approved employer transition is missing';
  END IF;
  IF public.is_valid_employer_application_transition('submitted','hired','employer') OR
     public.is_valid_employer_application_transition('offered','reviewing','employer') THEN
    RAISE EXCEPTION 'an unapproved employer transition is allowed';
  END IF;

  -- Scope guard: M3 is application audit only; M6 sourcing is not enabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.hiring_decision_events'::regclass
      AND conname='hiring_decision_events_subject_check'
  ) THEN RAISE EXCEPTION 'application-only audit subject constraint missing'; END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
  WHERE conrelid='public.hiring_decision_events'::regclass
    AND conname='hiring_decision_events_subject_check';
  IF v_def NOT LIKE '%sourcing_decision_id IS NULL%' OR v_def NOT LIKE '%employer_application_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'audit subject constraint does not restrict events to applications';
  END IF;

  -- The seven source migrations must be represented in the applied ledger.
  SELECT count(*) INTO v_count FROM supabase_migrations.schema_migrations
  WHERE version IN ('20261112185212','20261112185655','20261112185730',
    '20261112185902','20261112190030','20261112190152','20261112190248');
  IF v_count <> 7 THEN RAISE EXCEPTION 'expected seven applied M2/M3 migrations, found %',v_count; END IF;
END;
$$;
