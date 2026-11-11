-- Public, bounded search RPC.
--
-- The direct PostgREST search query runs under RLS. Its non-leakproof ILIKE
-- predicates are evaluated above the RLS security barrier, preventing the
-- planner from using the existing pg_trgm GIN indexes. The resulting exact
-- count repeatedly scans the active catalog and times out for common terms.
--
-- This SECURITY DEFINER function is deliberately narrow: it returns only
-- active, translation-safe public rows, applies the same substring/whole-skill
-- matching semantics, and returns at most 24 rows plus the exact total.
-- Its owner must be the migration owner (postgres/table owner), which bypasses
-- RLS; row_security=off makes an unexpected non-bypass owner fail closed.

CREATE OR REPLACE FUNCTION public.get_remote_job_search_page(
  p_terms text[] DEFAULT ARRAY[]::text[],
  p_offset integer DEFAULT 0,
  p_page_size integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
SET work_mem TO '16MB'
SET row_security TO 'off'
AS $function$
DECLARE
  v_terms text[] := ARRAY[]::text[];
  v_term text;
  v_predicate text := 'TRUE';
  v_i integer;
  v_offset integer := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 2400);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 24), 1), 24);
  v_total bigint := 0;
  v_jobs jsonb := '[]'::jsonb;
BEGIN
  -- Revalidate RPC input independently of the TypeScript caller. Only the
  -- directory's five bounded, lowercase search terms are accepted.
  IF p_terms IS NOT NULL THEN
    FOREACH v_term IN ARRAY p_terms LOOP
      v_term := LEFT(
        REGEXP_REPLACE(LOWER(COALESCE(v_term, '')), '[^a-z0-9+#./-]', '', 'g'),
        40
      );
      IF v_term <> '' THEN
        v_terms := ARRAY_APPEND(v_terms, v_term);
      END IF;
      EXIT WHEN CARDINALITY(v_terms) >= 5;
    END LOOP;
  END IF;

  -- Build one indexable OR expression per term; terms are ANDed. Each
  -- parameter is passed as data (never interpolated into SQL text), allowing
  -- the planner to combine the existing title/company/description/remote-type
  -- trigram indexes and required_skills GIN index with BitmapOr.
  FOR v_i IN 1..COALESCE(CARDINALITY(v_terms), 0) LOOP
    v_predicate := v_predicate || FORMAT(
      ' AND (
        o.title ILIKE (''%%'' || $1[%s] || ''%%'')
        OR o.company ILIKE (''%%'' || $1[%s] || ''%%'')
        OR o.description ILIKE (''%%'' || $1[%s] || ''%%'')
        OR o.remote_type ILIKE (''%%'' || $1[%s] || ''%%'')
        OR o.required_skills @> ARRAY[$1[%s], INITCAP($1[%s]), UPPER($1[%s])]::text[]
      )',
      v_i, v_i, v_i, v_i, v_i, v_i, v_i
    );
  END LOOP;

  EXECUTE FORMAT(
    'SELECT COUNT(*)::bigint
       FROM public.opportunities AS o
      WHERE o.status = ''active''
        AND o.superseded_by_opportunity_id IS NULL
        AND (o.source_language IS NULL OR o.source_language = ''en'' OR o.translation_status = ''ok'')
        AND (o.translation_status IS NULL OR o.translation_status <> ''error'')
        AND %s',
    v_predicate
  )
  INTO v_total
  USING v_terms;

  EXECUTE FORMAT(
    'SELECT COALESCE(
       JSONB_AGG(
         TO_JSONB(page_row)
         ORDER BY page_row.posted_at DESC NULLS LAST,
                  page_row.source_id ASC,
                  page_row.source ASC
       ),
       ''[]''::jsonb
     )
       FROM (
         SELECT
           o.type, o.title, o.company, o.company_logo, o.description,
           o.source, o.source_id, o.source_url, o.official_url,
           o.canonical_url_hash, o.content_hash, o.employment_type,
           o.remote_type, o.eligible_countries, o.excluded_countries,
           o.timezone_requirements, o.salary_min, o.salary_max,
           o.salary_currency, o.salary_period, o.required_skills,
           o.preferred_skills, o.experience_requirement, o.quality_score,
           o.source_quality, o.description_completeness, o.salary_quality,
           o.remote_policy_confidence, o.explicit_remote_scope, o.status,
           o.posted_at, o.is_permanently_removed, o.link_checked_at,
           o.superseded_by_opportunity_id
         FROM public.opportunities AS o
         WHERE o.status = ''active''
           AND o.superseded_by_opportunity_id IS NULL
           AND (o.source_language IS NULL OR o.source_language = ''en'' OR o.translation_status = ''ok'')
           AND (o.translation_status IS NULL OR o.translation_status <> ''error'')
           AND %s
         ORDER BY o.posted_at DESC NULLS LAST, o.source_id ASC, o.source ASC
         LIMIT $2 OFFSET $3
       ) AS page_row',
    v_predicate
  )
  INTO v_jobs
  USING v_terms, v_page_size, v_offset;

  RETURN JSONB_BUILD_OBJECT(
    'total', v_total,
    'jobs', COALESCE(v_jobs, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_remote_job_search_page(text[], integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_remote_job_search_page(text[], integer, integer)
  TO anon, authenticated, service_role;
