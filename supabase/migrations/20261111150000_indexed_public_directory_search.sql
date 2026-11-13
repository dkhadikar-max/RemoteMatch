-- Indexed, paginated public directory search.
-- Trigram GIN indexes preserve substring matching for 3+ character terms;
-- prefix/FTS indexes keep short-token searches bounded. All indexes are partial
-- over the same public active + translation-safe + non-superseded population
-- enforced by the RPC below.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_company_prefix ON public.opportunities USING btree (lower(company) text_pattern_ops) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_company_trgm ON public.opportunities USING gin (company gin_trgm_ops) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_description_trgm ON public.opportunities USING gin (description gin_trgm_ops) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_remote_type_prefix ON public.opportunities USING btree (lower(remote_type) text_pattern_ops) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_remote_type_trgm ON public.opportunities USING gin (remote_type gin_trgm_ops) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_required_skills_gin ON public.opportunities USING gin (required_skills) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_short_fts ON public.opportunities USING gin (to_tsvector('simple'::regconfig, COALESCE(title, '') || ' ' || COALESCE(company, '') || ' ' || COALESCE(remote_type, ''))) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_title_prefix ON public.opportunities USING btree (lower(title) text_pattern_ops) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_title_trgm ON public.opportunities USING gin (title gin_trgm_ops) WHERE status = 'active' AND superseded_by_opportunity_id IS NULL AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok') AND (translation_status IS NULL OR translation_status <> 'error');

-- SECURITY DEFINER is intentional: the function explicitly constrains every
-- result to public active, translation-safe, non-superseded listings. It returns
-- only public opportunity fields and never accepts caller-provided SQL.
CREATE OR REPLACE FUNCTION public.get_remote_job_search_page(p_terms text[] DEFAULT ARRAY[]::text[], p_offset integer DEFAULT 0, p_page_size integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

  -- Terms with at least three alphanumeric characters use substring matching
  -- and the pg_trgm indexes across all five searchable fields. Shorter terms
  -- use token-prefix FTS (for two-character alphanumeric terms), indexed field
  -- prefixes, and exact skill-tag matching instead of scanning descriptions.
  FOR v_i IN 1..COALESCE(CARDINALITY(v_terms), 0) LOOP
    IF LENGTH(REGEXP_REPLACE(v_terms[v_i], '[^a-z0-9]', '', 'g')) < 3 THEN
      IF LENGTH(REGEXP_REPLACE(v_terms[v_i], '[^a-z0-9]', '', 'g')) = 2 AND v_terms[v_i] ~ '^[a-z0-9]+$' THEN
        v_predicate := v_predicate || FORMAT(
          ' AND (
            to_tsvector(''simple''::regconfig, COALESCE(o.title, '''') || '' '' || COALESCE(o.company, '''') || '' '' || COALESCE(o.remote_type, ''''))
              @@ to_tsquery(''simple'', %L)
            OR lower(o.title) LIKE %L
            OR lower(o.company) LIKE %L
            OR lower(o.remote_type) LIKE %L
            OR (o.required_skills @> ARRAY[%L]::text[] OR o.required_skills @> ARRAY[%L]::text[] OR o.required_skills @> ARRAY[%L]::text[])
            OR EXISTS (SELECT 1 FROM public.opportunity_catalog_index AS skill_match WHERE skill_match.opportunity_id = o.id AND skill_match.required_skills_lower @> ARRAY[%L]::text[])
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
            OR EXISTS (SELECT 1 FROM public.opportunity_catalog_index AS skill_match WHERE skill_match.opportunity_id = o.id AND skill_match.required_skills_lower @> ARRAY[%L]::text[])
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
          o.title ILIKE %L
          OR o.company ILIKE %L
          OR o.description ILIKE %L
          OR o.remote_type ILIKE %L
          OR (o.required_skills @> ARRAY[%L]::text[] OR o.required_skills @> ARRAY[%L]::text[] OR o.required_skills @> ARRAY[%L]::text[])
            OR EXISTS (SELECT 1 FROM public.opportunity_catalog_index AS skill_match WHERE skill_match.opportunity_id = o.id AND skill_match.required_skills_lower @> ARRAY[%L]::text[])
        )',
        '%' || v_terms[v_i] || '%',
        '%' || v_terms[v_i] || '%',
        '%' || v_terms[v_i] || '%',
        '%' || v_terms[v_i] || '%',
        v_terms[v_i],
        INITCAP(v_terms[v_i]),
        UPPER(v_terms[v_i]),
        v_terms[v_i]
      );
    END IF;
  END LOOP;

  -- A query containing only stripped punctuation has no searchable terms.
  -- Return an empty result instead of turning it into an expensive full-catalog scan.
  IF COALESCE(CARDINALITY(v_terms), 0) = 0 THEN
    RETURN JSONB_BUILD_OBJECT('total', 0, 'jobs', '[]'::jsonb);
  END IF;

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
  INTO v_total;

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
         LIMIT $1 OFFSET $2
       ) AS page_row',
    v_predicate
  )
  INTO v_jobs
  USING v_page_size, v_offset;

  RETURN JSONB_BUILD_OBJECT(
    'total', v_total,
    'jobs', COALESCE(v_jobs, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_remote_job_search_page(text[], integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_remote_job_search_page(text[], integer, integer)
  TO anon, authenticated, service_role;


-- The live directory integration also exercises category hubs. Keep the
-- software-engineering membership predicate on an ordered partial index so
-- its exact COUNT(*) and newest-first page query do not scan the full
-- 82k+ row catalog projection on every cold hub request. This is deliberately
-- on the slim projection (not opportunities), matching get_remote_job_hub_page.
CREATE INDEX IF NOT EXISTS opportunity_catalog_index_software_engineering_hub_order
  ON public.opportunity_catalog_index (posted_at DESC NULLS LAST, source_id ASC, source ASC)
  WHERE lower(title) LIKE '%software engineering%'
     OR lower(title) LIKE '%engineer%'
     OR lower(title) LIKE '%developer%'
     OR required_skills_lower && ARRAY[
       'react', 'typescript', 'node.js', 'go', 'python', 'kubernetes', 'distributed systems'
     ]::text[];
