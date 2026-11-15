DO $m4$
DECLARE
  v_post boolean;
  v_problems text[] := ARRAY[]::text[];
  v_legacy_debt text[] := ARRAY[]::text[];
  v_sig text;
  v_table text;
  v_oid oid;
  v_definer boolean;
  v_owner_bypass boolean;
  v_owner_can_insert boolean;
  v_owner_schema_usage boolean;
  v_cfg text[];
BEGIN
  v_post := __M4_POST_DROP__;

  IF v_post AND EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid='public.application_events'::regclass AND polname='events_insert_own'
  ) THEN
    v_problems := v_problems || 'legacy events_insert_own policy still exists after the policy-drop migration'::text;
  ELSIF NOT v_post AND NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid='public.application_events'::regclass AND polname='events_insert_own'
  ) THEN
    v_problems := v_problems || 'pre-drop phase expected the legacy events_insert_own policy, but it is absent'::text;
  END IF;

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
  -- application_events and hiring_decision_events are append-only audit tables: a client
  -- role must never be able to INSERT, UPDATE or DELETE outside the trusted writer
  -- functions/triggers. This used to only scan for 'a'/'*' (INSERT/ALL) policies, so a
  -- future migration adding a client-reachable UPDATE or DELETE policy ('w'/'d') would
  -- have passed this tripwire silently, even though it breaks the documented
  -- append-only/immutable design (PR #120 review remediation).
  FOREACH v_table IN ARRAY ARRAY['public.application_events','public.hiring_decision_events'] LOOP
    IF to_regclass(v_table) IS NULL THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policy p CROSS JOIN LATERAL unnest(p.polroles) AS policy_role(role_oid)
      WHERE p.polrelid=v_table::regclass
        AND (v_post OR v_table<>'public.application_events' OR p.polname <> 'events_insert_own')
        AND p.polcmd IN ('a','w','d','*')
        AND (
          policy_role.role_oid=0
          OR (policy_role.role_oid<>0 AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')
              AND pg_has_role('authenticated',policy_role.role_oid,'USAGE'))
          OR (policy_role.role_oid<>0 AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')
              AND pg_has_role('anon',policy_role.role_oid,'USAGE'))
        )
    ) THEN
      v_problems := v_problems || format('a client INSERT/UPDATE/DELETE policy exists on %s (including inherited roles)',v_table);
    END IF;

    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')
       AND (has_table_privilege('authenticated',v_table,'INSERT')
            OR has_table_privilege('authenticated',v_table,'UPDATE')
            OR has_table_privilege('authenticated',v_table,'DELETE')) THEN
      v_problems := v_problems || format('authenticated still has INSERT/UPDATE/DELETE on %s',v_table);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')
       AND (has_table_privilege('anon',v_table,'INSERT')
            OR has_table_privilege('anon',v_table,'UPDATE')
            OR has_table_privilege('anon',v_table,'DELETE')) THEN
      v_problems := v_problems || format('anon still has INSERT/UPDATE/DELETE on %s',v_table);
    END IF;
  END LOOP;

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
      -- transition_employer_application is one of this PR's own functions: require the
      -- full pinned pattern (public then pg_temp), not just the weaker "public somewhere"
      -- match -- see the legacy-writer branch below for why these are not the same check
      -- (PR #120 review remediation).
      IF NOT EXISTS(SELECT 1 FROM unnest(coalesce(v_cfg,ARRAY[]::text[])) c WHERE c ~ '^search_path=public, ?pg_temp(,|$)') THEN
        v_problems := v_problems || format('%s does not pin search_path to public,pg_temp',v_sig);
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
      -- record_application_feedback and update_application_notes predate this PR (migration
      -- 006) and are documented (docs/m4-event-writer-dependency.md) as a separate, deferred
      -- hardening follow-up: they use the weaker bare "search_path=public" (no pg_temp) and
      -- unqualified table references. The regex below used to match BOTH that weak pattern
      -- and the fully-pinned "public,pg_temp" pattern, so the tripwire could never tell them
      -- apart and effectively reported all six writers as equally hardened. It now requires
      -- the weak baseline (search_path pins public at all -- losing even that would be a
      -- real regression, fatal below) but only WARNS, via v_legacy_debt rather than
      -- v_problems, when a known-legacy writer still lacks the full public,pg_temp pinning.
      -- A NEWLY introduced writer (not one of these two names) is held to the strict pattern
      -- immediately, with no such allowance (PR #120 review remediation).
      IF NOT EXISTS(SELECT 1 FROM unnest(coalesce(v_cfg,ARRAY[]::text[])) c WHERE c ~ '^search_path=public(,|$)') THEN
        v_problems := v_problems || format('%s does not pin search_path with public first',v_sig);
      ELSIF v_sig IN ('public.record_application_feedback(text,text,text)','public.update_application_notes(text,text)') THEN
        IF NOT EXISTS(SELECT 1 FROM unnest(coalesce(v_cfg,ARRAY[]::text[])) c WHERE c ~ '^search_path=public, ?pg_temp(,|$)') THEN
          v_legacy_debt := v_legacy_debt || format('%s still uses the weaker search_path=public (no pg_temp) -- known, deferred, see docs/m4-event-writer-dependency.md',v_sig);
        END IF;
      ELSIF NOT EXISTS(SELECT 1 FROM unnest(coalesce(v_cfg,ARRAY[]::text[])) c WHERE c ~ '^search_path=public, ?pg_temp(,|$)') THEN
        v_problems := v_problems || format('%s does not pin search_path to public,pg_temp',v_sig);
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_problems,1)>0 THEN
    RAISE EXCEPTION 'm4 event-writer check failed (%): %',
      CASE WHEN v_post THEN 'client INSERT policy already dropped' ELSE 'client INSERT policy not yet dropped' END,
      array_to_string(v_problems,' | ');
  END IF;
  IF array_length(v_legacy_debt,1)>0 THEN
    RAISE NOTICE 'm4 event-writer check passed with known legacy debt (%): %',
      CASE WHEN v_post THEN 'client INSERT policy already dropped' ELSE 'client INSERT policy not yet dropped' END,
      array_to_string(v_legacy_debt,' | ');
  ELSE
    RAISE NOTICE 'm4 event-writer check passed (%)',
      CASE WHEN v_post THEN 'client INSERT policy already dropped' ELSE 'client INSERT policy not yet dropped' END;
  END IF;
END
$m4$;