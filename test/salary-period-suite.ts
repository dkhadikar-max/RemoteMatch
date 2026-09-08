/**
 * RemoteMatch — Salary-period factual-schema regression (Live Supply blocker 2)
 * ==============================================================================
 * buildJobPostingSchema() hard-coded `unitText: 'YEAR'` after the raw
 * pay-period text stopped being persisted. For a "$40/hour" listing that
 * emits `minValue: 40, unitText: YEAR` — factually wrong, and against the
 * "do not invent missing facts" rule.
 *
 * Fix: persist a normalized `salaryPeriod` (resolveSalaryPeriod — an explicit
 * provider value or an unambiguous marker in the raw string, never a guess
 * from a bare number). schema.org `unitText` is emitted ONLY for a known
 * period; 'unknown'/undefined -> no unitText (the salary is still emitted).
 *
 * Run: npx tsx test/salary-period-suite.ts
 */
import { RawJobPayload } from '../src/lib/providers/types';
import { resolveSalaryPeriod, normalizeOpportunity } from '../src/lib/ingestion/pipeline';
import { buildJobPostingSchema } from '../src/lib/seo/data';
import { CanonicalOpportunity } from '../src/types/byn';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function raw(overrides: Partial<RawJobPayload>): RawJobPayload {
  return {
    sourceId: 's1', source: 'remotive', title: 'Engineer', company: 'Co',
    description: 'x'.repeat(120), officialUrl: 'https://ex.co/1', jobType: 'Full-time',
    locationString: 'Worldwide', publicationDate: new Date().toISOString(),
    ...overrides,
  };
}

function activeJob(overrides: Partial<CanonicalOpportunity>): CanonicalOpportunity {
  const now = new Date().toISOString();
  return {
    id: 'opp-curated-sp-1', type: 'job', title: 'Engineer', company: 'Co',
    description: 'A role.', source: 'curated', sourceId: 'sp-1',
    officialUrl: 'https://ex.co/1', canonicalUrlHash: 'h', contentHash: 'c',
    employmentType: 'Full-time', remoteType: 'Worldwide',
    eligibleCountries: [], excludedCountries: [], timezoneRequirements: [],
    salaryCurrency: 'USD', requiredSkills: [], preferredSkills: [],
    experienceRequirement: '4-6', qualityScore: 85, status: 'active', isActive: true,
    postedAt: now, lastVerifiedAt: now,
    ...overrides,
  };
}

function run() {
  console.log('='.repeat(78));
  console.log('SALARY-PERIOD FACTUAL-SCHEMA REGRESSION (blocker 2)');
  console.log('='.repeat(78) + '\n');

  // --- resolveSalaryPeriod: markers vs. no-guess ---
  assert(resolveSalaryPeriod(raw({ salaryString: '$70 - $110 / hour' })) === 'hourly', '"/ hour" -> hourly');
  assert(resolveSalaryPeriod(raw({ salaryString: 'USD 50 per hour' })) === 'hourly', '"per hour" -> hourly');
  assert(resolveSalaryPeriod(raw({ salaryString: '$5,000 - $8,000 / month' })) === 'monthly', '"/ month" -> monthly');
  assert(resolveSalaryPeriod(raw({ salaryString: '£90,000 per annum' })) === 'yearly', '"per annum" -> yearly');
  assert(resolveSalaryPeriod(raw({ salaryString: '$120,000 - $160,000 USD' })) === 'unknown',
    'a bare "$120,000 - $160,000 USD" (no period word) -> unknown, NOT guessed yearly');
  assert(resolveSalaryPeriod(raw({ salaryString: undefined })) === 'unknown', 'no salary string -> unknown');
  assert(resolveSalaryPeriod(raw({ salaryPeriod: 'yearly', salaryString: undefined })) === 'yearly',
    'an explicit provider salaryPeriod wins');

  // --- normalizeOpportunity carries it through ---
  const nHourly = normalizeOpportunity(raw({ salaryString: '$70 - $110 / hour', salaryMin: 70, salaryMax: 110 }));
  assert(nHourly.salaryPeriod === 'hourly', `normalizeOpportunity persists hourly (got ${nHourly.salaryPeriod})`);
  const nUnknown = normalizeOpportunity(raw({ salaryString: '$120,000 USD', salaryMin: 120000 }));
  assert(nUnknown.salaryPeriod === 'unknown', `normalizeOpportunity persists unknown (got ${nUnknown.salaryPeriod})`);

  // --- buildJobPostingSchema: unitText only for a known period ---
  const yr = buildJobPostingSchema(activeJob({ salaryMin: 120000, salaryMax: 160000, salaryPeriod: 'yearly' }));
  assert(yr?.baseSalary?.value?.unitText === 'YEAR', `yearly -> unitText YEAR (got ${yr?.baseSalary?.value?.unitText})`);

  const hr = buildJobPostingSchema(activeJob({ salaryMin: 70, salaryMax: 110, salaryPeriod: 'hourly' }));
  assert(hr?.baseSalary?.value?.unitText === 'HOUR', `hourly -> unitText HOUR (got ${hr?.baseSalary?.value?.unitText})`);

  const mo = buildJobPostingSchema(activeJob({ salaryMin: 5000, salaryMax: 8000, salaryPeriod: 'monthly' }));
  assert(mo?.baseSalary?.value?.unitText === 'MONTH', `monthly -> unitText MONTH (got ${mo?.baseSalary?.value?.unitText})`);

  const unk = buildJobPostingSchema(activeJob({ salaryMin: 120000, salaryMax: 160000, salaryPeriod: 'unknown' }));
  assert(unk?.baseSalary?.value && !('unitText' in unk.baseSalary.value),
    'unknown period -> unitText OMITTED entirely (never defaulted to YEAR)');
  assert(unk?.baseSalary?.value?.minValue === 120000,
    'unknown period -> the salary itself is STILL emitted (minValue present)');

  const undef = buildJobPostingSchema(activeJob({ salaryMin: 90000, salaryPeriod: undefined }));
  assert(undef?.baseSalary?.value && !('unitText' in undef.baseSalary.value),
    'undefined period -> unitText also omitted');

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run();
