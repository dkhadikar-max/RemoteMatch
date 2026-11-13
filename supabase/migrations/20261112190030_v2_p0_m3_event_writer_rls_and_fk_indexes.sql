-- Recovered verbatim from the applied migration ledger on isolated project remotematch-paidtest.
-- Version: 20261112190030
-- Name: v2_p0_m3_event_writer_rls_and_fk_indexes


-- Remove the obsolete client-side INSERT policy after proving all trusted
-- writers work with it absent. Client INSERT remains revoked for both roles.
DROP POLICY IF EXISTS events_insert_own ON public.application_events;

-- Cover every FK on the new/affected application lifecycle paths.
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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid='public.application_events'::regclass AND polcmd='a'
  ) THEN
    RAISE EXCEPTION 'application_events_insert_policy_still_exists';
  END IF;
  IF has_table_privilege('authenticated','public.application_events','INSERT')
     OR has_table_privilege('anon','public.application_events','INSERT') THEN
    RAISE EXCEPTION 'application_events_client_insert_privilege_remains';
  END IF;
END;
$$;

