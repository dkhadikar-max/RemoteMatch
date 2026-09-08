-- ==============================================================================
-- RemoteMatch — 011: persist salary pay-period (Live Supply Activation blocker fix)
--
-- Context: migration 010 reactivated the `opportunities` catalog but persisted
-- only salary_min/salary_max/salary_currency — not the pay PERIOD. As a result
-- buildJobPostingSchema() (src/lib/seo/data.ts) had no truthful period to emit
-- and hard-coded schema.org `unitText: 'YEAR'`. For an "$40 / hour" listing
-- that produces `minValue: 40, unitText: YEAR` — a false structured-data claim,
-- against the "do not invent missing facts" rule.
--
-- This column is set by normalizeOpportunity()'s resolveSalaryPeriod():
--   1. an explicit provider value (RawJobPayload.salaryPeriod), e.g. Jobicy's
--      `annualSalary*` fields -> 'yearly';
--   2. else an unambiguous marker in the raw salary string ("/ hour", "per
--      annum", ...);
--   3. else 'unknown' — never guessed from a bare number.
-- 'unknown' / NULL means the source never stated it, and buildJobPostingSchema()
-- then OMITS `unitText` rather than defaulting it.
--
-- Additive, safe on the already-live catalog: a nullable column with a CHECK,
-- no backfill required (existing rows read as NULL == unknown until the next
-- sync cycle rewrites them). Deploy this BEFORE the code that writes it
-- (catalog-sync.ts) — the write includes `salary_period` and would 42703 on a
-- pre-migration schema.
-- ==============================================================================

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS salary_period TEXT
  CHECK (salary_period IS NULL OR salary_period IN ('hourly', 'monthly', 'yearly', 'unknown'));

COMMENT ON COLUMN opportunities.salary_period IS
  'Pay period for salary_min/salary_max: hourly | monthly | yearly | unknown '
  '(NULL == unknown). Set by normalizeOpportunity()/resolveSalaryPeriod from an '
  'explicit provider value or an unambiguous marker in the raw salary string, '
  'never guessed from a bare number. buildJobPostingSchema() maps a KNOWN period '
  'to schema.org unitText and omits unitText entirely otherwise.';

-- ==============================================================================
-- DOWN:  ALTER TABLE opportunities DROP COLUMN IF EXISTS salary_period;
-- ==============================================================================
