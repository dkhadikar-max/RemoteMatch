-- ==============================================================================
-- RemoteMatch — 019: career-page platform seed (Supply Discovery gate C5)
--
-- Pure DML, zero DDL — no table, column, or constraint change. This exists
-- solely so a FRESH environment (a rebuild, a new Supabase project, or a
-- migration replay) gets the one `supply_platforms` row C5's career-page
-- provider (src/lib/providers/career-page.ts) requires as its
-- `opportunities.source` FK target, without depending on an undocumented,
-- one-off manual INSERT run during implementation.
--
-- `slug='careerpage'`, not this feature's spec-document spelling
-- `career_page` — `supply_platforms.slug` is CHECK-constrained to
-- `^[a-z0-9]+$` (migration 012, frozen), which rejects an underscore.
-- `careerpage` is the compliant spelling and is what
-- `RawJobPayload.source` / `JobProvider.sourceKey` / `opportunities.source`
-- actually use throughout the C5 implementation
-- (docs/c5-implementation-plan.md §3, corrected there to match).
--
-- Idempotent (`ON CONFLICT (slug) DO NOTHING`), matching migration 012's own
-- seed-block pattern exactly. Production already carries this exact row
-- (inserted directly during C5 implementation verification, prior to this
-- migration file existing) — applying this migration against production is
-- therefore a documented no-op, not a fresh mutation.
--
-- NOTE, flagged rather than silently fixed here: `greenhouse` / `lever` /
-- `ashby` (Supply Discovery gate C3) have the SAME gap today — those three
-- `supply_platforms` rows were also inserted directly during C3
-- implementation and were never captured in a migration file, so a fresh
-- environment replaying 001–018 today would be missing all three. Left
-- untouched here deliberately, per "do not alter C3" — this migration is
-- scoped to exactly what C5 requires. Worth a separate, explicit decision
-- from Deep on whether to backfill that gap in its own migration.
-- ==============================================================================

INSERT INTO supply_platforms (slug, display_name, source_type, kind) VALUES
  ('careerpage', 'Company Career Pages', 'discovered_source', 'career_feed')
ON CONFLICT (slug) DO NOTHING;

-- ==============================================================================
-- DOWN:
--   DELETE FROM supply_platforms WHERE slug = 'careerpage';
--   -- Only safe once no `opportunities.source = 'careerpage'` row exists
--   -- (the FK from opportunities.source -> supply_platforms.slug is
--   -- ON DELETE RESTRICT, per migration 012) — i.e. only before C5 is ever
--   -- actually run against a real employer, or after every careerpage-
--   -- sourced opportunity has been removed.
-- ==============================================================================
