-- Speed up the public ChatGPT job search without changing its substring semantics.
-- The endpoint ANDs each query term across title/company/description/skill tags.
-- Without these operator-class indexes Postgres must scan the entire active
-- catalogue (and PostgREST's exact count repeats that scan), hitting the
-- project's statement timeout on ordinary multi-term searches.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_title_trgm
  ON public.opportunities USING gin (title public.gin_trgm_ops)
  WHERE status = 'active'
    AND superseded_by_opportunity_id IS NULL
    AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok')
    AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_company_trgm
  ON public.opportunities USING gin (company public.gin_trgm_ops)
  WHERE status = 'active'
    AND superseded_by_opportunity_id IS NULL
    AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok')
    AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_description_trgm
  ON public.opportunities USING gin (description public.gin_trgm_ops)
  WHERE status = 'active'
    AND superseded_by_opportunity_id IS NULL
    AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok')
    AND (translation_status IS NULL OR translation_status <> 'error');

CREATE INDEX IF NOT EXISTS idx_opportunities_public_search_required_skills_gin
  ON public.opportunities USING gin (required_skills)
  WHERE status = 'active'
    AND superseded_by_opportunity_id IS NULL
    AND (source_language IS NULL OR source_language = 'en' OR translation_status = 'ok')
    AND (translation_status IS NULL OR translation_status <> 'error');

COMMENT ON INDEX public.idx_opportunities_public_search_title_trgm IS
  'Supports public ChatGPT job search title substring predicates for visible active jobs.';
COMMENT ON INDEX public.idx_opportunities_public_search_company_trgm IS
  'Supports public ChatGPT job search company substring predicates for visible active jobs.';
COMMENT ON INDEX public.idx_opportunities_public_search_description_trgm IS
  'Supports public ChatGPT job search description substring predicates for visible active jobs.';
COMMENT ON INDEX public.idx_opportunities_public_search_required_skills_gin IS
  'Supports exact required-skill tag containment in public ChatGPT job search.';
