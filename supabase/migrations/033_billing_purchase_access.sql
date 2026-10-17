-- ==============================================================================
-- RemoteMatch — 033: Admin-controlled Pro purchase access
--
-- A second, admin-managed gate in front of /api/razorpay/subscription. A
-- purchase may START only when BOTH hold:
--   1. the deployment-level RAZORPAY_ALLOWLIST_USER_IDS permits the user
--      (unchanged — src/lib/razorpay.ts), AND
--   2. the user has an ACTIVE row here (revoked_at IS NULL).
-- No row, a revoked row, a missing table or a failed lookup all mean "no".
-- Nothing here touches the webhook, /verify or /cancel: an existing
-- subscriber keeps syncing and can always cancel, whatever their access.
--
-- Contents:
--   1. billing_purchase_access — who may start a purchase. Soft-revoke only.
--   2. admin_audit_log vocabulary — two new actions, one new target type.
--   3. RLS / grants — service-role only, same shape as migration 029.
--   4. admin_grant_purchase_access / admin_revoke_purchase_access — the ONLY
--      writers. Each changes access AND writes its audit row in ONE
--      transaction: both commit or neither does. Serialized per target user,
--      idempotent (a repeat is a no-op that writes no audit row).
--   5. billing_access_security_report — read-only diagnostic of the RLS,
--      grants and policies on the three tables and the privileges on these
--      functions, so tests (and a post-apply check) can verify the live
--      state. A diagnostic only: it does not replace reviewing this file.
--
-- Additive: one new table, three new functions, and the two admin_audit_log
-- CHECK constraints replaced by supersets (every existing value still valid).
-- No data is written. Idempotent (IF NOT EXISTS / OR REPLACE / IF EXISTS).
-- ==============================================================================

-- --------------------------------------------------------------------------- 1.
CREATE TABLE IF NOT EXISTS billing_purchase_access (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by_admin_id  uuid NOT NULL,
  granted_by_email     text NOT NULL,
  granted_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  revoked_by_admin_id  uuid,
  revoked_by_email     text,
  note                 text CHECK (note IS NULL OR char_length(note) <= 500),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_purchase_access IS
  'Admin-granted permission to START a Pro purchase (migration 033). Active = '
  'revoked_at IS NULL. Written only by admin_grant_purchase_access / '
  'admin_revoke_purchase_access (service role), each of which also writes the '
  'matching admin_audit_log row in the same transaction. Read by '
  '/api/razorpay/subscription via the service-role client; any lookup failure '
  'is treated as "no access". Never gates the webhook, /verify or /cancel.';

-- --------------------------------------------------------------------------- 2.
-- Replace the two CHECKs from migration 029 (default names) with supersets.
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN (
    'c6_promote', 'c6_reject',
    'opportunity_force_expire',
    'admin_grant', 'admin_revoke',
    'purchase_access_grant', 'purchase_access_revoke'
  ));
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_target_type_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_target_type_check
  CHECK (target_type IN ('discovered_company', 'opportunity', 'admin_user', 'purchase_access'));

-- --------------------------------------------------------------------------- 3.
ALTER TABLE billing_purchase_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_purchase_access FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_purchase_access_service_role_all ON billing_purchase_access;
CREATE POLICY billing_purchase_access_service_role_all ON billing_purchase_access FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON billing_purchase_access FROM PUBLIC, anon, authenticated;
GRANT ALL ON billing_purchase_access TO service_role;

-- --------------------------------------------------------------------------- 4.
-- SECURITY INVOKER: each runs with the caller's own privileges, so even a
-- mistaken EXECUTE grant would give anon/authenticated nothing (they hold no
-- privilege on either table). Fixed search_path; no dynamic SQL.
--
-- Order inside each function: lock → read current state → write the audit
-- row → change access. Any error at any step aborts the whole transaction,
-- so the audit row and the access change commit together or not at all.
--
-- Concurrency: a transaction-scoped advisory lock keyed on the target user
-- serializes every grant/revoke for that user (including the first grant,
-- when no row exists yet to lock). The second of two concurrent identical
-- calls therefore sees the first one's result and returns changed=false.

CREATE OR REPLACE FUNCTION admin_grant_purchase_access(
  p_target_user_id uuid,
  p_admin_id       uuid,
  p_admin_email    text,
  p_note           text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before billing_purchase_access%ROWTYPE;
  v_found  boolean;
BEGIN
  IF p_target_user_id IS NULL OR p_admin_id IS NULL OR coalesce(btrim(p_admin_email), '') = '' THEN
    RAISE EXCEPTION 'target user, admin id and admin email are required' USING ERRCODE = '22023';
  END IF;

  -- Defense in depth: the acting admin must still be active, checked inside
  -- this same transaction (the route has already checked via
  -- getAuthenticatedAdmin; this closes the revoke-mid-request window).
  PERFORM 1 FROM admin_users WHERE id = p_admin_id AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'acting user is not an active admin' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing_purchase_access:' || p_target_user_id::text, 0));

  SELECT * INTO v_before FROM billing_purchase_access WHERE user_id = p_target_user_id;
  v_found := FOUND;
  IF v_found AND v_before.revoked_at IS NULL THEN
    RETURN jsonb_build_object('changed', false, 'active', true);
  END IF;

  INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, before_state, after_state, reason)
  VALUES (
    p_admin_id, p_admin_email, 'purchase_access_grant', 'purchase_access', p_target_user_id::text,
    CASE WHEN v_found THEN jsonb_build_object('active', false, 'revoked_at', v_before.revoked_at) ELSE NULL END,
    jsonb_build_object('active', true),
    p_note
  );

  INSERT INTO billing_purchase_access
    (user_id, granted_by_admin_id, granted_by_email, granted_at, revoked_at, revoked_by_admin_id, revoked_by_email, note, updated_at)
  VALUES
    (p_target_user_id, p_admin_id, p_admin_email, now(), NULL, NULL, NULL, p_note, now())
  ON CONFLICT (user_id) DO UPDATE SET
    granted_by_admin_id = EXCLUDED.granted_by_admin_id,
    granted_by_email    = EXCLUDED.granted_by_email,
    granted_at          = EXCLUDED.granted_at,
    revoked_at          = NULL,
    revoked_by_admin_id = NULL,
    revoked_by_email    = NULL,
    note                = EXCLUDED.note,
    updated_at          = EXCLUDED.updated_at;

  RETURN jsonb_build_object('changed', true, 'active', true);
END
$$;

CREATE OR REPLACE FUNCTION admin_revoke_purchase_access(
  p_target_user_id uuid,
  p_admin_id       uuid,
  p_admin_email    text,
  p_note           text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before billing_purchase_access%ROWTYPE;
BEGIN
  IF p_target_user_id IS NULL OR p_admin_id IS NULL OR coalesce(btrim(p_admin_email), '') = '' THEN
    RAISE EXCEPTION 'target user, admin id and admin email are required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM admin_users WHERE id = p_admin_id AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'acting user is not an active admin' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing_purchase_access:' || p_target_user_id::text, 0));

  SELECT * INTO v_before FROM billing_purchase_access WHERE user_id = p_target_user_id;
  IF NOT FOUND OR v_before.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('changed', false, 'active', false);
  END IF;

  INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, before_state, after_state, reason)
  VALUES (
    p_admin_id, p_admin_email, 'purchase_access_revoke', 'purchase_access', p_target_user_id::text,
    jsonb_build_object('active', true, 'granted_at', v_before.granted_at, 'granted_by_email', v_before.granted_by_email),
    jsonb_build_object('active', false),
    p_note
  );

  UPDATE billing_purchase_access SET
    revoked_at          = now(),
    revoked_by_admin_id = p_admin_id,
    revoked_by_email    = p_admin_email,
    updated_at          = now()
  WHERE user_id = p_target_user_id;

  RETURN jsonb_build_object('changed', true, 'active', false);
END
$$;

-- --------------------------------------------------------------------------- 5.
-- Read-only (STABLE, a single SELECT over the system catalogs), fixed scope
-- (the object names below are literals — no parameters, no dynamic SQL).
CREATE OR REPLACE FUNCTION billing_access_security_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'tables', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'table', c.relname,
        'rls_enabled', c.relrowsecurity,
        'rls_forced', c.relforcerowsecurity,
        'owner', pg_get_userbyid(c.relowner),
        'privileges', jsonb_build_object(
          'anon', jsonb_build_object(
            'select', has_table_privilege('anon', c.oid, 'SELECT'),
            'insert', has_table_privilege('anon', c.oid, 'INSERT'),
            'update', has_table_privilege('anon', c.oid, 'UPDATE'),
            'delete', has_table_privilege('anon', c.oid, 'DELETE'),
            'truncate', has_table_privilege('anon', c.oid, 'TRUNCATE'),
            'references', has_table_privilege('anon', c.oid, 'REFERENCES'),
            'trigger', has_table_privilege('anon', c.oid, 'TRIGGER')),
          'authenticated', jsonb_build_object(
            'select', has_table_privilege('authenticated', c.oid, 'SELECT'),
            'insert', has_table_privilege('authenticated', c.oid, 'INSERT'),
            'update', has_table_privilege('authenticated', c.oid, 'UPDATE'),
            'delete', has_table_privilege('authenticated', c.oid, 'DELETE'),
            'truncate', has_table_privilege('authenticated', c.oid, 'TRUNCATE'),
            'references', has_table_privilege('authenticated', c.oid, 'REFERENCES'),
            'trigger', has_table_privilege('authenticated', c.oid, 'TRIGGER'))),
        -- Column-level grants (e.g. GRANT SELECT (email) ON t TO authenticated)
        -- are invisible to has_table_privilege, so report them separately.
        'column_privileges', jsonb_build_object(
          'anon', jsonb_build_object(
            'select', has_any_column_privilege('anon', c.oid, 'SELECT'),
            'insert', has_any_column_privilege('anon', c.oid, 'INSERT'),
            'update', has_any_column_privilege('anon', c.oid, 'UPDATE'),
            'references', has_any_column_privilege('anon', c.oid, 'REFERENCES')),
          'authenticated', jsonb_build_object(
            'select', has_any_column_privilege('authenticated', c.oid, 'SELECT'),
            'insert', has_any_column_privilege('authenticated', c.oid, 'INSERT'),
            'update', has_any_column_privilege('authenticated', c.oid, 'UPDATE'),
            'references', has_any_column_privilege('authenticated', c.oid, 'REFERENCES'))),
        'policies', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'name', p.polname,
            'command', p.polcmd::text,
            'permissive', p.polpermissive,
            'roles', (SELECT jsonb_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY 1) FROM unnest(p.polroles) AS r),
            'using', pg_get_expr(p.polqual, p.polrelid),
            'with_check', pg_get_expr(p.polwithcheck, p.polrelid)
          ) ORDER BY p.polname), '[]'::jsonb)
          FROM pg_policy p WHERE p.polrelid = c.oid)
      ) ORDER BY c.relname), '[]'::jsonb)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN ('admin_users', 'admin_audit_log', 'billing_purchase_access')
    ),
    'functions', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'function', f.proname,
        'arguments', pg_get_function_identity_arguments(f.oid),
        'security_definer', f.prosecdef,
        'volatility', f.provolatile::text,
        'owner', pg_get_userbyid(f.proowner),
        'config', to_jsonb(f.proconfig),
        'execute', jsonb_build_object(
          'public', (f.proacl IS NULL OR EXISTS (
            SELECT 1 FROM aclexplode(f.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
          'anon', has_function_privilege('anon', f.oid, 'EXECUTE'),
          'authenticated', has_function_privilege('authenticated', f.oid, 'EXECUTE'),
          'service_role', has_function_privilege('service_role', f.oid, 'EXECUTE'))
      ) ORDER BY f.proname), '[]'::jsonb)
      FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace
      WHERE n.nspname = 'public'
        AND f.proname IN ('admin_grant_purchase_access', 'admin_revoke_purchase_access', 'billing_access_security_report')
    )
  );
$$;

-- Execution: service_role only. Supabase's default privileges grant EXECUTE
-- on new public functions to anon/authenticated, so revoke those explicitly.
REVOKE ALL ON FUNCTION admin_grant_purchase_access(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin_revoke_purchase_access(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing_access_security_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_grant_purchase_access(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION admin_revoke_purchase_access(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION billing_access_security_report() TO service_role;

-- ==============================================================================
-- DOWN (documented, not executed). Dropping the table closes purchases for
-- everyone (the route treats a missing table as "no access"):
--   DROP FUNCTION IF EXISTS billing_access_security_report();
--   DROP FUNCTION IF EXISTS admin_revoke_purchase_access(uuid, uuid, text, text);
--   DROP FUNCTION IF EXISTS admin_grant_purchase_access(uuid, uuid, text, text);
--   DROP TABLE IF EXISTS billing_purchase_access;
--   -- Restore 029's CHECKs only after deleting any purchase_access_* audit rows.
-- ==============================================================================
