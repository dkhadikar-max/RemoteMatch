-- V2 P0 M2/M3 -- OPTIONAL manual pre-apply for the three unique indexes added by
-- 20261112185212_v2_p0_m2_m3_application_lifecycle.sql.
--
-- NOT RUN anywhere. NOT part of `supabase db push` / the migrations directory.
-- Needs explicit approval, same as docs/v2-m3-legacy-diagnostics.sql and
-- docs/v2-m4-event-writer-preflight.sql.
--
-- Why this file exists: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block (hard Postgres rule). The migrations directory is applied as a single
-- transactional script (supabase db push, or a dashboard SQL editor run of the
-- whole file), so CONCURRENTLY cannot be added there without making the whole
-- migration fail to apply. If applications/employer_job_applications/
-- application_events are expected to carry enough production rows that a plain
-- (non-concurrent) CREATE UNIQUE INDEX would hold an ACCESS EXCLUSIVE lock for
-- longer than is acceptable, run the three statements below FIRST, one at a
-- time, each as its own separate statement/connection (psql with autocommit, or
-- the Supabase dashboard SQL editor's "run selection" on exactly one statement --
-- never paste this whole file and run it as one multi-statement submission,
-- which Postgres treats as an implicit transaction block and CONCURRENTLY will
-- still fail inside it).
--
-- After these are built, 20261112185212's own CREATE UNIQUE INDEX IF NOT EXISTS
-- statements will see the index already exists (same name) and no-op, so running
-- the normal migration afterward is safe either way.
--
-- If a CONCURRENTLY build fails partway, Postgres leaves an INVALID index behind;
-- `DROP INDEX IF EXISTS <name>;` it before retrying (also must be its own
-- statement, outside a transaction, same reason as above).

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_eja_candidate_opportunity
  ON public.employer_job_applications(candidate_profile_id, opportunity_id);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_eja_candidate_application
  ON public.employer_job_applications(candidate_application_id)
  WHERE candidate_application_id IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_application_events_direct_submission
  ON public.application_events(employer_application_id)
  WHERE event_type = 'direct_application_submitted';
