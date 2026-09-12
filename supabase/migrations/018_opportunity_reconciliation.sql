-- ==============================================================================
-- RemoteMatch — 018: cross-provider duplicate reconciliation (ticket M-adjacent-1)
--
-- Per the approved M-adjacent-1 lifecycle contract. `deduplicateOpportunities()`
-- (src/lib/ingestion/pipeline.ts) only ever compares jobs within a single
-- sync cycle's freshly-fetched raw batch — it never compares against rows
-- already persisted from an earlier cycle or from a provider that didn't
-- return the job this cycle. Two different providers can therefore end up
-- with independent, permanently-coexisting active rows for what is the same
-- real-world job. This migration adds the single column the approved
-- reconciliation pass (src/lib/ingestion/catalog-sync.ts,
-- reconcileCrossProviderDuplicates()) needs to record that relationship.
--
-- Additive only. Does NOT touch:
--   - `status` / `consecutive_absences` / `link_reachable` — the existing
--     lifecycle state machine (migration 010) is completely untouched by
--     reconciliation; a duplicate keeps accruing its own real absence/link
--     history exactly as if it had never been merged.
--   - RLS (`opportunities_select_active`, USING (status = 'active')) — no
--     policy change. A merged row's `status` never leaves 'active', so it
--     stays resolvable by id through every existing read path (required so
--     ticket M-adj-2(a)'s GET-based Match Detail lookup, and any user's
--     historical swipe/application record, keep resolving a merged
--     opportunity — never redirected, never orphaned).
--   - `deduplicateOpportunities()` / `createNormalizedJobKey()` /
--     `createContentHash()` — the fingerprint hierarchy reconciliation reads
--     is entirely unmodified; there is exactly one duplicate definition in
--     this codebase, not two.
--
-- Relationship semantics (recomputed from current column values on every
-- reconciliation pass, never memorized):
--   survivor:  superseded_by_opportunity_id IS NULL
--   duplicate: superseded_by_opportunity_id = <survivor's id>
-- A row's pointer is retained only while it and its recorded survivor still
-- satisfy at least one of the existing duplicate-hierarchy predicates
-- (canonical_url_hash / normalized company+title / content_hash) as of the
-- current sync cycle. If none match anymore, the next pass clears the
-- pointer — no provenance of which predicate originally matched is stored
-- or needed. In a 3+-way collision, every non-survivor points directly at
-- the single deterministic survivor; a survivor can never itself carry a
-- non-null pointer, so a chain is structurally impossible by construction
-- of the reconciliation algorithm, not enforced by a DB constraint here.
--
-- Discoverability: only the scored feed path (POST /api/opportunities/feed)
-- additionally filters `superseded_by_opportunity_id IS NULL` before
-- scoring. GET /api/opportunities/feed (M-adj-2(a)'s by-id resolution path)
-- is completely unaffected by this migration and this column.
-- ==============================================================================

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS superseded_by_opportunity_id UUID REFERENCES opportunities(id);

CREATE INDEX IF NOT EXISTS idx_opportunities_superseded_by
  ON opportunities(superseded_by_opportunity_id)
  WHERE superseded_by_opportunity_id IS NOT NULL;

COMMENT ON COLUMN opportunities.superseded_by_opportunity_id IS
  'M-adjacent-1 — set only by reconcileCrossProviderDuplicates() '
  '(src/lib/ingestion/catalog-sync.ts). NULL means this row is either a '
  'survivor or has no current cross-provider duplicate. Non-null points '
  'directly at the surviving row for the same real-world job, chosen '
  'deterministically by source_quality desc, then first_seen_at asc, then '
  'id asc. Recomputed from current fingerprint data every reconciliation '
  'pass — not a permanent historical fact; clears itself once no current '
  'duplicate-hierarchy predicate matches, or once the recorded survivor is '
  'no longer status=''active''. Never written by syncOpportunitiesToCatalog() '
  'or revalidateStaleLinks(), and never causes a row''s own status/'
  'consecutive_absences/link_reachable to change. Only the scored feed path '
  '(POST /api/opportunities/feed) filters on this column; GET (used for '
  'by-id resolution, incl. ticket M-adj-2(a) and any historical swipe/'
  'application reference) ignores it entirely — a merged row remains fully '
  'resolvable by id.';

-- ==============================================================================
-- DOWN:
--   DROP INDEX IF EXISTS idx_opportunities_superseded_by;
--   ALTER TABLE opportunities DROP COLUMN IF EXISTS superseded_by_opportunity_id;
--   -- No other column, table, RLS policy, or historical row is affected by
--   -- either direction of this migration.
-- ==============================================================================
