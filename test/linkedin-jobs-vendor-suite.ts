/**
 * LinkedIn Job Finder — vendor filtering + search orchestration. Real
 * logic, tested via an INJECTED FAKE JobSearchVendor (mirroring this
 * project's own JobProvider-injection test pattern, e.g.
 * career-page-dedup-suite.ts) — no real SerpApi key needed, since none is
 * provisioned as part of this implementation pass. Pure, no infra.
 *
 * Run: npx tsx test/linkedin-jobs-vendor-suite.ts
 */
import { filterToLinkedInResults, VendorNotConfiguredError, type JobSearchVendor, type RawVendorJob } from '../src/lib/linkedin-jobs/vendor';
import { runLinkedInJobSearch } from '../src/lib/linkedin-jobs/search';
import type { PersonProfile, ProfileSkill } from '../src/types/byn';

let passed = 0, failed = 0;
const assert = (c: boolean, n: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}`); }
};

function skill(name: string): ProfileSkill {
  return { id: `s-${name}`, profileId: 'p1', skillName: name, isPrimary: false };
}
function baseProfile(skills: string[]): PersonProfile {
  return {
    id: 'p1', fullName: 'Test', email: 't@example.com', headline: '', profileStrength: 50,
    planTier: 'free', dailyRightSwipesCount: 0, dailyProposalsCount: 0, usageDate: '2026-01-01',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    skills: skills.map(skill),
    intent: { id: 'i1', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: [], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '2026-01-01T00:00:00Z' },
    location: { id: 'l1', profileId: 'p1', currentCountry: 'United States', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    experiences: [],
  } as unknown as PersonProfile;
}

async function run() {
console.log('==============================================================================');
console.log('LINKEDIN JOB FINDER — vendor filtering + search orchestration');
console.log('==============================================================================\n');

console.log('1. filterToLinkedInResults() — the core "genuinely LinkedIn Job Finder, not a generic aggregator" guarantee');
{
  const raw: RawVendorJob[] = [
    {
      title: 'Has LinkedIn', company: 'A', applyOptions: [
        { title: 'Indeed', link: 'https://www.indeed.com/job/1' },
        { title: 'LinkedIn', link: 'https://www.linkedin.com/jobs/view/1' },
      ],
    },
    {
      title: 'No LinkedIn option', company: 'B', applyOptions: [
        { title: 'Indeed', link: 'https://www.indeed.com/job/2' },
        { title: 'Company site', link: 'https://b.example.com/careers/2' },
      ],
    },
    {
      title: 'Malformed apply link', company: 'C', applyOptions: [
        { title: 'broken', link: 'not a url' },
      ],
    },
    {
      title: 'Lookalike host', company: 'D', applyOptions: [
        { title: 'fake', link: 'https://www.linkedin.com.evil.example/jobs/view/9' },
      ],
    },
  ];
  const filtered = filterToLinkedInResults(raw);
  assert(filtered.length === 1, `only the job with a real linkedin.com apply option survives (got ${filtered.length})`);
  assert(filtered[0].title === 'Has LinkedIn', 'the surviving result is the correct one');
  assert(filtered[0].linkedinUrl === 'https://www.linkedin.com/jobs/view/1', 'the correct linkedin.com URL was extracted');
  assert(
    !filtered.some((f) => f.linkedinUrl.includes('evil.example')),
    'a lookalike host (linkedin.com.evil.example) is correctly rejected, not matched as a real linkedin.com URL'
  );
}

console.log('\n2. runLinkedInJobSearch() — fails safe when the vendor is not configured');
{
  const notConfiguredVendor: JobSearchVendor = {
    name: 'fake_not_configured',
    search: async () => { throw new VendorNotConfiguredError(); },
  };
  const outcome = await runLinkedInJobSearch(baseProfile(['Python']), {}, notConfiguredVendor);
  assert(outcome.vendorConfigured === false, 'vendorConfigured correctly reported false, not a thrown error');
  assert(outcome.results.length === 0, 'zero results returned, not a crash');
}

console.log('\n3. runLinkedInJobSearch() — end-to-end with a real fake vendor: filter -> normalize -> match');
{
  const fakeVendor: JobSearchVendor = {
    name: 'fake',
    search: async () => [
      {
        title: 'Senior Python Engineer', company: 'RealCo', location: 'Remote',
        description: 'Python, Django, AWS experience required.',
        applyOptions: [{ link: 'https://www.linkedin.com/jobs/view/100' }],
      },
      {
        title: 'No LinkedIn link here', company: 'OtherCo',
        applyOptions: [{ link: 'https://www.indeed.com/job/200' }],
      },
    ],
  };
  const profile = baseProfile(['Python', 'AWS']);
  const outcome = await runLinkedInJobSearch(profile, { keywords: 'python' }, fakeVendor);
  assert(outcome.vendorConfigured === true, 'vendorConfigured reported true for a working vendor');
  assert(outcome.results.length === 1, `only the LinkedIn-apply-option job survives into results (got ${outcome.results.length})`);
  const r = outcome.results[0];
  assert(r.title === 'Senior Python Engineer', 'correct job survived');
  assert(r.linkedinUrl === 'https://www.linkedin.com/jobs/view/100', 'real LinkedIn URL attached to the result');
  assert(r.provenance === 'vendor_search', "result correctly tagged provenance 'vendor_search'");
  assert(r.match.fitScore > 0, `real match computed end-to-end (fitScore=${r.match.fitScore})`);
  assert(r.id.startsWith('li-'), 'result id is li-namespaced');
}

console.log('\n4. runLinkedInJobSearch() — a generic vendor error (not VendorNotConfiguredError) also fails safe, not a 500 crash');
{
  const brokenVendor: JobSearchVendor = {
    name: 'fake_broken',
    search: async () => { throw new Error('network timeout'); },
  };
  const outcome = await runLinkedInJobSearch(baseProfile([]), {}, brokenVendor);
  assert(outcome.vendorConfigured === true, 'a generic failure is distinguished from "not configured" (vendor WAS reachable/attempted)');
  assert(outcome.results.length === 0, 'zero results on a generic vendor failure, not a thrown exception');
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running linkedin-jobs-vendor-suite:', e); process.exit(1); });
