-- Run the search count and page from one materialized candidate set.
-- The previous RPC scanned the same broad trigram match twice (COUNT + page);
-- on the shared 85k-row catalog, multi-term searches crossed PostgREST's
-- statement timeout. Materialize only the matching row keys once, then count
-- and page that bounded key set before fetching the 24 full result rows.
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
SET row_security TO 'off'
AS $function$
DECLARE
  v_terms text[] := ARRAY[]::text[];
  v_term text;
  v_predicate text := 'TRUE';
  v_i integer;
  v_offset integer := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 2400);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 24), 1), 24);
  v_result jsonb := JSONB_BUILD_OBJECT('total', 0, 'jobs', '[]'::jsonb);
BEGIN
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

  FOR v_i IN 1..COALESCE(CARDINALITY(v_terms), 0) LOOP
    IF LENGTH(REGEXP_REPLACE(v_terms[v_i], '[^a-z0-9]', '', 'g')) < 3 THEN
      IF LENGTH(REGEXP_REPLACE(v_terms[v_i], '[^a-z0-9]', '', 'g')) = 2
         AND v_terms[v_i] ~ '^[a-z0-9]+$' THEN
        v_predicate := v_predicate || FORMAT(
          ' AND (
            to_tsvector(''simple''::regconfig, COALESCE(o.title, '''') || '' '' || COALESCE(o.company, '''') || '' '' || COALESCE(o.remote_type, ''''))
              @@ to_tsquery(''simple'', %L)
            OR lower(o.title) LIKE %L
            OR lower(o.company) LIKE %L
            OR lower(o.remote_type) LIKE %L
            OR (o.required_skills @> ARRAY[%L]::text[] OR o.required_skills @> ARRAY[%L]::text[] OR o.required_skills @> ARRAY[%L]::text[])
            OR EXISTS (
              SELECT 1 FROM public.opportunity_catalog_index AS skill_match
              WHERE skill_match.opportunity_id = o.id
                AND skill_match.required_skills_lower @> ARRAY[%L]::text[]
            )
          )',
          v_terms[v_i] || ':*',
          v_terms[v_i] || '%',
          v_terms[v_i] || '%',
          v_terms[v_i] || '%',
          v_terms[v_i],
          INITCAP(v_terms[v_i]),
          UPPER(v_terms[v_i]),
          v_terms[v_i]
        );
      ELSE
        v_predicate := v_predicate || FORMAT(
          ' AND (
            lower(o.title) LIKE %L
            OR lower(o.company) LIKE %L
            OR lower(o.remote_type) LIKE %L
            OR (o.required_skills @> ARRAY[%L]::text[] OR o.required_skills @> ARRAY[%L]::text[] OR o.required_skills @> ARRAY[%L]::text[])
            OR EXISTS (
              SELECT 1 FROM public.opportunity_catalog_index AS skill_match
              WHERE skill_match.opportunity_id = o.id
                AND skill_match.required_skills_lower @> ARRAY[%L]::text[]
            )
          )',
          v_terms[v_i] || '%',
          v_terms[v_i] || '%',
          v_terms[v_i] || '%',
          v_terms[v_i],
          INITCAP(v_terms[v_i]),
          UPPER(v_terms[v_i]),
          v_terms[v_i]
        );
      END IF;
    ELSE
      v_predicate := v_predicate || FORMAT(
        ' AND (
          (COALESCE(o.title, '''') || '' '' || COALESCE(o.company, '''') || '' '' || COALESCE(o.description, '''') || '' '' || COALESCE(o.remote_type, '''')) ILIKE %L
          OR o.required_skills && ARRAY[%L, %L, %L]::text[]
        )',
        '%' || v_terms[v_i] || '%',
        v_terms[v_i],
        INITCAP(v_terms[v_i]),
        UPPER(v_terms[v_i])
      );
    END IF;
  END LOOP;

  IF COALESCE(CARDINALITY(v_terms), 0) = 0 THEN
    RETURN v_result;
  END IF;

  EXECUTE FORMAT(
    'WITH matched AS MATERIALIZED (
       SELECT o.id, o.posted_at, o.source_id, o.source
       FROM public.opportunities AS o
       WHERE o.status = ''active''
         AND o.superseded_by_opportunity_id IS NULL
         AND (o.source_language IS NULL OR o.source_language = ''en'' OR o.translation_status = ''ok'')
         AND (o.translation_status IS NULL OR o.translation_status <> ''error'')
         AND %s
     ),
     page AS (
       SELECT id, posted_at, source_id, source
       FROM matched
       ORDER BY posted_at DESC NULLS LAST, source_id ASC, source ASC
       LIMIT $1 OFFSET $2
     )
     SELECT JSONB_BUILD_OBJECT(
       ''total'', (SELECT COUNT(*)::bigint FROM matched),
       ''jobs'', COALESCE((
         SELECT JSONB_AGG(
           JSONB_BUILD_OBJECT(
             ''type'', o.type, ''title'', o.title, ''company'', o.company,
             ''company_logo'', o.company_logo, ''description'', o.description,
             ''source'', o.source, ''source_id'', o.source_id,
             ''source_url'', o.source_url, ''official_url'', o.official_url,
             ''canonical_url_hash'', o.canonical_url_hash, ''content_hash'', o.content_hash,
             ''employment_type'', o.employment_type, ''remote_type'', o.remote_type,
             ''eligible_countries'', o.eligible_countries, ''excluded_countries'', o.excluded_countries,
             ''timezone_requirements'', o.timezone_requirements,
             ''salary_min'', o.salary_min, ''salary_max'', o.salary_max,
             ''salary_currency'', o.salary_currency, ''salary_period'', o.salary_period,
             ''required_skills'', o.required_skills, ''preferred_skills'', o.preferred_skills,
             ''experience_requirement'', o.experience_requirement, ''quality_score'', o.quality_score,
             ''source_quality'', o.source_quality, ''description_completeness'', o.description_completeness,
             ''salary_quality'', o.salary_quality, ''remote_policy_confidence'', o.remote_policy_confidence,
             ''explicit_remote_scope'', o.explicit_remote_scope, ''status'', o.status,
             ''posted_at'', o.posted_at, ''is_permanently_removed'', o.is_permanently_removed,
             ''link_checked_at'', o.link_checked_at,
             ''superseded_by_opportunity_id'', o.superseded_by_opportunity_id
           )
           ORDER BY p.posted_at DESC NULLS LAST, p.source_id ASC, p.source ASC
         )
         FROM page AS p
         JOIN public.opportunities AS o ON o.id = p.id
       ), ''[]''::jsonb)
     )',
    v_predicate
  )
  INTO v_result
  USING v_page_size, v_offset;

  RETURN COALESCE(v_result, JSONB_BUILD_OBJECT('total', 0, 'jobs', '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.get_remote_job_search_page(text[], integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_remote_job_search_page(text[], integer, integer)
  TO anon, authenticated, service_role;
