-- Initial ordered public-search index. Superseded by the covering variant below.
CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_order
ON public.opportunities (posted_at DESC NULLS LAST, source_id ASC)
WHERE status = 'active'
  AND superseded_by_opportunity_id IS NULL
  AND ((source_language IS NULL) OR (source_language = 'en') OR (translation_status = 'ok'))
  AND ((translation_status IS NULL) OR (translation_status <> 'error'));
