CREATE INDEX IF NOT EXISTS opportunity_catalog_index_marketing_hub_order
ON public.opportunity_catalog_index (posted_at DESC NULLS LAST, source_id ASC, source ASC)
WHERE lower(title) LIKE '%marketing%'
   OR required_skills_lower && ARRAY['product marketing', 'copywriting', 'content marketing', 'seo', 'positioning']::text[];
