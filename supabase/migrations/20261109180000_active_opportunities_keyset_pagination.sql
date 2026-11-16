-- Keyset pagination for the legacy full-catalog reader.
-- OFFSET pagination gets progressively more expensive and can shift between
-- page requests as rows are inserted/deleted. The unique (source, source_id)
-- pair provides a stable, index-backed cursor and bounded page reads.
--
-- SECURITY INVOKER preserves the caller's RLS boundary. Only active rows are
-- returned, matching opportunities_select_active; translation and freshness
-- gates are optional to preserve getActiveOpportunities() semantics.

CREATE OR REPLACE FUNCTION public.get_active_opportunities_keyset_page(
  p_after_source text,
  p_after_source_id text,
  p_page_size integer,
  p_fresh_from timestamptz,
  p_fresh_to timestamptz,
  p_translation_safe boolean
)
RETURNS TABLE (
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
  posted_at timestamptz,
  is_permanently_removed boolean,
  link_checked_at timestamptz,
  superseded_by_opportunity_id uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.get_active_opportunities_keyset_page(text, text, integer, timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_opportunities_keyset_page(text, text, integer, timestamptz, timestamptz, boolean)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_active_opportunities_keyset_page(text, text, integer, timestamptz, timestamptz, boolean) IS
  'RLS-scoped bounded keyset page for full-catalog reads, ordered by unique (source, source_id).';
