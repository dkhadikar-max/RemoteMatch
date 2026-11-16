-- ==============================================================================
-- RemoteMatch — 047: transition_company_verification_with_audit() — atomic
-- status transition + audit-log write
--
-- Fixes a review finding raised TWICE on PR #49 (Direct Employer Supply,
-- Phase 1): the admin verification-status PATCH committed the `companies`
-- status transition and the `admin_audit_log` insert as two separate
-- writes. The 2026-11-06 remediation made a failed audit write VISIBLE
-- (checked result, logged, `auditLogged: false` in the response) but did
-- not make the two writes atomic — a company could still end up verified/
-- rejected/suspended/reinstated with no corresponding audit row if the
-- second write failed for any reason. This migration closes that gap at
-- the right layer: both writes now happen inside ONE Postgres function
-- call (one transaction) — either both commit or neither does.
--
-- The compare-and-swap semantics from migration-044-era application code
-- move into this function too (`p_expected_status`): the UPDATE is
-- conditioned on the row's CURRENT status matching what the caller last
-- observed, exactly as the route's own CAS logic did. `transitioned =
-- false` (zero rows updated) means the race was lost — the function
-- returns without touching admin_audit_log at all, so a lost race still
-- never produces a misleading "successful transition" audit row.
--
-- Deliberately NOT replicated here: which `(action, expected_from_states,
-- to_status)` combinations are valid (migration 044's TRANSITIONS map in
-- company-verifications/[id]/route.ts). That stays pure application logic
-- — this function only enforces the single database-level invariant (the
-- compare-and-swap + audit atomicity), not Phase 1's business rules about
-- which transitions exist. The route still rejects an invalid action/
-- state combination before ever calling this function.
--
-- SECURITY INVOKER: called only by the service-role client from inside
-- PATCH /api/admin/company-verifications/[id], itself already gated by
-- getAuthenticatedAdmin() before this RPC is ever reached. REVOKE below
-- confirms no end-user session path exists.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.transition_company_verification_with_audit(
  p_company_id uuid,
  p_expected_status text,
  p_new_status text,
  p_reviewed_by text,
  p_reason text,
  p_admin_id uuid,
  p_admin_email text,
  p_audit_action text
) RETURNS TABLE (transitioned boolean, verification_status text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE companies
  SET verification_status = p_new_status,
      verification_reviewed_at = now(),
      verification_reviewed_by = p_reviewed_by,
      verification_reason = p_reason,
      updated_at = now()
  WHERE companies.id = p_company_id AND companies.verification_status = p_expected_status
  RETURNING companies.verification_status INTO v_status;

  IF NOT FOUND THEN
    -- Lost the compare-and-swap race (or the row doesn't exist) — no
    -- audit row, no transition. The caller re-reads the real current
    -- status itself; this function doesn't need to report it.
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  -- Same transaction as the UPDATE above: if this insert fails for any
  -- reason, the whole function call rolls back, including the UPDATE —
  -- a company whose status change can't be audited simply doesn't
  -- transition at all, rather than transitioning silently unaudited.
  INSERT INTO admin_audit_log (
    admin_id, admin_email, action, target_type, target_id,
    before_state, after_state, reason
  ) VALUES (
    p_admin_id, p_admin_email, p_audit_action, 'company', p_company_id::text,
    jsonb_build_object('verification_status', p_expected_status),
    jsonb_build_object('verification_status', p_new_status),
    p_reason
  );

  RETURN QUERY SELECT true, v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_company_verification_with_audit FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_company_verification_with_audit TO service_role;

COMMENT ON FUNCTION public.transition_company_verification_with_audit IS
  'Atomic compare-and-swap status transition + admin_audit_log insert for '
  'Direct Employer Supply company verification. service_role only, called '
  'exclusively from PATCH /api/admin/company-verifications/[id] after '
  'getAuthenticatedAdmin() and the route''s own action/transition validity '
  'check have already run. transitioned=false means the row''s current '
  'status no longer matched p_expected_status (lost race or not found) — '
  'nothing was written, including no audit row.';

-- ==============================================================================
-- DOWN (documented recovery — this repo does not auto-run downs)
-- ------------------------------------------------------------------------------
-- DROP FUNCTION IF EXISTS public.transition_company_verification_with_audit(
--   uuid, text, text, text, text, uuid, text, text
-- );
-- No data loss on rollback: this migration defines a function only, no
-- table/column/constraint changes.
-- ==============================================================================
