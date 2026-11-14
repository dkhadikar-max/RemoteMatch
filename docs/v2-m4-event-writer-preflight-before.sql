-- V2 M4 preflight BEFORE the lifecycle policy-drop migration. READ ONLY; not run by this patch.
-- Run only against an explicitly approved target.

SELECT p.polname AS policy,p.polcmd AS command,
 coalesce(array_to_string(ARRAY(SELECT CASE WHEN o=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=o) END FROM unnest(p.polroles) o),','),'') AS roles
FROM pg_policy p WHERE p.polrelid='public.application_events'::regclass ORDER BY 1;

SELECT c.relrowsecurity AS rls_enabled,c.relforcerowsecurity AS rls_forced FROM pg_class c WHERE c.oid='public.application_events'::regclass;

SELECT rolname,rolbypassrls,rolsuper FROM pg_roles WHERE rolname IN (current_user,'postgres','service_role','authenticated','anon') ORDER BY 1;

SELECT p.oid::regprocedure AS writer,p.prosecdef AS security_definer,r.rolname AS owner,(r.rolbypassrls OR r.rolsuper) AS owner_bypasses_rls,p.proconfig AS function_config
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('record_application_feedback','update_application_notes','transition_application_status','set_application_archived','apply_to_employer_job','transition_employer_application') ORDER BY 1;


-- Pre-drop phase; legacy events_insert_own is expected and is excluded from client-policy failure.
DO $m4$
DECLARE
  v_post boolean;
  v_problems text[] := ARRAY[]::text[];
  v_sig text;
  v_oid oid;
  v_definer boolean;
  v_owner_bypass boolean;
  v_owner_can_insert boolean;
  v_owner_schema_usage boolean;
  v_cfg text[];
BEGIN
  v_post := false;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role' AND (rolbypassrls OR rolsuper)) THEN
    v_problems := v_problems || 'service_role is missing or does not bypass row-level security'::text;
  ELSE
    IF NOT has_table_privilege('service_role','public.application_events','INSERT') THEN
      v_problems := v_problems || 'service_role lacks INSERT on application_events'::text;
    END IF;
    IF NOT has_schema_privilege('service_role','public','USAGE') THEN
      v_problems := v_problems || 'service_role lacks USAGE on schema public'::text;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.application_events'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    v_problems := v_problems || 'row-level security is not enabled and forced on application_events'::text;
  END IF;

  -- Includes policies granted to roles inherited by authenticated/anon and PUBLIC policies.
  IF EXISTS (
    SELECT 1 FROM pg_policy p CROSS JOIN LATERAL unnest(p.polroles) AS policy_role(role_oid)
    WHERE p.polrelid='public.application_events'::regclass
      AND (v_post OR p.polname <> 'events_insert_own')
      AND p.polcmd IN ('a','*')
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

  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')
     AND has_table_privilege('authenticated','public.application_events','INSERT') THEN
    v_problems := v_problems || 'authenticated still has INSERT on application_events'::text;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')
     AND has_table_privilege('anon','public.application_events','INSERT') THEN
    v_problems := v_problems || 'anon still has INSERT on application_events'::text;
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
    SELECT p.prosecdef,p.proconfig,coalesce(r.rolbypassrls OR r.rolsuper,false),
           has_table_privilege(r.oid,'public.application_events','INSERT'),
           has_schema_privilege(r.oid,'public','USAGE')
      INTO v_definer,v_cfg,v_owner_bypass,v_owner_can_insert,v_owner_schema_usage
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=v_oid;

    IF v_sig='public.transition_employer_application(uuid,uuid,uuid,text,text,text,text)' THEN
      IF v_definer THEN
        v_problems := v_problems || format('%s must remain SECURITY INVOKER',v_sig);
      END IF;
      IF NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
        v_problems := v_problems || format('%s is not executable by service_role',v_sig);
      END IF;
      IF NOT EXISTS(SELECT 1 FROM unnest(coalesce(v_cfg,ARRAY[]::text[])) c WHERE c ~ '^search_path=public(,|$)') THEN
        v_problems := v_problems || format('%s does not pin search_path with public first',v_sig);
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
      IF NOT v_owner_can_insert THEN
        v_problems := v_problems || format('%s owner lacks INSERT on application_events',v_sig);
      END IF;
      IF NOT v_owner_schema_usage THEN
        v_problems := v_problems || format('%s owner lacks USAGE on schema public',v_sig);
      END IF;
      IF NOT EXISTS(SELECT 1 FROM unnest(coalesce(v_cfg,ARRAY[]::text[])) c WHERE c ~ '^search_path=public(,|$)') THEN
        v_problems := v_problems || format('%s does not pin search_path with public first',v_sig);
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

