-- ==============================================================================
-- RemoteMatch — 029: Admin Console foundation
--
-- Per the approved admin.remotematch.online implementation plan. Additive and
-- downstream-safe — touches no existing table. No app-level role/permission
-- concept has ever existed in this schema (confirmed by inspection across all
-- 28 prior migrations); this migration creates the first one, from scratch,
-- specifically for the new internal admin console. Nothing here grants the
-- `authenticated` or `anon` role anything — every admin table is service-role
-- only, exactly matching the established pattern from migrations 012/013/026.
--
-- Two tables:
--   1. admin_users       — who is an admin. Soft-revoke (revoked_at), not
--                          DELETE, so the audit trail of who was ever an
--                          admin survives a later revocation.
--   2. admin_audit_log   — what every admin did. Append-only in practice
--                          (no UPDATE/DELETE policy path is exposed by the
--                          admin app itself), closed-vocabulary `action`
--                          field rather than free text, before/after state
--                          captured as jsonb for privileged mutations.
--
-- Deliberately NOT seeded with any email/user id here — the first admin row
-- is a separate, explicit, authorized step taken after this migration is
-- live (see docs/admin-console-plan — the "Remaining steps" section),
-- exactly like every other production data seed this project has done.
-- ==============================================================================

-- --------------------------------------------------------------------------- 1.
CREATE TABLE IF NOT EXISTS admin_users (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  granted_by  text,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE admin_users IS
  'Membership table for the internal admin console (admin.remotematch.online). '
  'An "active" admin is a row with revoked_at IS NULL. Soft-revoke only — a row '
  'is never deleted, preserving who was ever granted admin access and by whom. '
  'No RLS policy anywhere references this table (none existed before this '
  'migration) — admin authorization is enforced entirely server-side, in '
  'src/lib/auth/get-authenticated-admin.ts, via the service-role client.';

CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(id) WHERE revoked_at IS NULL;

-- --------------------------------------------------------------------------- 2.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id     uuid NOT NULL,
  admin_email  text NOT NULL,
  action       text NOT NULL
                 CHECK (action IN (
                   'c6_promote', 'c6_reject',
                   'opportunity_force_expire',
                   'admin_grant', 'admin_revoke'
                 )),
  target_type  text NOT NULL
                 CHECK (target_type IN ('discovered_company', 'opportunity', 'admin_user')),
  target_id    text NOT NULL,
  before_state jsonb,
  after_state  jsonb,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE admin_audit_log IS
  'Append-only record of every privileged admin mutation. admin_id is NOT a '
  'foreign key to admin_users — a row must remain fully readable even after '
  'the acting admin is later revoked or their auth.users row is ever removed; '
  'admin_email is captured at write time as the durable label. Closed '
  '`action`/`target_type` vocabulary by design (mirrors ai_call_events\' '
  '`outcome` CHECK, migration 022) — extend the CHECK constraint in a future '
  'migration as new privileged actions are added, never widen it to free text.';

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target ON admin_audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON admin_audit_log(admin_id);

-- ------------------------------------------------------------------------------
-- 3. RLS — service-role only, identical shape to migrations 012/013/026.
-- ------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_users', 'admin_audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY %1$I ON %2$I FOR ALL
        USING (auth.role() = 'service_role')
        WITH CHECK (auth.role() = 'service_role')
    $p$, t || '_service_role_all', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON %I TO service_role', t);
  END LOOP;
END
$$;

-- ==============================================================================
-- DOWN (documented, not executed):
--   DROP TABLE IF EXISTS admin_audit_log;
--   DROP TABLE IF EXISTS admin_users;
-- ==============================================================================
