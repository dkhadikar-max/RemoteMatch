-- Resume Intelligence (PR B) — live-concurrency gate bootstrap.
-- NOT RUN. Prepared only — see docs/resume-pr-b-live-concurrency-runbook.md for when/how to run it.
--
-- SAFETY REWRITE (docs/resume-pr-b-live-concurrency-safety-fixes-2026-10-22.md): the previous
-- version of this script used `CREATE ... IF NOT EXISTS` / `CREATE OR REPLACE` throughout, which
-- means pointing it at the WRONG database (one that already has a `profiles` table, an `auth`
-- schema, or the `anon`/`authenticated`/`service_role` roles — plausible on any Supabase-shaped
-- project, not just this one) would silently reuse or overwrite whatever was already there instead
-- of refusing. This version is fail-closed instead: everything runs inside ONE transaction, and the
-- very first thing it does is ABORT THE WHOLE SCRIPT (nothing after it executes at all) if:
--   (a) no `run_tag` was supplied, or
--   (b) ANY of the objects this script is about to create already exist.
-- Only once both are confirmed does it create anything, and every CREATE below is now a plain
-- CREATE (never CREATE OR REPLACE / IF NOT EXISTS, including the pgcrypto extension — a 2026-10-22
-- fix review caught that it was the one object this script created without checking for it first)
-- — if a precondition check above ever had a gap, a plain CREATE against an already-existing
-- object errors loudly instead of silently overwriting.
--
-- Required invocation (see runbook): psql "<url>" -v run_tag="$(uuidgen)" -f 00-bootstrap.sql
-- `run_tag` is also what test/live-pg/resume-concurrency-live-suite.ts requires via
-- LIVE_PG_TEST_RUN_TAG — the harness refuses to run unless it finds a marker row in THIS database
-- whose run_tag matches exactly, proving this specific database was bootstrapped for this specific
-- run (never inferred from a connection-string label alone).

\set ON_ERROR_STOP on
BEGIN;

-- Make the run_tag available to the DO block below as a GUC (psql substitutes an unset :run_tag
-- as an empty string, which the precondition check below then correctly rejects).
SET app.resume_pr_b_run_tag = :'run_tag';

DO $preflight$
DECLARE
  v_run_tag TEXT := current_setting('app.resume_pr_b_run_tag', true);
BEGIN
  IF v_run_tag IS NULL OR length(trim(v_run_tag)) = 0 THEN
    RAISE EXCEPTION 'SAFETY ABORT: no run_tag was supplied. Invoke as: psql "<url>" -v run_tag="$(uuidgen)" -f 00-bootstrap.sql';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) THEN
    RAISE EXCEPTION 'SAFETY ABORT: role "anon", "authenticated", or "service_role" already exists on this server/database. This does not look like a fresh disposable target — refusing to bootstrap anything. If this really is disposable and you intend to reset it, drop those roles yourself first (deliberately, outside this script) and re-run.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    RAISE EXCEPTION 'SAFETY ABORT: schema "auth" already exists in this database — refusing to touch it (this script would otherwise create auth.uid(), which must never overwrite a real one).';
  END IF;
  IF to_regclass('public.profiles') IS NOT NULL THEN
    RAISE EXCEPTION 'SAFETY ABORT: table "public.profiles" already exists — this database is not empty/disposable. Refusing to reuse or modify an existing profiles table.';
  END IF;
  IF to_regclass('public.resume_versions') IS NOT NULL
     OR to_regclass('public.resume_analyses') IS NOT NULL
     OR to_regclass('public.resume_suggestion_decisions') IS NOT NULL THEN
    RAISE EXCEPTION 'SAFETY ABORT: a migration-036 table already exists in this database (resume_versions/resume_analyses/resume_suggestion_decisions) — refusing to proceed. Migration 036 must be applied AFTER this bootstrap, into a database this bootstrap has not seen before.';
  END IF;
  IF to_regclass('public._resume_pr_b_live_audit_run') IS NOT NULL THEN
    RAISE EXCEPTION 'SAFETY ABORT: this database already has a prior _resume_pr_b_live_audit_run marker — it has been used for this harness before and is not a fresh disposable target for THIS run. Use a brand-new database.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'SAFETY ABORT: extension "pgcrypto" already exists in this database. A prior fix review (docs/resume-pr-b-live-concurrency-safety-fixes-2026-10-22.md) found this script originally used CREATE EXTENSION IF NOT EXISTS here, bypassing the fail-closed pattern used everywhere else in this file. Consistency over convenience: a disposable database this script has not already touched should not have pgcrypto installed either, so refuse rather than silently reuse it.';
  END IF;
END
$preflight$;

-- All preconditions held. Nothing above created anything — everything below is a plain CREATE
-- (never IF NOT EXISTS / OR REPLACE), which will itself error loudly if any of the above checks
-- had a gap, rather than silently overwriting something real.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- auth.uid() — the exact mechanism Supabase's own Postgres image uses: PostgREST sets the GUC
-- `request.jwt.claims` (a JSON string) once per request, inside that request's transaction, via
-- `SET LOCAL`. auth.uid() reads the `sub` claim out of it. This is not a stand-in for the business
-- logic under test — every SECURITY DEFINER function in migration 036 calls this exact function;
-- we are reproducing Supabase's own auth plumbing (confirmed absent above), not mocking
-- resume-intelligence code, and not replacing anything that was already there.
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    NULL
  )::uuid
$$;

-- auth.role() — added 2026-11-02 for migration 040's resume_quota_events RLS policy (the first
-- migration in this project's history to reference auth.role() at all; 036-039 only ever needed
-- auth.uid()). Same mechanism as auth.uid() above: reads the `role` claim PostgREST itself sets
-- inside request.jwt.claims — this is Supabase's own real implementation, not a stand-in.
CREATE FUNCTION auth.role() RETURNS TEXT
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    NULL
  )::text
$$;

-- Confirmed absent above (preflight) — plain CREATE now, consistent with every other object in
-- this file, not CREATE EXTENSION IF NOT EXISTS (that silently reused one that might already be
-- configured differently; fixed per the 2026-10-22 fix review for consistency).
CREATE EXTENSION pgcrypto;

-- Minimal `profiles` table — only the columns reserve_resume_analysis()/refund_resume_analysis()
-- and upsert_resume_analysis()'s FK-ownership check actually touch. Confirmed not to already exist
-- above, so this is a genuinely new table, not a reuse of one belonging to anything else.
CREATE TABLE public.profiles (
  id                          UUID PRIMARY KEY,
  plan_tier                   TEXT NOT NULL DEFAULT 'free',
  usage_date                  DATE NOT NULL DEFAULT (timezone('utc', now()))::date,
  daily_right_swipes_count    INT NOT NULL DEFAULT 0,
  daily_proposals_count       INT NOT NULL DEFAULT 0,
  daily_evaluations_count     INT NOT NULL DEFAULT 0
);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated, service_role;

-- The marker the harness checks before it writes anything. This is what lets the TypeScript side
-- positively confirm "this exact database was deliberately bootstrapped, for this exact run" rather
-- than inferring disposability from a connection-string label. profile_id is generated HERE, server
-- side, by this run — never a hardcoded constant the harness assumes — so the harness (and its
-- cleanup) always operate on an id this run itself produced and can prove it produced.
CREATE TABLE public._resume_pr_b_live_audit_run (
  run_tag    TEXT PRIMARY KEY,
  profile_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public._resume_pr_b_live_audit_run (run_tag, profile_id)
VALUES (current_setting('app.resume_pr_b_run_tag', true), gen_random_uuid());

INSERT INTO public.profiles (id, plan_tier)
SELECT profile_id, 'free' FROM public._resume_pr_b_live_audit_run
WHERE run_tag = current_setting('app.resume_pr_b_run_tag', true);

COMMIT;

-- Next step (see runbook): apply supabase/migrations/036_resume_intelligence.sql verbatim,
-- unmodified, against this SAME database. Then run the harness with LIVE_PG_TEST_RUN_TAG set to
-- the exact same run_tag used above.
