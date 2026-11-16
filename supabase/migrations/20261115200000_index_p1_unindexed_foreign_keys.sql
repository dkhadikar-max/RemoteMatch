-- P1 of the 16 unindexed-foreign-key findings from the Supabase performance
-- advisor (production snapshot, 2026-11-15 16:16:59 UTC). This migration adds
-- only the 5 P1-prioritized indexes, not all 16 -- indexes cost storage and
-- write overhead, so the remaining 11 are deferred pending the same per-column
-- access-pattern review done here (see the follow-up P2/P3 tiers).
--
-- Why these 5, specifically (checked against actual application code, not just
-- the advisor's schema-only signal):
--
-- 1. profile_skills.profile_id -- actively read by profile_id on every profile
--    load (src/lib/profile/server-profile.ts, src/app/api/onboarding/route.ts).
--    This is the clearest, highest-confidence case: a real, frequent read path.
--
-- 2. profile_experiences.profile_id, 3. matches.opportunity_id,
--    4. application_feedback.application_id, 5. generated_materials.application_id
--    -- none of these four have an active SELECT-by-this-column path in
--    src/ today (profile_experiences is explicitly commented as untouched in
--    server-profile.ts; matches has no application code reference at all;
--    application_feedback was superseded by application_events and is now
--    write-only through migration-era code; generated_materials is
--    referenced only in a funnel-tracking comment). The justification for
--    these four is NOT read performance -- it is DELETE-cascade cost: all
--    four columns are ON DELETE CASCADE from a parent row that the
--    application does actively delete today (profiles via account deletion,
--    opportunities via reconciliation/supersession, applications via
--    rewind_last_decision()). Without a leading index on the child's FK
--    column, each such parent delete forces Postgres to sequentially scan
--    the entire child table to find cascade-eligible rows.
--
-- Deferred (P2/P3, not in this migration): the employer_job_review_events (3),
-- employer_job_submissions (3), companies.created_by, ai_quota_employer_ledger,
-- allowlist_employers, demand_pattern_sources and swipes.rewound_decision_id
-- findings -- these need the same access-pattern review before indexing,
-- which has not been done yet for them.
--
-- Not applied to production. Isolated-project verification and query-plan
-- comparison are a separate step; no live EXPLAIN was run for this migration.

DO $preflight$
BEGIN
  -- CREATE INDEX IF NOT EXISTS is itself idempotent and safe to re-run; this
  -- preflight only confirms the five target tables/columns exist with the
  -- expected names before attempting to index them, so a schema-drift
  -- mismatch fails loudly here instead of silently creating nothing.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profile_skills' AND column_name='profile_id') THEN
    RAISE EXCEPTION 'preflight failed: public.profile_skills.profile_id not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profile_experiences' AND column_name='profile_id') THEN
    RAISE EXCEPTION 'preflight failed: public.profile_experiences.profile_id not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='matches' AND column_name='opportunity_id') THEN
    RAISE EXCEPTION 'preflight failed: public.matches.opportunity_id not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='application_feedback' AND column_name='application_id') THEN
    RAISE EXCEPTION 'preflight failed: public.application_feedback.application_id not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='generated_materials' AND column_name='application_id') THEN
    RAISE EXCEPTION 'preflight failed: public.generated_materials.application_id not found';
  END IF;
END;
$preflight$;

CREATE INDEX IF NOT EXISTS idx_profile_skills_profile_id
  ON public.profile_skills (profile_id);

CREATE INDEX IF NOT EXISTS idx_profile_experiences_profile_id
  ON public.profile_experiences (profile_id);

CREATE INDEX IF NOT EXISTS idx_matches_opportunity_id
  ON public.matches (opportunity_id);

CREATE INDEX IF NOT EXISTS idx_application_feedback_application_id
  ON public.application_feedback (application_id);

CREATE INDEX IF NOT EXISTS idx_generated_materials_application_id
  ON public.generated_materials (application_id);
