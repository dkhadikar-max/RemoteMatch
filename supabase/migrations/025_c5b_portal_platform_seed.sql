-- ==============================================================================
-- RemoteMatch — 025: C5-B job-portal platform seed
-- (C:\Users\dell\.claude\plans\vivid-hatching-kitten.md, real-verified
-- acquisition source audit, 2026-09-15)
--
-- Pure DML, zero DDL — no table, column, or constraint change. Same shape
-- and reasoning as migration 019's `careerpage` seed: WeWorkRemotelyProvider
-- and HimalayasProvider (src/lib/providers/weworkremotely.ts,
-- src/lib/providers/himalayas.ts) need their `supply_platforms.slug` FK
-- target to exist before any real sync writes an `opportunities.source`
-- value referencing them.
--
-- source_type='provider', kind='aggregator' — identical values to the
-- existing remotive/arbeitnow/jobicy rows (migration 012), since these are
-- the same conceptual shape: a public API/feed aggregating many
-- independent employers, not a per-employer discovered career page (C5-A's
-- 'discovered_source'/'career_feed' shape) and not a C3 ATS.
--
-- Both slugs ('weworkremotely', 'himalayas') are already lowercase
-- alphanumeric with no hyphen/underscore, so — unlike C5-A's 'careerpage'
-- correction in migration 019 — no spelling adjustment is needed against
-- the `slug ~ '^[a-z0-9]+$'` CHECK constraint (migration 012, frozen).
--
-- Idempotent (`ON CONFLICT (slug) DO NOTHING`), matching every prior seed
-- migration's own pattern exactly.
-- ==============================================================================

INSERT INTO supply_platforms (slug, display_name, source_type, kind) VALUES
  ('weworkremotely', 'We Work Remotely', 'provider', 'aggregator'),
  ('himalayas',       'Himalayas',        'provider', 'aggregator')
ON CONFLICT (slug) DO NOTHING;

-- ==============================================================================
-- DOWN:
--   DELETE FROM supply_platforms WHERE slug IN ('weworkremotely', 'himalayas');
--   -- Only safe once no `opportunities.source` row references either slug
--   -- (the FK from opportunities.source -> supply_platforms.slug is
--   -- ON DELETE RESTRICT, per migration 012) — i.e. only before the C5-B
--   -- pilot is ever actually run against real production data, or after
--   -- every row from these two sources has been removed.
-- ==============================================================================
