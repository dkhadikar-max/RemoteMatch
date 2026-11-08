-- ==============================================================================
-- RemoteMatch — 044: Employer company accounts (Phase 1 of Direct Employer
-- Supply & Verified Vacancy Publishing)
--
-- Per the signed Phase 1 implementation plan
-- (docs/direct-employer-supply-phase1-implementation-plan.md) and its Q1–Q7
-- sign-off (2026-11-05):
--   Q1  this migration does not touch the existing allowlist_employers
--       registry (migration 012) or anything under the admin "Employers"
--       nav page — that remains the unrelated ATS-source allowlist.
--   Q2  no business-email verification mechanism. `business_email` is
--       stored as submitted and reviewed manually by an admin.
--   Q3  duplicate detection is exact-domain-only (the unique index below).
--       No fuzzy/name-similarity matching.
--   Q4  a profile may belong to more than one company — no
--       UNIQUE(profile_id) on company_members.
--   Q5  pending -> under_review is an explicit admin action only, never an
--       automatic side effect of reading a record (enforced in application
--       code, not here — this migration just allows the value).
--   Q6  no re-review trigger on profile-field edits — enforced by the API
--       surface never exposing an edit route for verification-relevant
--       fields, not by anything in this migration.
--   Q7  (403 vs 404) is an application-layer decision; not relevant to schema.
--
-- Additive only: no existing table's columns, policies, grants, or data are
-- touched. Zero client-role RLS, mirroring admin_users (migration 029) and
-- the supply_* tables (migration 012) — every read/write goes through a
-- server route using the service-role client (getAuthenticatedEmployer() /
-- getAuthenticatedAdmin()), never a client-trusted claim.
--
-- Down script: see the trailing comment block.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. companies — canonical employer identity + verification state.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name                text NOT NULL,
  official_website          text NOT NULL,
  official_domain           text NOT NULL,   -- normalized host, computed server-side from official_website
  business_email            text NOT NULL,
  country_of_registration   text NOT NULL,
  registration_number       text,
  linkedin_url              text,
  industry                  text,
  company_size              text,
  description               text,
  headquarters              text,
  verification_status       text NOT NULL DEFAULT 'pending'
                              CHECK (verification_status IN ('pending', 'under_review', 'verified', 'rejected', 'suspended')),
  verification_reviewed_at  timestamptz,
  verification_reviewed_by  text,
  verification_reason       text,
  created_by                uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_official_domain ON companies (lower(official_domain));
CREATE INDEX IF NOT EXISTS idx_companies_verification_status ON companies(verification_status);

COMMENT ON TABLE companies IS
  'Canonical employer identity for the Direct Employer Supply feature (Phase '
  '1 of the Direct Employer Supply & Verified Vacancy Publishing PRD). '
  'Distinct from allowlist_employers (migration 012, curated ATS-scrape '
  'targets) and from opportunities.company (a free-text, unverified string). '
  'verification_status is the gate a future phase will require before this '
  'company''s vacancies can be promoted into opportunities; Phase 1 does not '
  'write to opportunities at all.';

-- ------------------------------------------------------------------------------
-- 2. company_members — ownership/membership + the PRD's "authorized
--    representative" fields, captured per membership row (not on companies),
--    since a company can have more than one authorized person over time.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_members (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  profile_id                    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role                          text NOT NULL DEFAULT 'owner'
                                  CHECK (role IN ('owner', 'admin', 'member')),
  representative_name           text NOT NULL,
  representative_designation    text NOT NULL,
  representative_relationship   text NOT NULL,
  status                        text NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'revoked')),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_members_company_profile UNIQUE (company_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_company_members_profile ON company_members(profile_id);
CREATE INDEX IF NOT EXISTS idx_company_members_company ON company_members(company_id);

COMMENT ON TABLE company_members IS
  'Membership/ownership of a companies row by a real profiles row, plus the '
  'representative-authorization fields the registering (or later-invited) '
  'person submitted. No single-column uniqueness on profile_id: one profile may belong to more '
  'than one company (Q4). Zero client RLS — read only via '
  'getAuthenticatedEmployer(), never a client-side self-read policy.';

-- ------------------------------------------------------------------------------
-- 3. RLS — both tables service-role only, mirroring admin_users (029) and
--    the supply_* tables (012). No authenticated-role policy of any kind.
-- ------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies', 'company_members'] LOOP
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

-- ------------------------------------------------------------------------------
-- 4. admin_audit_log — extend the two closed-vocabulary CHECKs (migrations
--    029, 033) with the Phase 1 verification actions and the new target
--    type. Same superset-replacement pattern as migration 033.
-- ------------------------------------------------------------------------------
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
  CHECK (action IN (
    'c6_promote', 'c6_reject',
    'opportunity_force_expire',
    'admin_grant', 'admin_revoke',
    'purchase_access_grant', 'purchase_access_revoke',
    'company_verify', 'company_reject', 'company_suspend', 'company_reinstate', 'company_mark_under_review'
  ));
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_target_type_check;
ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_target_type_check
  CHECK (target_type IN ('discovered_company', 'opportunity', 'admin_user', 'purchase_access', 'company'));

-- ==============================================================================
-- DOWN (documented recovery — this repo does not auto-run downs)
-- ------------------------------------------------------------------------------
-- DROP INDEX IF EXISTS idx_company_members_company;
-- DROP INDEX IF EXISTS idx_company_members_profile;
-- DROP TABLE IF EXISTS company_members;
-- DROP INDEX IF EXISTS idx_companies_verification_status;
-- DROP INDEX IF EXISTS uq_companies_official_domain;
-- DROP TABLE IF EXISTS companies;
-- ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_target_type_check;
-- ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_target_type_check
--   CHECK (target_type IN ('discovered_company', 'opportunity', 'admin_user', 'purchase_access'));
-- ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
-- ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
--   CHECK (action IN (
--     'c6_promote', 'c6_reject', 'opportunity_force_expire',
--     'admin_grant', 'admin_revoke', 'purchase_access_grant', 'purchase_access_revoke'
--   ));
-- (only valid while no admin_audit_log row uses a company_* action/target — delete first if any exist)
-- ==============================================================================
