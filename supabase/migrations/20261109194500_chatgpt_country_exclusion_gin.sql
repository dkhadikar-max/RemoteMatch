-- Public ChatGPT search checks country exclusions with an indexed positive-overlap lookup.
-- Without this GIN index, even an empty excluded_countries array forces a full
-- scan when checking whether any jobs are excluded for a candidate country.
CREATE INDEX IF NOT EXISTS idx_opportunities_excluded_countries_gin
  ON public.opportunities USING gin (excluded_countries);

COMMENT ON INDEX public.idx_opportunities_excluded_countries_gin IS
  'Supports bounded country-exclusion lookups for public job discovery.';
