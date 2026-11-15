-- Fix deep sitemap pagination by separating the first-page and continuation plans.
-- The optional-cursor OR caused generic plans to apply the cursor as a filter
-- instead of an index condition. Dynamic EXECUTE replans the continuation with
-- the supplied cursor. The public RPC contract and RLS behavior are preserved.
-- Default and maximum batch size are reduced to 1,000; callers already request
-- explicit batches <= 1,000 and the application retries down to 25 on 57014.

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
        ORDER BY o.source ASC, o.source_id ASC
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
          AND (o.source, o.source_id) > ($1, $2)
        ORDER BY o.source ASC, o.source_id ASC
        LIMIT $3
      ) AS page
    $sql$
    INTO v_result
    USING p_after_source, COALESCE(p_after_source_id, ''), v_page_size;
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$function$;
