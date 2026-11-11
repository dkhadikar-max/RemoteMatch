-- Read sitemap pages from the transactionally maintained, already-filtered
-- catalog projection rather than re-scanning opportunities and re-evaluating
-- active/translation eligibility on every one of the 80+ keyset batches.
-- The projection trigger keeps this table in sync with the same visibility
-- predicate used by the previous sitemap RPC.
CREATE INDEX IF NOT EXISTS opportunity_catalog_index_sitemap_cursor_cover
  ON public.opportunity_catalog_index (source ASC, source_id ASC)
  INCLUDE (title, posted_at, required_skills);

CREATE OR REPLACE FUNCTION public.get_remote_job_sitemap_page_json(
  p_after_source text DEFAULT NULL,
  p_after_source_id text DEFAULT NULL,
  p_page_size integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 1000), 1), 1000);
BEGIN
  IF p_after_source IS NULL THEN
    EXECUTE $sql$
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
        SELECT i.source, i.source_id, i.title, i.posted_at,
               COALESCE(i.required_skills, ARRAY[]::text[]) AS required_skills
        FROM public.opportunity_catalog_index AS i
        ORDER BY i.source ASC, i.source_id ASC
        LIMIT $1
      ) AS page
    $sql$
    INTO v_result
    USING v_page_size;
  ELSE
    EXECUTE $sql$
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
        SELECT i.source, i.source_id, i.title, i.posted_at,
               COALESCE(i.required_skills, ARRAY[]::text[]) AS required_skills
        FROM public.opportunity_catalog_index AS i
        WHERE (i.source, i.source_id) > ($1, $2)
        ORDER BY i.source ASC, i.source_id ASC
        LIMIT $3
      ) AS page
    $sql$
    INTO v_result
    USING p_after_source, COALESCE(p_after_source_id, ''), v_page_size;
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$function$;
