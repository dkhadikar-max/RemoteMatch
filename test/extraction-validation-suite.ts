/**
 * Supply Discovery gate C5 — evidence validation (docs/c5-implementation-plan.md §6, §12).
 * Pure function under test, no infra. Also exercises domain-rate-limiter.ts
 * (§4b), a small pure module with no dedicated suite of its own per the
 * spec's §12 test list.
 */
import { validateExtraction } from '../src/lib/ingestion/extraction-validation';
import type { CareerPageExtraction } from '../src/lib/ai/career-page-extraction';
import { waitForDomainSlot, resetDomainRateLimiter } from '../src/lib/ingestion/domain-rate-limiter';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

const SOURCE_TEXT = `
Senior Backend Engineer — Remote (Worldwide)

We are hiring a Senior Backend Engineer to join our platform team.
This is a fully remote, worldwide-eligible role.
Employment Type: Full-time.
Posted on 2026-09-12.
Salary range: $140,000 - $180,000 USD annually.
`;

function baseExtraction(overrides: Partial<CareerPageExtraction> = {}): CareerPageExtraction {
  return {
    title: 'Senior Backend Engineer',
    titleEvidence: 'Senior Backend Engineer',
    description: 'A senior backend role on the platform team, fully remote.',
    locationString: 'Remote (Worldwide)',
    locationEvidence: 'Remote (Worldwide)',
    publicationDate: '2026-09-12',
    publicationDateEvidence: 'Posted on 2026-09-12',
    salaryMin: 140000,
    salaryMax: 180000,
    salaryEvidence: '$140,000 - $180,000 USD annually',
    jobType: 'Full-time',
    jobTypeEvidence: 'Employment Type: Full-time',
    officialUrl: 'https://example.com/careers/senior-backend-engineer',
    ...overrides,
  };
}

const CONTEXT = { sourceId: 'careerpage-test-1', source: 'careerpage', company: 'Acme Corp' };

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C5 — EVIDENCE VALIDATION');
  console.log('==============================================================================\n');

  console.log('1. Exact match — fully valid candidate');
  let result = validateExtraction(baseExtraction(), SOURCE_TEXT, CONTEXT);
  assert(result.valid === true, 'well-formed extraction with real evidence validates');
  if (result.valid) {
    assert(result.candidate.title === 'Senior Backend Engineer', 'candidate.title carried through');
    assert(result.candidate.company === 'Acme Corp', 'candidate.company comes from context, never the schema');
    assert(result.candidate.publicationDate === '2026-09-12', 'valid, evidence-backed date is kept');
    assert(result.candidate.salaryMin === 140000 && result.candidate.salaryMax === 180000, 'valid, evidence-backed salary is kept');
  }

  console.log('\n2. Near-match — whitespace/case-insensitive evidence still validates');
  result = validateExtraction(
    baseExtraction({ titleEvidence: '  senior   backend engineer  ', locationEvidence: 'REMOTE (worldwide)' }),
    SOURCE_TEXT,
    CONTEXT
  );
  assert(result.valid === true, 'whitespace-normalized, case-insensitive evidence match still validates');

  console.log('\n3. Missing evidence for a required field invalidates the ENTIRE candidate');
  result = validateExtraction(baseExtraction({ titleEvidence: 'A completely fabricated title never in the source' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === false, 'unsupported title evidence invalidates the whole candidate, not just that field');

  result = validateExtraction(baseExtraction({ locationEvidence: 'On-site only, no remote work' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === false, 'unsupported location evidence invalidates the whole candidate');

  result = validateExtraction(baseExtraction({ jobTypeEvidence: 'Contract, 6 months' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === false, 'unsupported jobType evidence invalidates the whole candidate');

  console.log('\n4. Evidence present in source but for the WRONG field (known mechanical-screen limitation)');
  // The evidence text genuinely exists in the source, just misattributed —
  // a purely mechanical substring screen cannot catch semantic misattribution,
  // exactly like anti-fabrication.ts's own documented limitation. This test
  // documents that known boundary rather than asserting a false capability.
  result = validateExtraction(baseExtraction({ titleEvidence: 'Employment Type: Full-time' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === true, 'a real-but-misattributed evidence substring still mechanically validates (documented limitation, not a defect)');

  console.log('\n5. publicationDate carve-out — degrades to null, does NOT invalidate the candidate');
  result = validateExtraction(baseExtraction({ publicationDateEvidence: 'never actually in the source text' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === true, 'unverifiable date evidence does not invalidate the candidate');
  if (result.valid) assert(result.candidate.publicationDate === '', 'unverifiable date degrades to empty/no date, never guessed');

  result = validateExtraction(baseExtraction({ publicationDate: null, publicationDateEvidence: null }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === true, 'absent date entirely still validates the rest of the candidate');
  if (result.valid) assert(result.candidate.publicationDate === '', 'absent date produces empty publicationDate, which passesFreshnessGate() rejects downstream unmodified');

  console.log('\n6. salary carve-out — dropped, not fatal, when unverifiable');
  result = validateExtraction(baseExtraction({ salaryEvidence: 'never actually in the source text' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === true, 'unverifiable salary evidence does not invalidate the candidate');
  if (result.valid) assert(result.candidate.salaryMin === undefined && result.candidate.salaryMax === undefined, 'unverifiable salary is dropped, not guessed or kept');

  console.log('\n7. Empty/missing required fields invalidate');
  result = validateExtraction(baseExtraction({ title: '' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === false, 'empty title invalidates');
  result = validateExtraction(baseExtraction({ description: '   ' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === false, 'whitespace-only description invalidates');
  result = validateExtraction(baseExtraction({ officialUrl: '' }), SOURCE_TEXT, CONTEXT);
  assert(result.valid === false, 'missing officialUrl invalidates (not evidence-checked, but still required)');

  console.log('\n8. Domain-level rate limiter (§4b) — sequential-with-delay, sized for a small cohort');
  resetDomainRateLimiter();
  const start = Date.now();
  await waitForDomainSlot('example.com', 200);
  const afterFirst = Date.now();
  assert(afterFirst - start < 100, 'first call for a fresh domain does not wait');
  await waitForDomainSlot('example.com', 200);
  const afterSecond = Date.now();
  assert(afterSecond - afterFirst >= 180, 'second call for the same domain waits out the remaining minimum delay');
  await waitForDomainSlot('other-domain.com', 200);
  const afterThird = Date.now();
  assert(afterThird - afterSecond < 100, 'a DIFFERENT domain is not throttled by another domain\'s timer');

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, 0 skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running extraction-validation suite:', e); process.exit(1); });
