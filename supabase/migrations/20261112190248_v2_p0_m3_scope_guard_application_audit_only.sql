-- Recovered verbatim from the applied migration ledger on isolated project remotematch-paidtest.
-- Version: 20261112190248
-- Name: v2_p0_m3_scope_guard_application_audit_only


-- M6 sourcing decisions are not part of this authorization. Until that table
-- and its FK exist, the M3 audit stream accepts application subjects only.
ALTER TABLE public.hiring_decision_events
  DROP CONSTRAINT hiring_decision_events_subject_check,
  DROP CONSTRAINT hiring_decision_events_subject_type_check;

ALTER TABLE public.hiring_decision_events
  ADD CONSTRAINT hiring_decision_events_subject_type_check
    CHECK (subject_type='application'),
  ADD CONSTRAINT hiring_decision_events_subject_check
    CHECK (subject_type='application'
      AND employer_application_id IS NOT NULL
      AND sourcing_decision_id IS NULL);

COMMENT ON COLUMN public.hiring_decision_events.sourcing_decision_id IS
  'Reserved for M6; currently constrained NULL until employer_candidate_decisions and its FK are implemented.';

