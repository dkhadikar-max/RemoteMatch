-- =============================================================================
-- 048: Database-side directory index and paginated hub read
--
-- The old directory path fetched every active, translation-safe listing in
-- 1,000-row PostgREST OFFSET pages and computed category membership in Node.
-- This projection keeps only the membership and ordering fields required for hub membership and
-- ordering in Postgres. A trigger maintains it transactionally with the source
-- row; the public RPC returns only the requested 24 full opportunity rows plus
-- the exact total. No materialized-view refresh window or stale projection.
--
-- The RPC is SECURITY INVOKER. RLS on both tables remains in force; the
-- projection contains only active, translation-safe public catalog fields.
-- =============================================================================

CREATE TABLE public.opportunity_catalog_index (
  opportunity_id uuid PRIMARY KEY REFERENCES public.opportunities(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_id text NOT NULL,
  title text NOT NULL,
  posted_at timestamptz,
  required_skills text[] NOT NULL DEFAULT ARRAY[]::text[],
  required_skills_lower text[] NOT NULL DEFAULT ARRAY[]::text[],
  remote_type text,
  eligible_countries text[] NOT NULL DEFAULT ARRAY[]::text[],
  experience_requirement text
);

CREATE INDEX opportunity_catalog_index_order
  ON public.opportunity_catalog_index (posted_at DESC NULLS LAST, source_id ASC, source ASC);

ALTER TABLE public.opportunity_catalog_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY opportunity_catalog_index_select_public
  ON public.opportunity_catalog_index
  FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON public.opportunity_catalog_index TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.opportunity_catalog_index TO service_role;

CREATE OR REPLACE FUNCTION public.sync_opportunity_catalog_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.opportunity_catalog_index
    WHERE opportunity_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.status = 'active'
     AND (
       NEW.source_language IS NULL
       OR NEW.source_language = 'en'
       OR NEW.translation_status = 'ok'
     )
     AND (
       NEW.translation_status IS NULL
       OR NEW.translation_status <> 'error'
     ) THEN
    INSERT INTO public.opportunity_catalog_index (
      opportunity_id,
      source,
      source_id,
      title,
      posted_at,
      required_skills,
      required_skills_lower,
      remote_type,
      eligible_countries,
      experience_requirement
    )
    VALUES (
      NEW.id,
      NEW.source,
      NEW.source_id,
      NEW.title,
      NEW.posted_at,
      COALESCE(NEW.required_skills, ARRAY[]::text[]),
      ARRAY(
        SELECT lower(skill)
        FROM unnest(COALESCE(NEW.required_skills, ARRAY[]::text[])) AS skills(skill)
      ),
      NEW.remote_type,
      COALESCE(NEW.eligible_countries, ARRAY[]::text[]),
      NEW.experience_requirement
    )
    ON CONFLICT (opportunity_id) DO UPDATE SET
      source = EXCLUDED.source,
      source_id = EXCLUDED.source_id,
      title = EXCLUDED.title,
      posted_at = EXCLUDED.posted_at,
      required_skills = EXCLUDED.required_skills,
      required_skills_lower = EXCLUDED.required_skills_lower,
      remote_type = EXCLUDED.remote_type,
      eligible_countries = EXCLUDED.eligible_countries,
      experience_requirement = EXCLUDED.experience_requirement;
  ELSE
    DELETE FROM public.opportunity_catalog_index
    WHERE opportunity_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_opportunity_catalog_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_opportunity_catalog_index() TO service_role;

CREATE TRIGGER opportunities_sync_catalog_index
  AFTER INSERT OR DELETE OR UPDATE OF
    source,
    source_id,
    title,
    posted_at,
    required_skills,
    remote_type,
    eligible_countries,
    experience_requirement,
    status,
    source_language,
    translation_status
  ON public.opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_opportunity_catalog_index();

-- Backfill existing active, translation-safe rows. The trigger is installed
-- first so subsequent writes remain in sync in the same transaction.
INSERT INTO public.opportunity_catalog_index (
  opportunity_id,
  source,
  source_id,
  title,
  posted_at,
  required_skills,
  required_skills_lower,
  remote_type,
  eligible_countries,
  experience_requirement
)
SELECT
  o.id,
  o.source,
  o.source_id,
  o.title,
  o.posted_at,
  COALESCE(o.required_skills, ARRAY[]::text[]),
  ARRAY(
    SELECT lower(skill)
    FROM unnest(COALESCE(o.required_skills, ARRAY[]::text[])) AS skills(skill)
  ),
  o.remote_type,
  COALESCE(o.eligible_countries, ARRAY[]::text[]),
  o.experience_requirement
FROM public.opportunities AS o
WHERE o.status = 'active'
  AND (
    o.source_language IS NULL
    OR o.source_language = 'en'
    OR o.translation_status = 'ok'
  )
  AND (
    o.translation_status IS NULL
    OR o.translation_status <> 'error'
  );

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
  WITH matched AS NOT MATERIALIZED (
    SELECT i.source_id, i.source, i.posted_at
    FROM public.opportunity_catalog_index AS i
    WHERE CASE
      WHEN p_category_slug IS NULL THEN true

      WHEN p_category_slug = 'worldwide'
        THEN i.remote_type = 'Worldwide'

      WHEN p_category_slug = 'united-states'
        THEN i.remote_type = 'US'
          OR i.eligible_countries && ARRAY['US', 'USA']::text[]

      WHEN p_category_slug = 'europe'
        THEN i.remote_type = 'EU/EEA'
          OR i.eligible_countries && ARRAY['EU', 'UK', 'EEA']::text[]

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
    SELECT count(*)::bigint AS total
    FROM matched
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
  resolved AS (
    SELECT
      page_ids.posted_at AS _index_posted_at,
      page_ids.source_id AS _index_source_id,
      page_ids.source AS _index_source,
      opportunity.*
    FROM page_ids
    JOIN LATERAL (
      SELECT o.*
      FROM public.opportunities AS o
      WHERE o.source_id = page_ids.source_id
        AND o.status = 'active'
        AND (
          o.source_language IS NULL
          OR o.source_language = 'en'
          OR o.translation_status = 'ok'
        )
        AND (
          o.translation_status IS NULL
          OR o.translation_status <> 'error'
        )
      ORDER BY o.source ASC
      LIMIT 1
    ) AS opportunity ON true
  )
  SELECT jsonb_build_object(
    'total', totals.total,
    'jobs',
    COALESCE(
      (
        SELECT jsonb_agg(
          to_jsonb(resolved) - '_index_posted_at' - '_index_source_id' - '_index_source'
          ORDER BY resolved._index_posted_at DESC NULLS LAST, resolved._index_source_id ASC, resolved._index_source ASC
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
