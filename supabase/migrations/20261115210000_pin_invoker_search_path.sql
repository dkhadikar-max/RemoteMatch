-- P2 hardening: pin search_path on the two invoker functions flagged by the
-- Supabase performance/security advisor's mutable-search-path lint
-- (production snapshot, 2026-11-15).
--
-- public.is_valid_application_transition(text, text) and
-- public.get_application_outcome(uuid) (both from 006_outcome_lifecycle.sql)
-- are SECURITY INVOKER, not DEFINER -- a mutable search_path here cannot
-- escalate privilege (invoker functions already run with the caller's own
-- search_path and permissions). Checked exploitability before touching
-- anything: migration 009_lock_down_readonly_helpers.sql already revokes
-- ALL privileges on both from PUBLIC, anon, AND authenticated, and that
-- migration's own comment confirms zero call sites in application code.
-- This migration is pure hygiene (silence the advisor, defense in depth for
-- get_application_outcome's unqualified application_events/applications
-- references) -- it does not change, grant, or revoke any privilege; the
-- existing lockdown from 009 is untouched and unconditionally preserved.
--
-- Not applied to production. No live verification was run against an
-- isolated project (no credentials in this environment) -- that
-- confirmation step is still needed before rollout.

DO $preflight$
BEGIN
  IF to_regprocedure('public.is_valid_application_transition(text, text)') IS NULL THEN
    RAISE EXCEPTION 'preflight failed: public.is_valid_application_transition(text, text) not found';
  END IF;
  IF to_regprocedure('public.get_application_outcome(uuid)') IS NULL THEN
    RAISE EXCEPTION 'preflight failed: public.get_application_outcome(uuid) not found';
  END IF;
END;
$preflight$;

ALTER FUNCTION public.is_valid_application_transition(text, text)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.get_application_outcome(uuid)
  SET search_path = pg_catalog, public;

-- Explicit, defensive re-statement of the existing lockdown from 009 --
-- not a new restriction, just making this migration self-contained so a
-- reviewer doesn't have to cross-reference 009 to confirm nothing here
-- changed those grants.
DO $verify_grants$
DECLARE
  v_problems text[] := ARRAY[]::text[];
BEGIN
  IF has_function_privilege('authenticated', 'public.is_valid_application_transition(text, text)', 'EXECUTE') THEN
    v_problems := v_problems || 'is_valid_application_transition unexpectedly executable by authenticated'::text;
  END IF;
  IF has_function_privilege('authenticated', 'public.get_application_outcome(uuid)', 'EXECUTE') THEN
    v_problems := v_problems || 'get_application_outcome unexpectedly executable by authenticated'::text;
  END IF;
  IF array_length(v_problems, 1) > 0 THEN
    RAISE EXCEPTION 'search_path pin migration found an unexpected grant change: %', array_to_string(v_problems, ' | ');
  END IF;
END;
$verify_grants$;

-- ROLLBACK (manual, not automated -- operator reference only):
--   ALTER FUNCTION public.is_valid_application_transition(text, text) RESET search_path;
--   ALTER FUNCTION public.get_application_outcome(uuid) RESET search_path;
-- Safe at any time: ALTER FUNCTION ... SET/RESET search_path is a metadata-
-- only catalog change -- no table lock, no row rewrite, no effect on
-- currently-running transactions (they already captured whatever search_path
-- was in effect when they started; only NEW calls after a commit see the
-- change either direction). Both functions are read-only (one is a pure
-- CASE expression with no table reference at all; the other is a pure
-- SELECT) and this migration does not touch their grants, so there is no
-- window where rolling back could expose or revoke access unexpectedly.
-- Unintended side effects: none identified. This migration does not alter
-- function bodies, ownership, grants, or any table; it is additive metadata
-- only, and the verify_grants block above makes the whole file fail closed
-- (one transaction) if any of those assumptions turn out to be wrong on the
-- target database.
