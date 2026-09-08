-- ==============================================================================
-- RemoteMatch — 013: demand-gap snapshot table (Additional Supply Discovery, C2)
--
-- Per docs/c2-implementation-plan.md (approved with amendments). C2 is
-- instrumentation + a dataset-adequacy assessment ONLY — nothing reads this
-- table, nothing user-facing, no discovery trigger, no matching change.
--
-- One table: a time series of whole measurement snapshots. Raw denominators and
-- computed fields live together so a run can be reproduced / re-interpreted
-- later without re-instrumentation (spec §9.2).
--
-- THE C2 GAP-SCORE INVARIANT: `gap_score` is emitted ONLY when the dataset is
-- structurally measurable AND the numeric D3 evidence bar has been derived and
-- approved (a separate gate — spec §5/§17). In C2 the D3 bar is ALWAYS
-- deferred, so every ranked_gaps entry's `gap_score` is null with
-- `gap_score_status = 'withheld_d3_evidence_bar_deferred'`, and the list is
-- ordered by observations (NOT gap) for diagnostics only. The raw
-- demand/supply numbers and the provisional target/shortfall are still
-- persisted. `dataset_adequate` here == structural measurability alone; it does
-- NOT authorize a ranking.
--
-- Additive and downstream-safe: no existing table altered. Service-role only,
-- mirroring the C1 registry RLS pattern exactly.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS demand_gap_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at                 timestamptz NOT NULL DEFAULT now(),
  window_start                timestamptz NOT NULL,
  window_end                  timestamptz NOT NULL,

  -- which of the 4 spec signals actually had server-side data this run
  -- (currently only 'revealed_demand' and 'application_progression' can appear;
  --  'active_user_requirement' and 'search_filter_activity' have no source yet)
  signals_available           text[] NOT NULL,

  -- ties every number in this row to a documented docs/c2-addendum.md revision
  constants_version           text NOT NULL,
  lexicon_version             text NOT NULL,

  -- raw denominators — so the adequacy criteria and the constants can be
  -- re-derived from accumulated history later, with no code change
  verified_active_users       int NOT NULL,
  distinct_demand_patterns    int NOT NULL,
  total_demand_observations   int NOT NULL,
  revealed_demand_observations int NOT NULL,
  application_progression_observations int NOT NULL,
  progression_unattributable  int NOT NULL,

  -- structural measurability for this run (do the mechanics have enough data).
  -- NOT a gap-ranking authorization — see adequacy_detail.gapRankingAuthorized
  -- (always false in C2) and the invariant note above.
  dataset_adequate            boolean NOT NULL,
  adequacy_detail             jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- the measurement. Each entry:
  --   { pattern, pattern_key, demand_weight, active_supply, effective_supply,
  --     target_supply, shortfall, gap_score (null unless gap_ranking authorized),
  --     gap_score_status, observations, distinct_users }
  -- In C2 gap_score is always null (D3 bar deferred) and the list is ordered by
  -- observations, not gap.
  ranked_gaps                 jsonb NOT NULL DEFAULT '[]'::jsonb,

  notes                       text
);

CREATE INDEX IF NOT EXISTS idx_demand_gap_snapshots_computed_at
  ON demand_gap_snapshots(computed_at DESC);

COMMENT ON TABLE demand_gap_snapshots IS
  'C2 demand instrumentation. One row per measurement run. Nothing consumes '
  'this — it is the deterministic gap table the spec''s demand->discovery '
  'interface will read LATER (C3+), and the substrate for the dataset-adequacy '
  'assessment. gap_score is emitted ONLY when the numeric D3 evidence bar is '
  'derived+approved (a separate gate); in C2 it is deferred, so gap_score is '
  'always null, ranked_gaps carries raw numbers for diagnostics only, and the '
  'list is not a ranking.';

-- RLS — service-role only. No public / authenticated access. Same pattern as
-- migration 012's registry tables and 002's opportunities_manage_service_role.
ALTER TABLE demand_gap_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_gap_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY "demand_gap_snapshots_service_role_all" ON demand_gap_snapshots FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON demand_gap_snapshots FROM anon, authenticated;
GRANT ALL ON demand_gap_snapshots TO service_role;

-- ==============================================================================
-- DOWN:  DROP TABLE IF EXISTS demand_gap_snapshots;
-- No data loss elsewhere — nothing references this table.
-- ==============================================================================
