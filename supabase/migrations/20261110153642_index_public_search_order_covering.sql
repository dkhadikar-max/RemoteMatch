-- Cover fields used to filter the ordered candidate stream.
CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_order_covering
ON public.opportunities (posted_at DESC NULLS LAST, source_id ASC)
INCLUDE (remote_type, eligible_countries)
WHERE status = 'active'
  AND superseded_by_opportunity_id IS NULL
  AND ((source_language IS NULL) OR (source_language = 'en') OR (translation_status = 'ok'))
  AND ((translation_status IS NULL) OR (translation_status <> 'error'));
