-- Support country-filtered public job discovery without scanning the full active catalogue.
-- Keep both indexes aligned with the endpoint's public visibility predicate.
CREATE INDEX IF NOT EXISTS idx_opportunities_eligible_countries_visible_gin
ON public.opportunities USING gin (eligible_countries)
WHERE status = 'active'
  AND superseded_by_opportunity_id IS NULL
  AND ((source_language IS NULL) OR (source_language = 'en') OR (translation_status = 'ok'))
  AND ((translation_status IS NULL) OR (translation_status <> 'error'));

CREATE INDEX IF NOT EXISTS idx_opportunities_remote_type_visible_order
ON public.opportunities (remote_type, posted_at DESC NULLS LAST, source_id ASC)
WHERE status = 'active'
  AND superseded_by_opportunity_id IS NULL
  AND ((source_language IS NULL) OR (source_language = 'en') OR (translation_status = 'ok'))
  AND ((translation_status IS NULL) OR (translation_status <> 'error'));
