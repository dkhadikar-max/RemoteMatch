-- Separate exact category totals from bounded page retrieval.
--
-- The prior category RPC materialized every matching catalogue row so the
-- exact count, ordered page, and source-id resolution could all reuse it.
-- For broad categories such as united-states this materialized tens of
-- thousands of rows and then sorted the full set before returning 24 rows.
-- The exact count is a narrow one-pass count; page retrieval now starts from
-- the existing (posted_at DESC, source_id, source) order index and stops at
-- the requested page. Source-id resolution is restricted to those page IDs.
--
-- Preserve category semantics, exact totals, page order, source-id
-- de-duplication, SECURITY INVOKER, RLS, grants, search_path and PR #64's
-- function-local 16MB work_mem setting.

-- The broad US predicate matched 45,089 of 81,865 projection rows. A plain
-- count chose a sequential scan and took 2.38s under anon; the remote_type-only
-- index count took 261ms. This partial covering key lets the exact OR predicate
-- count only its matching entries without scanning the full projection.
CREATE INDEX IF NOT EXISTS opportunity_catalog_index_united_states_count
  ON public.opportunity_catalog_index (opportunity_id)
  WHERE remote_type = 'US'
     OR eligible_countries && ARRAY['US', 'USA']::text[];

ANALYZE public.opportunity_catalog_index;

CREATE OR REPLACE FUNCTION public.get_remote_job_hub_page(
  p_category_slug text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
SET work_mem TO '16MB'
AS $function$
DECLARE
  v_predicate text;
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 24), 1), 24);
  v_offset integer := (LEAST(GREATEST(COALESCE(p_page, 1), 1), 5000) - 1)
                      * LEAST(GREATEST(COALESCE(p_page_size, 24), 1), 24);
  v_total bigint;
  v_jobs jsonb;
BEGIN
  IF p_category_slug IS NULL THEN
    SELECT count(*)::bigint INTO v_total
    FROM public.opportunity_catalog_index;

    WITH page_ids AS MATERIALIZED (
      SELECT source_id, source, posted_at
      FROM public.opportunity_catalog_index
      ORDER BY posted_at DESC NULLS LAST, source_id ASC, source ASC
      LIMIT v_page_size OFFSET v_offset
    ),
    unique_page_ids AS (
      SELECT DISTINCT ON (source_id) source_id, source, posted_at
      FROM page_ids
      ORDER BY source_id ASC, posted_at DESC NULLS LAST, source ASC
    ),
    requested_ids AS (
      SELECT DISTINCT source_id FROM unique_page_ids
    ),
    first_match AS MATERIALIZED (
      SELECT DISTINCT ON (i.source_id) i.source_id, i.source
      FROM public.opportunity_catalog_index AS i
      JOIN requested_ids AS requested USING (source_id)
      ORDER BY i.source_id ASC, i.source ASC
    ),
    resolved AS (
      SELECT
        unique_page_ids.posted_at AS _index_posted_at,
        unique_page_ids.source_id AS _index_source_id,
        unique_page_ids.source AS _index_source,
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
      FROM unique_page_ids
      JOIN first_match USING (source_id)
      JOIN public.opportunities AS o
        ON o.source = first_match.source AND o.source_id = first_match.source_id
      WHERE o.status = 'active'
        AND (o.source_language IS NULL OR o.source_language = 'en' OR o.translation_status = 'ok')
        AND (o.translation_status IS NULL OR o.translation_status <> 'error')
    )
    SELECT COALESCE(
      jsonb_agg(
        to_jsonb(resolved) - '_index_posted_at' - '_index_source_id' - '_index_source'
        ORDER BY resolved._index_posted_at DESC NULLS LAST,
                 resolved._index_source_id ASC, resolved._index_source ASC
      ),
      '[]'::jsonb
    )
    INTO v_jobs
    FROM resolved;

    RETURN jsonb_build_object('total', v_total, 'jobs', v_jobs);
  END IF;

  v_predicate := CASE
    WHEN p_category_slug = 'worldwide' THEN 'i.remote_type = ''Worldwide'''
    WHEN p_category_slug = 'united-states' THEN '(i.remote_type = ''US'' OR i.eligible_countries && ARRAY[''US'', ''USA'']::text[])'
    WHEN p_category_slug = 'europe' THEN '(i.remote_type = ''EU/EEA'' OR i.eligible_countries && ARRAY[''EU'', ''UK'', ''EEA'']::text[])'
    WHEN p_category_slug = 'senior' THEN '(i.experience_requirement = ''7-10'' OR lower(i.title) LIKE ''%senior%'' OR lower(i.title) LIKE ''%lead%'' OR lower(i.title) LIKE ''%staff%'')'
    WHEN p_category_slug = 'entry-level' THEN 'i.experience_requirement IN (''0-1'', ''2-3'')'
    WHEN p_category_slug = 'software-engineering' THEN '(lower(i.title) LIKE ''%software engineering%'' OR lower(i.title) LIKE ''%engineer%'' OR lower(i.title) LIKE ''%developer%'' OR i.required_skills_lower && ARRAY[''react'', ''typescript'', ''node.js'', ''go'', ''python'', ''kubernetes'', ''distributed systems'']::text[])'
    WHEN p_category_slug = 'product-management' THEN '(lower(i.title) LIKE ''%product management%'' OR i.required_skills_lower && ARRAY[''product management'', ''roadmapping'', ''user research'', ''saas'', ''developer tools'']::text[])'
    WHEN p_category_slug = 'design' THEN '(lower(i.title) LIKE ''%design%'' OR i.required_skills_lower && ARRAY[''figma'', ''product design'', ''design systems'', ''user research'', ''ui/ux'']::text[])'
    WHEN p_category_slug = 'data' THEN '(lower(i.title) LIKE ''%data%'' OR i.required_skills_lower && ARRAY[''python'', ''sql'', ''dbt'', ''snowflake'', ''etl'', ''postgresql'']::text[])'
    WHEN p_category_slug = 'marketing' THEN '(lower(i.title) LIKE ''%marketing%'' OR i.required_skills_lower && ARRAY[''product marketing'', ''copywriting'', ''content marketing'', ''seo'', ''positioning'']::text[])'
    ELSE 'false'
  END;

  -- This narrow count is independent of page retrieval. It can use the
  -- category predicate's own indexes or a sequential scan without forcing the
  -- page query to materialize and sort every matching row.
  EXECUTE format(
    'SELECT count(*)::bigint FROM public.opportunity_catalog_index AS i WHERE %s',
    v_predicate
  )
  INTO v_total;

  -- The ordered projection index satisfies this LIMIT/OFFSET query. Only the
  -- selected page IDs are materialized; source resolution is then constrained
  -- to those IDs and the same category predicate.
  EXECUTE format($query$
    WITH page_ids AS MATERIALIZED (
      SELECT i.source_id, i.source, i.posted_at
      FROM public.opportunity_catalog_index AS i
      WHERE %s
      ORDER BY i.posted_at DESC NULLS LAST, i.source_id ASC, i.source ASC
      LIMIT $1 OFFSET $2
    ),
    unique_page_ids AS (
      SELECT DISTINCT ON (source_id) source_id, source, posted_at
      FROM page_ids
      ORDER BY source_id ASC, posted_at DESC NULLS LAST, source ASC
    ),
    requested_ids AS (
      SELECT DISTINCT source_id FROM unique_page_ids
    ),
    first_match AS MATERIALIZED (
      SELECT requested.source_id, first.source
      FROM requested_ids AS requested
      CROSS JOIN LATERAL (
        SELECT i.source
        FROM public.opportunity_catalog_index AS i
        WHERE i.source_id = requested.source_id
          AND %s
        ORDER BY i.source ASC
        LIMIT 1
      ) AS first
    ),
    resolved AS (
      SELECT
        unique_page_ids.posted_at AS _index_posted_at,
        unique_page_ids.source_id AS _index_source_id,
        unique_page_ids.source AS _index_source,
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
      FROM unique_page_ids
      JOIN first_match USING (source_id)
      JOIN public.opportunities AS o
        ON o.source = first_match.source AND o.source_id = first_match.source_id
      WHERE o.status = 'active'
        AND (o.source_language IS NULL OR o.source_language = 'en' OR o.translation_status = 'ok')
        AND (o.translation_status IS NULL OR o.translation_status <> 'error')
    )
    SELECT COALESCE(
      jsonb_agg(
        to_jsonb(resolved) - '_index_posted_at' - '_index_source_id' - '_index_source'
        ORDER BY resolved._index_posted_at DESC NULLS LAST,
                 resolved._index_source_id ASC, resolved._index_source ASC
      ),
      '[]'::jsonb
    )
    FROM resolved
  $query$, v_predicate, v_predicate)
  INTO v_jobs
  USING v_page_size, v_offset;

  RETURN jsonb_build_object('total', v_total, 'jobs', COALESCE(v_jobs, '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.get_remote_job_hub_page(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_remote_job_hub_page(text, integer, integer)
  TO anon, authenticated, service_role;
