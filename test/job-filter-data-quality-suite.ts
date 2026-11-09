import assert from 'node:assert/strict';
import { normalizeOpportunity, resolveExperienceRequirement } from '../src/lib/ingestion/pipeline';
import type { RawJobPayload } from '../src/lib/providers/types';

function raw(overrides: Partial<RawJobPayload> = {}): RawJobPayload {
  return {
    sourceId: 'filter-quality-test',
    source: 'remotive',
    title: 'Senior Engineer',
    company: 'Test Co',
    description: 'A role description with enough detail to be active.',
    officialUrl: 'https://example.com/job',
    jobType: 'Full-time',
    publicationDate: new Date().toISOString(),
    ...overrides,
  };
}

assert.equal(
  resolveExperienceRequirement(raw({ description: 'Experience: 8-10 years of sales experience.' })),
  '7-10',
  'explicit 8-10 years must map to the 7-10 product band'
);
assert.equal(
  resolveExperienceRequirement(raw({ description: 'Senior role. Build scalable systems.' })),
  undefined,
  'seniority wording alone must not fabricate years of experience'
);
assert.equal(
  resolveExperienceRequirement(raw({ experienceLevel: 'Any' })),
  undefined,
  'provider Any label must remain unknown rather than a false tier'
);
assert.equal(
  resolveExperienceRequirement(raw({ experienceLevel: '4-6' })),
  '4-6',
  'explicit provider experience band must be preserved'
);

const noSalary = normalizeOpportunity(raw({ salaryCurrency: 'USD' }));
assert.equal(noSalary.salaryCurrency, undefined, 'currency without disclosed numeric salary is not meaningful');
const salaryWithoutCurrency = normalizeOpportunity(raw({ salaryMin: 100000, salaryMax: 120000 }));
assert.equal(salaryWithoutCurrency.salaryCurrency, undefined, 'numeric salary without a currency must not default to USD');
const salaryWithCurrency = normalizeOpportunity(raw({ salaryMin: 100000, salaryMax: 120000, salaryCurrency: 'INR' }));
assert.equal(salaryWithCurrency.salaryCurrency, 'INR', 'explicit salary currency must be retained');

console.log('Job filter data quality suite passed: explicit experience bands and non-fabricated salary currency.');
