-- ==============================================================================
-- RemoteMatch — 012: Additional Supply Discovery registry (Phase B, gate C1)
--
-- Per the signed C1 implementation plan (docs/c1-implementation-plan.md) and its
-- Review-1 decisions:
--   Q1  opportunities.source = ATS PLATFORM ('greenhouse'|'lever'|'ashby'|the
--       four existing feeds), NOT a per-employer value. Low-cardinality.
--   Q2  opportunities.source gains a real FK (it was TEXT NOT NULL with NO
--       database constraint — the 4-value union was a TypeScript fiction).
--   Q3  a generated `canonical_id` column replaces the fragile
--       /^opp-([a-z]+)-(.+)$/ parser in catalog-read.ts.
--   Q4  sourceQuality is nullable for a not-yet-scored source (no unsupported
--       quality claim) — handled in application code, not here.
--   Q5  every new table carries the `supply_` domain prefix.
--   Q6  `public_feed` is a distinct permission_basis for the 3 aggregator APIs.
--   Q7  allowlist_employers is created empty; C3 populates it.
--   Q9  per-employer/board endpoints live in a SEPARATE table from the platform.
--
-- IMPLEMENTATION NOTE (flagged for review): the plan sketched a single
-- `supply_sources` table with `slug UNIQUE` plus an added `board` column. That
-- is self-contradictory — a `slug` that is the FK target for
-- `opportunities.source` must be unique, so it cannot also have one row per
-- (slug, board). Resolved exactly as the Q1/Q9 sign-off worded it ("the
-- discovery registry remains platform-oriented, while the employer/board
-- identity lives separately"):
--   * supply_platforms  — one row per platform; `slug` UNIQUE; the FK target.
--   * supply_sources    — one row per acquirable endpoint (platform + board);
--                          the discovery/reliability/review registry.
--
-- Additive and downstream-safe: no existing table's columns, policies, grants,
-- or data are altered except (a) an FK added to opportunities.source, validated
-- against existing rows, and (b) a STORED generated column + unique index on
-- opportunities. Existing swipes/applications/application_events are untouched;
-- they store `opp-<source>-<source_id>` as opaque TEXT and never parse it.
--
-- Down script: see the trailing comment block.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. supply_platforms — the platform lookup. FK target for opportunities.source.
--    Grows only when a genuinely new acquisition platform is added (rare).
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supply_platforms (
  slug         text PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+$'),   -- hyphen-free, lowercase alnum
  display_name text NOT NULL,
  source_type  text NOT NULL DEFAULT 'ats'
                 CHECK (source_type IN ('provider', 'ats', 'discovered_source', 'employer_direct')),
  kind         text NOT NULL
                 CHECK (kind IN ('primary_api', 'ats_board', 'career_feed', 'aggregator')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE supply_platforms IS
  'One row per acquisition platform. supply_platforms.slug is the value stored '
  'in opportunities.source and is that column''s FK target — hence PRIMARY KEY / '
  'unique. Per-employer board endpoints live in supply_sources, not here. '
  '''employer_direct'' is a reserved source_type for the future Layer 3 track; '
  'not implemented.';

-- ------------------------------------------------------------------------------
-- 2. supply_sources — the discovery registry: one row per acquirable endpoint
--    (platform + board). Carries acquisition config, permission basis, the
--    human review trail, lifecycle status, and the reliability counters that
--    C4 will populate. C1 only seeds the 4 grandfathered feeds.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supply_sources (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_slug               text NOT NULL REFERENCES supply_platforms(slug)
                                ON UPDATE RESTRICT ON DELETE RESTRICT,
  board                       text NOT NULL DEFAULT '',   -- '' for a boardless platform feed; the ATS token otherwise
  employer_name               text,
  endpoint_template           text,
  acquisition_method          text NOT NULL DEFAULT 'http_json'
                                CHECK (acquisition_method IN ('http_json', 'http_html')),
  extraction_method           text NOT NULL DEFAULT 'native_adapter',
  supported_fields            text[] NOT NULL DEFAULT '{}',
  auth_requirement            text NOT NULL DEFAULT 'none',
  permission_basis            text NOT NULL
                                CHECK (permission_basis IN (
                                  'public_ats_read', 'public_feed', 'robots_allowed',
                                  'partner_agreement', 'manual_review')),
  review_status               text NOT NULL DEFAULT 'pending'
                                CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_at                 timestamptz,
  reviewed_by                 text,
  review_reason               text,
  status                      text NOT NULL DEFAULT 'proposed'
                                CHECK (status IN ('proposed', 'approved', 'active', 'paused', 'retired')),
  first_fetch_at              timestamptz,
  last_fetch_attempt_at       timestamptz,
  last_successful_fetch_at    timestamptz,
  last_job_seen_at            timestamptz,
  consecutive_fetch_failures  int NOT NULL DEFAULT 0,
  lifetime_jobs_ingested      int NOT NULL DEFAULT 0,
  lifetime_jobs_reached_active int NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_supply_sources_platform_board UNIQUE (platform_slug, board)
);

CREATE INDEX IF NOT EXISTS idx_supply_sources_status ON supply_sources(status);
CREATE INDEX IF NOT EXISTS idx_supply_sources_platform ON supply_sources(platform_slug);

COMMENT ON TABLE supply_sources IS
  'One row per acquirable supply endpoint (platform + board). The unit a human '
  'approves and the unit reliability/outcome learning is keyed to. board = '''' '
  'for the boardless aggregator feeds (remotive/arbeitnow/jobicy) and the '
  'curated fixture set.';

-- ------------------------------------------------------------------------------
-- 3. allowlist_employers — curated candidate employers for ATS acquisition.
--    Created empty in C1; C3 seeds ~50–100 hand-reviewed rows.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allowlist_employers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name     text NOT NULL,
  official_domain    text NOT NULL,
  career_url         text NOT NULL,
  ats_provider       text CHECK (ats_provider IN ('greenhouse', 'lever', 'ashby') OR ats_provider IS NULL),
  source_url         text,
  remote_evidence    text NOT NULL,   -- observable evidence the employer publishes remote roles
  geography_evidence text,
  review_status      text NOT NULL DEFAULT 'pending'
                       CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_at        timestamptz,
  reviewed_by        text,
  review_reason      text,
  linked_source_id   uuid REFERENCES supply_sources(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_allowlist_employers_ats_domain UNIQUE (ats_provider, official_domain)
);

-- ------------------------------------------------------------------------------
-- 4. source_discovery_events — audit trail of how each source came to exist.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_discovery_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      uuid REFERENCES supply_sources(id) ON DELETE SET NULL,
  demand_pattern jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_task     text NOT NULL
                   CHECK (agent_task IN ('candidate_proposal', 'unknown_extraction', 'manual')),
  proposal       jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision       text NOT NULL
                   CHECK (decision IN ('approved', 'rejected', 'deferred')),
  decided_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_discovery_events_source ON source_discovery_events(source_id);

-- ------------------------------------------------------------------------------
-- 5. demand_pattern_sources — which sources are known to serve which demand
--    patterns. A convenience index onto the pattern-agnostic supply_sources —
--    NOT a restriction (a source may serve patterns it was never discovered for).
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demand_pattern_sources (
  demand_pattern_key text NOT NULL,
  source_id          uuid NOT NULL REFERENCES supply_sources(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (demand_pattern_key, source_id)
);

-- ------------------------------------------------------------------------------
-- 6. RLS — every new table is service-role only. No public/authenticated path.
--    opportunities stays the ONLY publicly readable supply table (unchanged).
--    Mirrors opportunities_manage_service_role from migration 002, plus an
--    explicit REVOKE because 002's blanket GRANT only covered tables that
--    existed then (see migrations 003/009 for the same explicit-grant pattern).
-- ------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'supply_platforms', 'supply_sources', 'allowlist_employers',
    'source_discovery_events', 'demand_pattern_sources'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY %1$I ON %2$I FOR ALL
        USING (auth.role() = 'service_role')
        WITH CHECK (auth.role() = 'service_role')
    $p$, t || '_service_role_all', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON %I TO service_role', t);
  END LOOP;
END
$$;

-- ------------------------------------------------------------------------------
-- 7. Seed the 4 existing sources, grandfathered with explicit provenance.
--    MUST run before the FK in step 8.
-- ------------------------------------------------------------------------------
INSERT INTO supply_platforms (slug, display_name, source_type, kind) VALUES
  ('curated',   'Curated (editorial fixtures)', 'provider', 'primary_api'),
  ('remotive',  'Remotive',                     'provider', 'aggregator'),
  ('arbeitnow', 'Arbeitnow',                    'provider', 'aggregator'),
  ('jobicy',    'Jobicy',                       'provider', 'aggregator')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO supply_sources (
  platform_slug, board, endpoint_template, extraction_method, permission_basis,
  review_status, reviewed_at, reviewed_by, review_reason, status
) VALUES
  ('curated', '', NULL, 'editorial',
   'manual_review', 'approved', now(), 'grandfathered:migration-012',
   'Phase A provider, live in production before the registry existed', 'active'),
  ('remotive', '', 'https://remotive.com/api/remote-jobs?limit=25', 'native_adapter',
   'public_feed', 'approved', now(), 'grandfathered:migration-012',
   'Phase A provider, live in production before the registry existed', 'active'),
  ('arbeitnow', '', 'https://www.arbeitnow.com/api/job-board-api', 'native_adapter',
   'public_feed', 'approved', now(), 'grandfathered:migration-012',
   'Phase A provider, live in production before the registry existed', 'active'),
  ('jobicy', '', 'https://jobicy.com/api/v2/remote-jobs?count=25', 'native_adapter',
   'public_feed', 'approved', now(), 'grandfathered:migration-012',
   'Phase A provider, live in production before the registry existed', 'active')
ON CONFLICT (platform_slug, board) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 8. opportunities.source integrity + canonical_id.
--    Pre-check before applying in production (read-only):
--      SELECT DISTINCT source FROM opportunities;
--      -> must be a subset of {curated, remotive, arbeitnow, jobicy}
--      SELECT count(*) FROM opportunities;  -- sizes the step-8b lock (expect sub-second)
-- ------------------------------------------------------------------------------

-- 8a. FK — validated immediately against existing rows (all 4 values seeded above).
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_source_fk;
ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_source_fk
  FOREIGN KEY (source) REFERENCES supply_platforms(slug)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

-- 8b. canonical_id — STORED generated column reproducing `opp-<source>-<source_id>`
--     EXACTLY for every existing row (verified: for source='curated',
--     source_id='curated-001' -> 'opp-curated-curated-001', the value already
--     stored in swipes/applications). Replaces the /^opp-([a-z]+)-(.+)$/ parser.
--     Brief ACCESS EXCLUSIVE lock for the rewrite — sub-second at current size.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS canonical_id text
  GENERATED ALWAYS AS ('opp-' || source || '-' || source_id) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunities_canonical_id
  ON opportunities(canonical_id);

COMMENT ON COLUMN opportunities.canonical_id IS
  'Generated, STORED: ''opp-'' || source || ''-'' || source_id. The public/API '
  'identity of an opportunity, used everywhere swipes/applications/decision '
  'snapshots reference a job. Replaces the /^opp-([a-z]+)-(.+)$/ parse in '
  'catalog-read.ts — that regex could not survive a source slug outside [a-z]. '
  'Segmentable without ambiguity because supply_platforms.slug is CHECK''d '
  '^[a-z0-9]+$ (hyphen-free), but callers should match this column directly '
  'rather than parse.';

-- ==============================================================================
-- DOWN (documented recovery — this repo does not auto-run downs)
-- ------------------------------------------------------------------------------
-- DROP INDEX IF EXISTS uq_opportunities_canonical_id;
-- ALTER TABLE opportunities DROP COLUMN IF EXISTS canonical_id;
-- ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_source_fk;
-- DROP TABLE IF EXISTS demand_pattern_sources;
-- DROP TABLE IF EXISTS source_discovery_events;
-- DROP TABLE IF EXISTS allowlist_employers;
-- DROP TABLE IF EXISTS supply_sources;
-- DROP TABLE IF EXISTS supply_platforms;
-- No data loss: opportunities rows untouched (generated column + FK only);
-- swipes/applications/application_events never referenced by this migration.
-- ==============================================================================
