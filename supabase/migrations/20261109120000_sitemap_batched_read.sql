-- 052: Make the sitemap's keyset read covering and reduce sequential Data API round trips.
-- The public visibility predicate intentionally matches the existing RLS-backed sitemap read.

CREATE INDEX IF NOT EXISTS idx_opportunities_sitemap_visible_cursor_cover
  ON public.opportunities (source ASC, source_id ASC)
  INCLUDE (title, posted_at, required_skills)
  WHERE status = 'active'
    AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok')
    AND (translation_status IS NULL OR translation_status <> 'error');

-- Return one bounded JSON batch rather than a PostgREST setof result. PostgREST's
-- max_rows cap applies to table-returning RPCs; a JSONB value lets the caller
-- fetch 5,000 compact sitemap records per request without exposing extra rows.
CREATE OR REPLACE FUNCTION public.get_remote_job_sitemap_page_json(
  p_after_source text DEFAULT NULL,
  p_after_source_id text DEFAULT NULL,
  p_page_size integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'source', page.source,
        'source_id', page.source_id,
        'title', page.title,
        'posted_at', page.posted_at,
        'required_skills', page.required_skills
      )
      ORDER BY page.source ASC, page.source_id ASC
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT
      o.source,
      o.source_id,
      o.title,
      o.posted_at,
      COALESCE(o.required_skills, ARRAY[]::text[]) AS required_skills
    FROM public.opportunities AS o
    WHERE o.status = 'active'
      AND (o.source_language IS NULL OR o.source_language = 'en' OR o.translation_status = 'ok')
      AND (o.translation_status IS NULL OR o.translation_status <> 'error')
      AND (
        p_after_source IS NULL
        OR (o.source, o.source_id) > (p_after_source, COALESCE(p_after_source_id, ''))
      )
    ORDER BY o.source ASC, o.source_id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_page_size, 5000), 1), 5000)
  ) AS page;
$$;

REVOKE ALL ON FUNCTION public.get_remote_job_sitemap_page_json(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_remote_job_sitemap_page_json(text, text, integer)
  TO anon, authenticated, service_role;
