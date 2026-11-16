-- 051: Remove repeated catalogue scans from directory RPCs and keyset-page sitemap reads.
-- Both functions remain SECURITY INVOKER and retain the existing public RLS boundary.

CREATE OR REPLACE FUNCTION public.get_remote_job_hub_page(
  p_category_slug text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  -- MATERIALIZED is deliberate: totals, page selection, and source-id
  -- resolution all consume this predicate. NOT MATERIALIZED caused repeated
  -- full scans of the 78k-row projection, pushing deep pages past 3 seconds.
  WITH matched AS MATERIALIZED (
    SELECT i.source_id, i.source, i.posted_at
    FROM public.opportunity_catalog_index AS i
    WHERE CASE
      WHEN p_category_slug IS NULL THEN true
      WHEN p_category_slug = 'worldwide' THEN i.remote_type = 'Worldwide'
      WHEN p_category_slug = 'united-states'
        THEN i.remote_type = 'US' OR i.eligible_countries && ARRAY['US', 'USA']::text[]
      WHEN p_category_slug = 'europe'
        THEN i.remote_type = 'EU/EEA' OR i.eligible_countries && ARRAY['EU', 'UK', 'EEA']::text[]
      WHEN p_category_slug = 'senior'
        THEN i.experience_requirement = '7-10'
          OR position('senior' in lower(i.title)) > 0
          OR position('lead' in lower(i.title)) > 0
          OR position('staff' in lower(i.title)) > 0
      WHEN p_category_slug = 'entry-level'
        THEN i.experience_requirement IN ('0-1', '2-3')
      WHEN p_category_slug = 'software-engineering'
        THEN position('software engineering' in lower(i.title)) > 0
          OR position('engineer' in lower(i.title)) > 0
          OR position('developer' in lower(i.title)) > 0
          OR i.required_skills_lower && ARRAY[
            'react', 'typescript', 'node.js', 'go', 'python', 'kubernetes', 'distributed systems'
          ]::text[]
      WHEN p_category_slug = 'product-management'
        THEN position('product management' in lower(i.title)) > 0
          OR i.required_skills_lower && ARRAY[
            'product management', 'roadmapping', 'user research', 'saas', 'developer tools'
          ]::text[]
      WHEN p_category_slug = 'design'
        THEN position('design' in lower(i.title)) > 0
          OR i.required_skills_lower && ARRAY[
            'figma', 'product design', 'design systems', 'user research', 'ui/ux'
          ]::text[]
      WHEN p_category_slug = 'data'
        THEN position('data' in lower(i.title)) > 0
          OR i.required_skills_lower && ARRAY[
            'python', 'sql', 'dbt', 'snowflake', 'etl', 'postgresql'
          ]::text[]
      WHEN p_category_slug = 'marketing'
        THEN position('marketing' in lower(i.title)) > 0
          OR i.required_skills_lower && ARRAY[
            'product marketing', 'copywriting', 'content marketing', 'seo', 'positioning'
          ]::text[]
      ELSE false
    END
  ),
  totals AS (
    SELECT count(*)::bigint AS total FROM matched
  ),
  page_ids AS (
    SELECT source_id, source, posted_at
    FROM matched
    ORDER BY posted_at DESC NULLS LAST, source_id ASC, source ASC
    LIMIT LEAST(GREATEST(COALESCE(p_page_size, 24), 1), 24)
    OFFSET (
      (LEAST(GREATEST(COALESCE(p_page, 1), 1), 5000) - 1)
      * LEAST(GREATEST(COALESCE(p_page_size, 24), 1), 24)
    )
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
    FROM matched AS i
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
      ON o.source = first_match.source
      AND o.source_id = first_match.source_id
    WHERE o.status = 'active'
      AND (o.source_language IS NULL OR o.source_language = 'en' OR o.translation_status = 'ok')
      AND (o.translation_status IS NULL OR o.translation_status <> 'error')
  )
  SELECT jsonb_build_object(
    'total', totals.total,
    'jobs', COALESCE(
      (
        SELECT jsonb_agg(
          to_jsonb(resolved) - '_index_posted_at' - '_index_source_id' - '_index_source'
          ORDER BY resolved._index_posted_at DESC NULLS LAST,
                   resolved._index_source_id ASC, resolved._index_source ASC
        )
        FROM resolved
      ),
      '[]'::jsonb
    )
  )
  FROM totals;
$$;

REVOKE ALL ON FUNCTION public.get_remote_job_hub_page(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_remote_job_hub_page(text, integer, integer)
  TO anon, authenticated, service_role;

-- Cursor-based sitemap paging avoids the O(n^2) repeated scans caused by
-- OFFSET over the 78k+ active catalogue. The existing unique index on
-- (source, source_id) supports the tuple cursor and deterministic ordering.
CREATE OR REPLACE FUNCTION public.get_remote_job_sitemap_page(
  p_after_source text DEFAULT NULL,
  p_after_source_id text DEFAULT NULL,
  p_page_size integer DEFAULT 1000
)
RETURNS TABLE (
  source text,
  source_id text,
  title text,
  posted_at timestamptz,
  required_skills text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT
    o.source,
    o.source_id,
    o.title,
    o.posted_at,
    COALESCE(o.required_skills, ARRAY[]::text[])
  FROM public.opportunities AS o
  WHERE o.status = 'active'
    AND (o.source_language IS NULL OR o.source_language = 'en' OR o.translation_status = 'ok')
    AND (o.translation_status IS NULL OR o.translation_status <> 'error')
    AND (
      p_after_source IS NULL
      OR (o.source, o.source_id) > (p_after_source, COALESCE(p_after_source_id, ''))
    )
  ORDER BY o.source ASC, o.source_id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_page_size, 1000), 1), 1000);
$$;

REVOKE ALL ON FUNCTION public.get_remote_job_sitemap_page(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_remote_job_sitemap_page(text, text, integer)
  TO anon, authenticated, service_role;
