-- The directory category predicates used POSITION(... IN lower(title)), which
-- cannot use the trigram indexes. That forced a sequential scan of all ~79k
-- projection rows on every uncached hub request. Express substring matching as
-- LIKE so pg_trgm can index it, and index the projection's array predicates.
CREATE INDEX IF NOT EXISTS opportunity_catalog_index_title_trgm
  ON public.opportunity_catalog_index USING gin (lower(title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS opportunity_catalog_index_skills_lower_gin
  ON public.opportunity_catalog_index USING gin (required_skills_lower);

CREATE INDEX IF NOT EXISTS opportunity_catalog_index_remote_type
  ON public.opportunity_catalog_index (remote_type);

CREATE INDEX IF NOT EXISTS opportunity_catalog_index_eligible_countries_gin
  ON public.opportunity_catalog_index USING gin (eligible_countries);

CREATE INDEX IF NOT EXISTS opportunity_catalog_index_experience_requirement
  ON public.opportunity_catalog_index (experience_requirement);

-- Preserve the deployed RPC definition and its security/search_path/work_mem
-- settings; only replace non-indexable title substring predicates.
DO $$
DECLARE
  definition text;
BEGIN
  definition := pg_get_functiondef(
    'public.get_remote_job_hub_page(text,integer,integer)'::regprocedure
  );

  definition := replace(definition,
    'position(''senior'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%senior%''');
  definition := replace(definition,
    'position(''lead'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%lead%''');
  definition := replace(definition,
    'position(''staff'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%staff%''');
  definition := replace(definition,
    'position(''software engineering'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%software engineering%''');
  definition := replace(definition,
    'position(''engineer'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%engineer%''');
  definition := replace(definition,
    'position(''developer'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%developer%''');
  definition := replace(definition,
    'position(''product management'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%product management%''');
  definition := replace(definition,
    'position(''design'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%design%''');
  definition := replace(definition,
    'position(''data'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%data%''');
  definition := replace(definition,
    'position(''marketing'' in lower(i.title)) > 0',
    'lower(i.title) LIKE ''%marketing%''');

  IF strpos(definition, 'position(''data'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''design'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''engineer'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''developer'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''marketing'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''senior'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''lead'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''staff'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''product management'' in lower(i.title)) > 0') > 0
     OR strpos(definition, 'position(''software engineering'' in lower(i.title)) > 0') > 0
  THEN
    RAISE EXCEPTION 'Catalog hub predicate rewrite incomplete; refusing partial function update';
  END IF;

  EXECUTE definition;
END
$$;
