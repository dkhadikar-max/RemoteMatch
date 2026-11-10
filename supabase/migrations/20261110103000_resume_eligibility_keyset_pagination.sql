-- Resume eligibility is a full active-catalog statistic, not the 48-hour feed.
-- Keep the payload narrow (the four fields the matcher reads) and page through
-- the existing unique (source, source_id) index instead of OFFSET, whose deep
-- pages can exceed the anon role's 3-second statement timeout.
CREATE OR REPLACE FUNCTION public.get_resume_eligibility_page(
  p_after_source text,
  p_after_source_id text,
  p_page_size integer
)
RETURNS TABLE(
  source text,
  source_id text,
  title text,
  remote_type text,
  employment_type text,
  required_skills text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT
    o.source,
    o.source_id,
    o.title,
    o.remote_type,
    o.employment_type,
    COALESCE(o.required_skills, ARRAY[]::text[])
  FROM public.opportunities AS o
  WHERE o.status = 'active'
    AND (
      p_after_source IS NULL
      OR (
        p_after_source_id IS NOT NULL
        AND (o.source, o.source_id) > (p_after_source, p_after_source_id)
      )
    )
  ORDER BY o.source ASC, o.source_id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_page_size, 1000), 1), 1000);
$function$;

REVOKE ALL ON FUNCTION public.get_resume_eligibility_page(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_resume_eligibility_page(text, text, integer) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_resume_eligibility_page(text, text, integer) IS
  'Returns narrow active opportunity eligibility fields in composite-keyset pages under caller RLS.';
