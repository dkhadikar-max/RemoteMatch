-- The Europe category's OR predicate used the generic posted_at index and
-- filtered a large portion of the catalog before finding the first page. A
-- category-specific ordered partial index lets both exact counts and page
-- retrieval operate only on Europe-eligible rows in the public sort order.

CREATE INDEX IF NOT EXISTS opportunity_catalog_index_europe_order
  ON public.opportunity_catalog_index (
    posted_at DESC NULLS LAST,
    source_id ASC,
    source ASC
  )
  WHERE remote_type = 'EU/EEA'
     OR eligible_countries && ARRAY['EU', 'UK', 'EEA']::text[];
