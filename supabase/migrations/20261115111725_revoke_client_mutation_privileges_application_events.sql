-- Keep production migration history aligned with the forward-only privilege
-- correction applied while executing the M2/M3/M4 lifecycle chain.
-- application_events is append-only. Candidate clients may read their own
-- events through events_select_own, but must not mutate or delete audit rows.
-- INSERT was revoked by v2_p0_m3_event_writer_rls_and_fk_indexes.
REVOKE UPDATE, DELETE ON TABLE public.application_events FROM anon, authenticated;

DO $check$
BEGIN
  IF has_table_privilege('anon','public.application_events','INSERT')
     OR has_table_privilege('anon','public.application_events','UPDATE')
     OR has_table_privilege('anon','public.application_events','DELETE')
     OR has_table_privilege('authenticated','public.application_events','INSERT')
     OR has_table_privilege('authenticated','public.application_events','UPDATE')
     OR has_table_privilege('authenticated','public.application_events','DELETE') THEN
    RAISE EXCEPTION 'application_events_client_mutation_privileges_remain';
  END IF;
END
$check$;
