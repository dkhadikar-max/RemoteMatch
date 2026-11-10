-- Keep every OR branch in the public directory search indexable.
-- searchActiveOpportunitiesPage() combines title/company/description/remote_type
-- substring matches with skill-tag containment. A single unindexed OR branch
-- can force a sequential scan even when the other branches have GIN indexes.
-- The explicit superseded_by_opportunity_id IS NULL filter in the query matches
-- this partial-index predicate and the other public-search indexes.

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_remote_type_trgm
  ON public.opportunities USING gin (remote_type public.gin_trgm_ops)
  WHERE status = 'active'
    AND superseded_by_opportunity_id IS NULL
    AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok')
    AND (translation_status IS NULL OR translation_status <> 'error');

COMMENT ON INDEX public.idx_opportunities_public_search_remote_type_trgm IS
  'Supports remote_type substring predicates in public directory search.';
