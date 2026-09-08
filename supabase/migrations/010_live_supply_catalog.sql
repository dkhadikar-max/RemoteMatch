-- ==============================================================================
-- RemoteMatch — 010: reactivate `opportunities` as the live-supply catalog
--
-- Per the signed Live Supply Activation spec (v2). Reactivates the existing,
-- previously-dead `opportunities` table (schema present since 001, RLS
-- present since 002, never written to) rather than creating a second
-- canonical job representation. RLS is UNCHANGED — the existing
-- "opportunities_select_active" policy (USING (status = 'active')) already
-- gives the exact guarantee this spec needs: 'unknown'/'expired'/'draft'
-- rows can never be publicly selected, for free, as long as every read path
-- actually goes through this table (enforced by application code + the
-- explicit RLS test gate this spec requires, not by this migration).
--
-- Lifecycle this schema supports (see pipeline/catalog-sync code for the
-- actual state machine):
--   DISCOVER -> unknown -> (first link check) -> active -> expired
--   Provider failure: no state or counter change to that provider's rows.
--   Feed absence and link reachability are independent observations that
--   can each independently expire a row.
-- ==============================================================================

-- 1. STATUS: add 'unknown' as a genuine, distinct lifecycle state. A job
--    must pass this state before ever becoming publicly visible — the
--    existing RLS policy's `status = 'active'` filter means 'unknown' rows
--    are already correctly excluded from public reads without any policy
--    change.
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_status_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_status_check
  CHECK (status IN ('active', 'expired', 'draft', 'unknown'));
ALTER TABLE opportunities ALTER COLUMN status SET DEFAULT 'unknown';

-- 2. AVAILABILITY TRACKING — new columns, additive only.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS link_reachable BOOLEAN,
  ADD COLUMN IF NOT EXISTS link_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consecutive_absences INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_in_feed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_permanently_removed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS explicit_remote_scope TEXT,
  -- These four are already computed by normalizeOpportunity() but were
  -- never persisted (the table was dead schema until this migration) —
  -- added so a DB row can be mapped back to a complete CanonicalOpportunity
  -- without losing information normalizeOpportunity() already derived from
  -- the raw provider payload (e.g. P1's salaryDisclosed reads salaryQuality
  -- and must see 'estimated' vs 'unspecified', which a bare salary_min
  -- column alone cannot distinguish).
  ADD COLUMN IF NOT EXISTS source_quality INT,
  ADD COLUMN IF NOT EXISTS description_completeness TEXT,
  ADD COLUMN IF NOT EXISTS salary_quality TEXT,
  ADD COLUMN IF NOT EXISTS remote_policy_confidence TEXT;

-- 3. DEPRECATE last_verified_at. Column is kept for schema compatibility —
--    not dropped — but is no longer an independent source of truth for
--    anything. `link_checked_at` is the only authoritative link-
--    verification timestamp from this migration forward. Do not write
--    meaningful freshness semantics into last_verified_at in new code.
COMMENT ON COLUMN opportunities.last_verified_at IS
  'DEPRECATED as of migration 010. Previously stamped on every normalization '
  'call, which meant "last normalized," not "last verified" — never a real '
  'freshness signal. Superseded by link_checked_at (authoritative link-'
  'verification timestamp) and last_seen_in_feed_at (authoritative feed-'
  'presence timestamp). Column retained only for compatibility; do not read '
  'or write it as freshness evidence in new code.';

COMMENT ON COLUMN opportunities.status IS
  'active | expired | draft | unknown. RLS (opportunities_select_active) '
  'only permits public SELECT when status = ''active'' — unknown/expired/'
  'draft rows are structurally unreachable by anon/authenticated clients. '
  'unknown is assigned to every newly discovered job and can only become '
  'active via a successful first link verification (see catalog-sync). '
  'expired is reachable via two independent paths: link_reachable = false, '
  'or consecutive_absences >= 3 — neither masquerades as the other.';

COMMENT ON COLUMN opportunities.consecutive_absences IS
  'Increments only on a SUCCESSFUL provider discovery cycle that omits this '
  'job; resets to 0 the moment the job reappears in a successful cycle. A '
  'provider run that failed outright (timeout/5xx/malformed/rate-limit/auth '
  'failure) must never increment or reset this — see the Live Supply '
  'Activation spec''s provider-outage handling.';
