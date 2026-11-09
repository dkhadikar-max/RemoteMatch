-- The feed's fresh + translation-safe read has a dedicated plan.
-- The old generic RPC wraps both optional filters in parameterized OR clauses,
-- which prevents PostgreSQL from reliably using the existing partial covering
-- cursor index. It can then fetch many thousands of wide heap rows before
-- returning the first 1,000. This branch first seeks only the composite keys
-- from the partial index, then fetches the wide rows for those keys only.
CREATE OR REPLACE FUNCTION public.get_active_opportunities_keyset_page(
  p_after_source text,
  p_after_source_id text,
  p_page_size integer,
  p_fresh_from timestamp with time zone,
  p_fresh_to timestamp with time zone,
  p_translation_safe boolean
)
RETURNS TABLE(
  type text,
  title text,
  company text,
  company_logo text,
  description text,
  source text,
  source_id text,
  source_url text,
  official_url text,
  canonical_url_hash text,
  content_hash text,
  employment_type text,
  remote_type text,
  eligible_countries text[],
  excluded_countries text[],
  timezone_requirements text[],
  salary_min numeric,
  salary_max numeric,
  salary_currency text,
  salary_period text,
  required_skills text[],
  preferred_skills text[],
  experience_requirement text,
  quality_score integer,
  source_quality integer,
  description_completeness text,
  salary_quality text,
  remote_policy_confidence text,
  explicit_remote_scope text,
  status text,
  posted_at timestamp with time zone,
  is_permanently_removed boolean,
  link_checked_at timestamp with time zone,
  superseded_by_opportunity_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF p_fresh_from IS NOT NULL
     AND p_fresh_to IS NOT NULL
     AND COALESCE(p_translation_safe, false) THEN
    RETURN QUERY
    WITH page_keys AS MATERIALIZED (
      SELECT o.source, o.source_id
      FROM public.opportunities AS o
      WHERE o.status = 'active'
        AND (o.source_language IS NULL OR o.source_language = 'en' OR o.translation_status = 'ok')
        AND (o.translation_status IS NULL OR o.translation_status <> 'error')
        AND o.posted_at >= p_fresh_from
        AND o.posted_at <= p_fresh_to
        AND (
          p_after_source IS NULL
          OR (
            p_after_source_id IS NOT NULL
            AND (o.source, o.source_id) > (p_after_source, p_after_source_id)
          )
        )
      ORDER BY o.source ASC, o.source_id ASC
      LIMIT LEAST(GREATEST(COALESCE(p_page_size, 1000), 1), 1000)
    )
    SELECT
      o.type,
      o.title,
      o.company,
      o.company_logo,
      o.description,
      o.source,
      o.source_id,
      o.source_url,
      o.official_url,
      o.canonical_url_hash,
      o.content_hash,
      o.employment_type,
      o.remote_type,
      o.eligible_countries,
      o.excluded_countries,
      o.timezone_requirements,
      o.salary_min,
      o.salary_max,
      o.salary_currency,
      o.salary_period,
      o.required_skills,
      o.preferred_skills,
      o.experience_requirement,
      o.quality_score,
      o.source_quality,
      o.description_completeness,
      o.salary_quality,
      o.remote_policy_confidence,
      o.explicit_remote_scope,
      o.status,
      o.posted_at,
      o.is_permanently_removed,
      o.link_checked_at,
      o.superseded_by_opportunity_id
    FROM page_keys AS k
    JOIN public.opportunities AS o
      ON o.source = k.source
     AND o.source_id = k.source_id
    ORDER BY k.source ASC, k.source_id ASC;
    RETURN;
  END IF;

  -- Preserve the generic RPC behaviour for callers that request other
  -- combinations of freshness and translation filters.
  RETURN QUERY
  SELECT
    o.type,
    o.title,
    o.company,
    o.company_logo,
    o.description,
    o.source,
    o.source_id,
    o.source_url,
    o.official_url,
    o.canonical_url_hash,
    o.content_hash,
    o.employment_type,
    o.remote_type,
    o.eligible_countries,
    o.excluded_countries,
    o.timezone_requirements,
    o.salary_min,
    o.salary_max,
    o.salary_currency,
    o.salary_period,
    o.required_skills,
    o.preferred_skills,
    o.experience_requirement,
    o.quality_score,
    o.source_quality,
    o.description_completeness,
    o.salary_quality,
    o.remote_policy_confidence,
    o.explicit_remote_scope,
    o.status,
    o.posted_at,
    o.is_permanently_removed,
    o.link_checked_at,
    o.superseded_by_opportunity_id
  FROM public.opportunities AS o
  WHERE o.status = 'active'
    AND (
      p_after_source IS NULL
      OR (
        p_after_source_id IS NOT NULL
        AND (o.source, o.source_id) > (p_after_source, p_after_source_id)
      )
    )
    AND (
      NOT COALESCE(p_translation_safe, false)
      OR (
        (o.source_language IS NULL OR o.source_language = 'en' OR o.translation_status = 'ok')
        AND (o.translation_status IS NULL OR o.translation_status <> 'error')
      )
    )
    AND (p_fresh_from IS NULL OR o.posted_at >= p_fresh_from)
    AND (p_fresh_to IS NULL OR o.posted_at <= p_fresh_to)
  ORDER BY o.source ASC, o.source_id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_page_size, 1000), 1), 1000);
END;
$function$;

COMMENT ON FUNCTION public.get_active_opportunities_keyset_page(text, text, integer, timestamp with time zone, timestamp with time zone, boolean) IS
  'Keyset-paged active opportunities. Fresh + translation-safe feed reads select keys from the partial covering cursor index before fetching wide rows.';
