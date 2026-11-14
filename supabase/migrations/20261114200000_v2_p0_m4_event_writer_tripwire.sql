-- M4: additive, non-mutating tripwire. Ordered after M3 migration 20261114190000.
-- Same DO block as the read-only preflight in docs/v2-m4-event-writer-preflight.sql.

DO $m4$
DECLARE
  v_post boolean;
  v_problems text[] := ARRAY[]::text[];
  v_sig text;
  v_oid oid;
  v_definer boolean;
  v_owner_bypass boolean;
  v_cfg text[];
BEGIN
  v_post := NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.application_events'::regclass AND polname='events_insert_own');

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role' AND (rolbypassrls OR rolsuper)) THEN
    v_problems := v_problems || 'service_role is missing or does not bypass row-level security'::text;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.application_events'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    v_problems := v_problems || 'row-level security is not enabled and forced on application_events'::text;
  END IF;

  -- Includes policies granted to roles inherited by authenticated/anon and PUBLIC policies.
  IF v_post AND EXISTS (
    SELECT 1 FROM pg_policy p CROSS JOIN LATERAL unnest(p.polroles) AS policy_role(role_oid)
    WHERE p.polrelid='public.application_events'::regclass AND p.polcmd IN ('a','*')
      AND (
        policy_role.role_oid=0
        OR (policy_role.role_oid<>0 AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')
            AND pg_has_role('authenticated',policy_role.role_oid,'USAGE'))
        OR (policy_role.role_oid<>0 AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')
            AND pg_has_role('anon',policy_role.role_oid,'USAGE'))
      )
  ) THEN
    v_problems := v_problems || 'a client INSERT policy exists on application_events (including inherited roles)'::text;
  END IF;

  IF v_post THEN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')
       AND has_table_privilege('authenticated','public.application_events','INSERT') THEN
      v_problems := v_problems || 'authenticated still has INSERT on application_events'::text;
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')
       AND has_table_privilege('anon','public.application_events','INSERT') THEN
      v_problems := v_problems || 'anon still has INSERT on application_events'::text;
    END IF;
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.record_application_feedback(text,text,text)',
    'public.update_application_notes(text,text)',
    'public.transition_application_status(text,text,text,text)',
    'public.set_application_archived(text,boolean)',
    'public.apply_to_employer_job(uuid,text)',
    'public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)'
  ] LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      IF v_post THEN v_problems := v_problems || format('writer %s does not exist',v_sig); END IF;
      CONTINUE;
    END IF;
    SELECT p.prosecdef,p.proconfig,coalesce(r.rolbypassrls OR r.rolsuper,false)
      INTO v_definer,v_cfg,v_owner_bypass
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=v_oid;

    IF v_sig='public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)' THEN
      IF NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
        v_problems := v_problems || format('%s is not executable by service_role',v_sig);
      END IF;
      IF (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') AND has_function_privilege('authenticated',v_oid,'EXECUTE'))
         OR (EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') AND has_function_privilege('anon',v_oid,'EXECUTE')) THEN
        v_problems := v_problems || format('%s is executable by a client role',v_sig);
      END IF;
    ELSE
      IF NOT v_definer THEN
        v_problems := v_problems || format('%s is not SECURITY DEFINER',v_sig);
      ELSIF NOT v_owner_bypass THEN
        v_problems := v_problems || format('%s is owned by a role that does not bypass row-level security',v_sig);
      END IF;
      IF NOT EXISTS(SELECT 1 FROM unnest(coalesce(v_cfg,ARRAY[]::text[])) c WHERE c LIKE 'search_path=%') THEN
        v_problems := v_problems || format('%s does not pin search_path',v_sig);
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_problems,1)>0 THEN
    RAISE EXCEPTION 'm4 event-writer check failed (%): %',
      CASE WHEN v_post THEN 'client INSERT policy already dropped' ELSE 'client INSERT policy not yet dropped' END,
      array_to_string(v_problems,' | ');
  END IF;
  RAISE NOTICE 'm4 event-writer check passed (%)',
    CASE WHEN v_post THEN 'client INSERT policy already dropped' ELSE 'client INSERT policy not yet dropped' END;
END
$m4$;
