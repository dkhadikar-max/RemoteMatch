-- ==============================================================================
-- RemoteMatch — 045: register_employer_company() — atomic registration RPC
--
-- Fixes a review finding on PR #49 (Direct Employer Supply, Phase 1): the
-- original POST /api/employer/register handler did two separate inserts
-- (companies, then company_members) with a best-effort compensating delete
-- on the second insert's failure. That left two real gaps:
--   1. A process crash between the two inserts (not just a normal query
--      failure, which WAS handled) left a permanently orphaned `companies`
--      row with no owning member, squatting the unique `official_domain`
--      forever with no recovery path.
--   2. Even on full success, a lost HTTP response gave the caller no way
--      to recover — a retry just hit the unique-domain 409.
--
-- This migration fixes gap 1 at the right layer: both inserts now run
-- inside ONE Postgres function call, which is one implicit transaction —
-- either both rows exist or neither does, with no window in between for a
-- crash to land in. Gap 2 (lost-response retry recovery) is an
-- application-layer fix in the route itself (look up whether the calling
-- user already owns a company at the attempted domain before returning a
-- bare 409) — not a schema change, so not duplicated here.
--
-- SECURITY INVOKER (not DEFINER): this function is called ONLY by the
-- service-role client from inside POST /api/employer/register, itself
-- already gated by getAuthenticatedUser() before the RPC is ever reached —
-- there is no end-user session path to this function at all (REVOKE below
-- confirms it). SECURITY INVOKER is simpler and avoids any privilege
-- escalation; service_role already has full access to both tables
-- regardless (migration 044's RLS is service-role-only to begin with).
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.register_employer_company(
  p_legal_name text,
  p_official_website text,
  p_official_domain text,
  p_business_email text,
  p_country_of_registration text,
  p_registration_number text,
  p_linkedin_url text,
  p_industry text,
  p_company_size text,
  p_description text,
  p_headquarters text,
  p_created_by uuid,
  p_representative_name text,
  p_representative_designation text,
  p_representative_relationship text
) RETURNS TABLE (id uuid, verification_status text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_status text;
BEGIN
  INSERT INTO companies (
    legal_name, official_website, official_domain, business_email,
    country_of_registration, registration_number, linkedin_url, industry,
    company_size, description, headquarters, created_by
  ) VALUES (
    p_legal_name, p_official_website, p_official_domain, p_business_email,
    p_country_of_registration, p_registration_number, p_linkedin_url, p_industry,
    p_company_size, p_description, p_headquarters, p_created_by
  )
  RETURNING companies.id, companies.verification_status INTO v_company_id, v_status;

  -- If this insert fails for any reason (it shouldn't, given the FK and
  -- NOT NULL constraints already validated by the caller), the exception
  -- propagates out of this function uncaught — Postgres rolls back the
  -- WHOLE function call, including the companies insert above. There is
  -- no code path in which the first insert survives a failure of the
  -- second: that is the entire point of this migration.
  INSERT INTO company_members (
    company_id, profile_id, role,
    representative_name, representative_designation, representative_relationship
  ) VALUES (
    v_company_id, p_created_by, 'owner',
    p_representative_name, p_representative_designation, p_representative_relationship
  );

  RETURN QUERY SELECT v_company_id, v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.register_employer_company FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_employer_company TO service_role;

COMMENT ON FUNCTION public.register_employer_company IS
  'Atomic registration: inserts companies + company_members (role=owner) in '
  'one transaction. service_role only — called exclusively from POST '
  '/api/employer/register after getAuthenticatedUser() has already run. A '
  'unique-domain violation on the companies insert raises 23505 exactly as '
  'a plain INSERT would, propagated to the caller unchanged.';

-- ==============================================================================
-- DOWN (documented recovery — this repo does not auto-run downs)
-- ------------------------------------------------------------------------------
-- DROP FUNCTION IF EXISTS public.register_employer_company(
--   text, text, text, text, text, text, text, text, text, text, text, uuid, text, text, text
-- );
-- No data loss on rollback: this migration defines a function only, no
-- table/column/constraint changes.
-- ==============================================================================
