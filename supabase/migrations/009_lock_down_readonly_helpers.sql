-- ==============================================================================
-- RemoteMatch — 009: lock down the two read-only outcome-lifecycle helpers
--
-- get_application_outcome() and is_valid_application_transition() (both from
-- 006_outcome_lifecycle.sql) were created without an explicit REVOKE/GRANT,
-- so they retained Postgres's default PUBLIC-executable privilege on newly
-- created functions. Call-site audit before this migration:
--
--   - get_application_outcome(): zero call sites in src/ application code.
--     Only ever invoked via the service-role (admin) client in
--     test/outcome-lifecycle-suite.ts, which bypasses grants entirely, and
--     referenced only in a comment in src/app/tracker/page.tsx.
--   - is_valid_application_transition(): zero call sites in src/ application
--     code. Only ever called internally, from within
--     transition_application_status() and record_application_feedback()
--     (006/007/008) — those calls run under the calling function's own
--     owner privileges, not the invoking client's, so they need no grant to
--     `authenticated` at all.
--
-- Neither function has a legitimate current reason to be callable by any
-- client role. This migration removes the accidental PUBLIC-execute default
-- from both, for all three roles that could otherwise reach it. This is a
-- pure grant change — no function body, transition rule, or CAS logic is
-- touched.
-- ==============================================================================

REVOKE ALL ON FUNCTION public.get_application_outcome(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_valid_application_transition(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
