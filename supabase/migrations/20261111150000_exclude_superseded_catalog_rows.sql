-- Keep the public catalogue projection in sync with supersession.
-- Superseded rows must not appear in directory totals, pages, or sitemap reads.
-- The trigger handles future inserts/updates; the DELETE repairs existing rows.

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
     AND NEW.superseded_by_opportunity_id IS NULL
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
      opportunity_id, source, source_id, title, posted_at,
      required_skills, required_skills_lower, remote_type,
      eligible_countries, experience_requirement
    )
    VALUES (
      NEW.id, NEW.source, NEW.source_id, NEW.title, NEW.posted_at,
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

DROP TRIGGER IF EXISTS opportunities_sync_catalog_index ON public.opportunities;
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
    translation_status,
    superseded_by_opportunity_id
  ON public.opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_opportunity_catalog_index();

DELETE FROM public.opportunity_catalog_index AS catalog
USING public.opportunities AS opportunity
WHERE catalog.opportunity_id = opportunity.id
  AND opportunity.superseded_by_opportunity_id IS NOT NULL;

ANALYZE public.opportunity_catalog_index;
