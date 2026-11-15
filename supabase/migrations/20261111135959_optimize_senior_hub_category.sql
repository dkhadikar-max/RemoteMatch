-- The senior hub combines one experience field with three title patterns.
-- A category-specific partial ordering index lets both its exact count and
-- newest-first page use only matching projection rows instead of scanning the
-- entire 82k-row catalog index on each request.
CREATE INDEX IF NOT EXISTS opportunity_catalog_index_senior_hub_order
  ON public.opportunity_catalog_index (
    posted_at DESC NULLS LAST,
    source_id ASC,
    source ASC
  )
  WHERE experience_requirement = '7-10'
     OR lower(title) LIKE '%senior%'
     OR lower(title) LIKE '%lead%'
     OR lower(title) LIKE '%staff%';
