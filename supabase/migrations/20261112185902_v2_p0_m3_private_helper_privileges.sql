-- Recovered verbatim from the applied migration ledger on isolated project remotematch-paidtest.
-- Version: 20261112185902
-- Name: v2_p0_m3_private_helper_privileges


-- Internal trigger and transition helpers are not PostgREST RPC endpoints.
ALTER FUNCTION public.guard_employer_application_link() SECURITY INVOKER;
REVOKE ALL ON FUNCTION public.guard_employer_application_link() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.guard_linked_candidate_identity() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.guard_hiring_decision_event_immutability() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION public.is_valid_linked_application_transition(text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_valid_linked_application_transition(text,text,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.is_valid_employer_application_transition(text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_valid_employer_application_transition(text,text,text)
  TO service_role;

