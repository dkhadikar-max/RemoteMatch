-- Resume Intelligence (PR B) — least-privilege ACL hardening for 3 of migration 036's 5 RPCs.
--
-- NOT APPLIED. Prepared only, pending review and separate authorization — see
-- docs/resume-pr-b-live-migration-acl-fix-2026-10-22.md for the finding this fixes and
-- docs/resume-pr-b-final-audit-2026-10-22.md / docs/resume-pr-b-live-concurrency-runbook.md for
-- the broader context (live migration 036 apply against a disposable instance surfaced this).
--
-- FINDING: migration 036 explicitly does `REVOKE ALL ... FROM PUBLIC, anon` before granting
-- EXECUTE to `authenticated` for reserve_resume_analysis() and refund_resume_analysis() — but NOT
-- for create_resume_version(), upsert_resume_analysis(), or record_resume_suggestion_decision().
-- Postgres grants EXECUTE to PUBLIC by default on function creation; without an explicit REVOKE,
-- that default survives the migration's own `GRANT ... TO authenticated` (a GRANT never removes
-- an existing grantee). Live introspection against the disposable instance
-- (postgresql://postgres@127.0.0.1:5433/postgres, migration 036 applied 2026-10-22) confirmed all
-- three still carry `PUBLIC` in `information_schema.routine_privileges`, something no prior
-- source-pattern/static check in this repo ever looked for (every existing check only asserted the
-- PRESENCE of the `authenticated` grant and the ABSENCE of a `service_role` grant — never the
-- absence of the separate, implicit PUBLIC default).
--
-- IMPACT ASSESSED AS LOW, NOT ZERO: all three functions derive identity exclusively from
-- auth.uid() internally and raise 'unauthenticated' (28000) immediately when it's null, so an
-- unauthenticated caller reaching the function through the PUBLIC grant gains no data or write
-- access — but this is still looser than the migration's own stated intent and inconsistent with
-- the pattern it already uses correctly for the other two RPCs in the same file.
--
-- WHY A NEW FORWARD MIGRATION, NOT AN EDIT TO 036: migration 036 has already been applied to the
-- disposable instance (and, per the project's own migration discipline, migration files are never
-- edited after being applied anywhere — see every prior migration in this directory, none of which
-- has ever been retroactively modified). A forward migration preserves that history and is safe to
-- apply to any database that already has 036, in any order relative to other future migrations
-- that don't touch these same three functions.
--
-- Exact signatures (confirmed by direct source read of 036_resume_intelligence.sql, unchanged):
--   public.create_resume_version(text, text, text, uuid)
--   public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric)
--   public.record_resume_suggestion_decision(uuid, text, text, text)

-- Supabase SQL Editor does not support psql meta-commands; execution errors stop the submitted statement batch.
BEGIN;

REVOKE ALL ON FUNCTION public.create_resume_version(text, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.upsert_resume_analysis(
  uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_resume_suggestion_decision(uuid, text, text, text) FROM PUBLIC, anon;

-- Re-grant EXECUTE to authenticated explicitly (REVOKE ALL above also removes it, since it was
-- granted via the PUBLIC-inherited default plus 036's own explicit `TO authenticated` — re-asserting
-- it here, idempotently, is cheap insurance against relying on grant ordering/inheritance subtlety).
GRANT EXECUTE ON FUNCTION public.create_resume_version(text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_resume_analysis(
  uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_resume_suggestion_decision(uuid, text, text, text) TO authenticated;

-- The owning/admin role (whatever created these functions — "postgres" on the disposable instance,
-- the project's usual migration-applying role elsewhere) always retains EXECUTE as the function
-- owner; REVOKE ALL above does not and cannot remove owner privilege, so no explicit re-grant for
-- it is needed or added here.

COMMIT;

-- DOWN (manual, not automated):
--   GRANT EXECUTE ON FUNCTION public.create_resume_version(text, text, text, uuid) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric) TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.record_resume_suggestion_decision(uuid, text, text, text) TO PUBLIC;
--   (restores the original, looser default — not expected to ever be needed)
