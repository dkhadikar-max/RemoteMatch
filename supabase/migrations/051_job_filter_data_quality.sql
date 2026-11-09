-- Remove ingestion fallbacks that presented missing source data as facts.
-- Older rows with the historic generic 2-3 default cannot be trusted; clear
-- only non-curated/non-employer rows and let subsequent syncs repopulate
-- explicit provider evidence. Salary currency is not meaningful without pay.
UPDATE public.opportunities
SET experience_requirement = NULL
WHERE experience_requirement = '2-3'
  AND source NOT IN ('curated', 'employerdirect');

UPDATE public.opportunities
SET salary_currency = NULL
WHERE salary_min IS NULL AND salary_max IS NULL;

COMMENT ON COLUMN public.opportunities.experience_requirement IS
  'Source-provided or explicitly extracted experience band. NULL means undisclosed; never assume a default.';
COMMENT ON COLUMN public.opportunities.salary_currency IS
  'Currency code only when a numeric salary is disclosed. NULL means compensation is undisclosed.';
