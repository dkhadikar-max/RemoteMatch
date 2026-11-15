CREATE INDEX IF NOT EXISTS opportunity_catalog_index_software_engineering_hub_order
ON public.opportunity_catalog_index (posted_at DESC NULLS LAST, source_id ASC, source ASC)
WHERE lower(title) LIKE '%software engineering%'
   OR lower(title) LIKE '%engineer%'
   OR lower(title) LIKE '%developer%'
   OR required_skills_lower && ARRAY['react', 'typescript', 'node.js', 'go', 'python', 'kubernetes', 'distributed systems']::text[];
