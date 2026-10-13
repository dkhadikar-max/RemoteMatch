-- ==============================================================================
-- RemoteMatch — 031: funnel_events (RECONSTRUCTED)
--
-- PROVENANCE — read this first. Committed, deployed code writes to
-- `funnel_events` (src/lib/funnel/events.ts, shipped in 6bbffc9 and wired live
-- in f4ab5f8) and cites "migration 019" for its DDL. No migration in this
-- repository — or in its git history — ever created that table: the number 019
-- was taken by the career-page platform seed, so the funnel DDL was evidently
-- applied to the old production project by hand and never committed. A
-- database rebuilt from migrations 001-029 therefore lacked it entirely, and
-- every funnel write would fail (found while preparing the Supabase project
-- migration, 2026-10-12).
--
-- This file reconstructs the table from the only authoritative evidence there
-- is: its single writer (recordFunnelEvent's INSERT column list and the
-- per-event-type field allow-list in FUNNEL_EVENT_RULES), and the assertions in
-- test/funnel-event-api-suite.ts and test/funnel-emission-wiring-suite.ts
-- (profile_id nullable and ON DELETE SET NULL; created_at ordering; RLS enabled
-- with zero client policies; anon/authenticated can neither read nor write).
--
-- WHAT IS INFERRED rather than known: the exact column types (text/uuid chosen
-- to match the writer and sibling tables), the CHECK on event_type (taken from
-- the writer's four-value union), and the three indexes (the reporting script
-- that would define the real access pattern was never built).
--
-- VERIFIED 2026-10-13 against the old production table (read-only catalog diff,
-- docs/schema-equivalence-report.md): every column name, type, nullability and
-- default is IDENTICAL to the old `funnel_events`. The old table differs only in
-- being weaker than this file: it has no secondary indexes, RLS enabled but not
-- forced, no policy, and keeps anon/authenticated table privileges (blocked in
-- practice by RLS). This file's three indexes, FORCE RLS, service-role policy and
-- revoked grants are deliberate hardening; application behaviour is unchanged
-- (the only writer is the service-role client).
--
-- Idempotent (IF NOT EXISTS), DDL only, no data. Same service-role-only RLS
-- shape as migrations 012/013/026/029.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS funnel_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     text NOT NULL
                   CHECK (event_type IN ('landing_viewed', 'signup_attributed', 'feed_viewed', 'job_viewed')),
  -- NULL pre-signup (landing_viewed). SET NULL, not CASCADE: deleting an account
  -- must not delete the funnel history it generated.
  profile_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  -- Opaque client-generated id (^[A-Za-z0-9-]{8,100}$) bridging the anonymous
  -- browsing session to the account created from it. Never an auth session,
  -- email, IP or fingerprint.
  anonymous_id   text,
  opportunity_id text,   -- canonical 'opp-<source>-<source_id>' string, not a FK (same as swipes/applications)
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  created_at     timestamptz NOT NULL DEFAULT now()
  -- No free-text column exists on purpose: resume/application content must be
  -- structurally unable to reach this table.
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_created_at   ON funnel_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_events_anonymous_id ON funnel_events(anonymous_id) WHERE anonymous_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_funnel_events_profile_id   ON funnel_events(profile_id)   WHERE profile_id   IS NOT NULL;

ALTER TABLE funnel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_events FORCE ROW LEVEL SECURITY;
-- Zero client policies: deny-by-default for anon/authenticated. The service-role
-- policy mirrors 012/013/026/029; recordFunnelEvent() uses the admin client.
DROP POLICY IF EXISTS funnel_events_service_role_all ON funnel_events;
CREATE POLICY funnel_events_service_role_all ON funnel_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON funnel_events FROM anon, authenticated;
GRANT ALL ON funnel_events TO service_role;

-- ==============================================================================
-- DOWN (documented, not executed):
--   DROP TABLE IF EXISTS funnel_events;
--   -- Drops the funnel history with it, and every recordFunnelEvent() write would
--   -- then fail until it is recreated (POST /api/funnel/event returns 500
--   -- "Could not record event").
-- ==============================================================================
