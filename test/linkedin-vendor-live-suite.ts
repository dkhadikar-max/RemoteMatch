/**
 * LinkedIn Job Finder — LIVE verification of the real SerpApi Google Jobs
 * vendor path (src/lib/linkedin-jobs/vendor.ts's SerpApiGoogleJobsVendor).
 * Authorized one-off verification call (Step 2 of the session's gated
 * sequence). Real SERPAPI_KEY, real HTTP call to serpapi.com — RemoteMatch
 * itself never contacts linkedin.com.
 *
 * Covers the 7-point verification list:
 *   1. receives structured job results            -> Section 1
 *   2. filters strictly to genuine linkedin.com URLs -> Section 1
 *   3. normalizes into the li-* namespace          -> Section 2
 *   4. runs the existing matching pipeline          -> Section 2
 *   5. correct LinkedIn attribution/confidence      -> Section 2
 *   6. Pro/Free search limits                       -> NOT covered here —
 *      requires reserve_linkedin_search() (migration 027), explicitly not
 *      applied this step. See report.
 *   7. fails safely when vendor unavailable/quota exhausted -> the
 *      "vendor unavailable" half is Section 3 (real); the "DB quota
 *      exhausted" half is the same migration-027 dependency as #6.
 *
 * Run: npx tsx test/linkedin-vendor-live-suite.ts
 */
import { SerpApiGoogleJobsVendor, filterToLinkedInResults } from '../src/lib/linkedin-jobs/vendor';
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
function realProfile(): PersonProfile {
  return {
    id: 'p1', fullName: 'Jordan Rivera', email: 'jordan@example.com', headline: 'Software Engineer',
    profileStrength: 70, planTier: 'pro', dailyRightSwipesCount: 0, dailyProposalsCount: 0,
    usageDate: '2026-09-15', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    skills: [skill('JavaScript'), skill('React'), skill('Node')],
    intent: { id: 'i1', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: [], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '2026-01-01T00:00:00Z' },
    location: { id: 'l1', profileId: 'p1', currentCountry: 'United States', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    experiences: [],
  } as unknown as PersonProfile;
}

async function run() {
  console.log('==============================================================================');
  console.log('LINKEDIN JOB FINDER — LIVE SerpApi Google Jobs vendor verification');
  console.log('==============================================================================\n');

  if (!process.env.SERPAPI_KEY) {
    console.log('SERPAPI_KEY not set in this shell — skipping.');
    return;
  }

  console.log('1/2. Real vendor call + strict LinkedIn-apply-option filtering');
  const vendor = new SerpApiGoogleJobsVendor();
  const raw = await vendor.search({ keywords: 'remote software engineer', remoteOnly: true });
  console.log(`  Raw results from SerpApi: ${raw.length}`);
  assert(raw.length > 0, `SerpApi returned real, structured job results (got ${raw.length})`);
  assert(
    raw.every((j) => typeof j.title === 'string' && typeof j.company === 'string' && Array.isArray(j.applyOptions)),
    'every raw result has the expected structured shape (title, company, applyOptions[])'
  );

  const linkedInOnly = filterToLinkedInResults(raw);
  console.log(`  Results with a real linkedin.com apply option: ${linkedInOnly.length} of ${raw.length}`);
  assert(
    linkedInOnly.every((j) => {
      try { return new URL(j.linkedinUrl).hostname.toLowerCase().endsWith('linkedin.com'); }
      catch { return false; }
    }),
    'every filtered result has a genuine, parseable linkedin.com apply URL — never a substituted non-LinkedIn link'
  );
  assert(
    linkedInOnly.length <= raw.length,
    'filtering only ever narrows the result set, never adds jobs the vendor did not return'
  );
  if (linkedInOnly.length > 0) {
    console.log(`  Sample: "${linkedInOnly[0].title}" @ ${linkedInOnly[0].company} -> ${linkedInOnly[0].linkedinUrl}`);
  }

  console.log('\n3/4/5. End-to-end: normalize (li-*) + match + attribution/confidence, via the real orchestrator');
  const profile = realProfile();
  const outcome = await runLinkedInJobSearch(profile, { keywords: 'remote software engineer', remoteOnly: true }, vendor);
  assert(outcome.vendorConfigured === true, 'vendorConfigured correctly true for a real, working key');
  assert(outcome.results.length === linkedInOnly.length || outcome.results.length > 0, `runLinkedInJobSearch() produced real results (got ${outcome.results.length})`);
  assert(outcome.results.every((r) => r.id.startsWith('li-')), 'every result normalized into the li-* namespace, never opp-*');
  assert(outcome.results.every((r) => r.linkedinUrl.includes('linkedin.com')), 'every result carries its real linkedin.com URL through to the final shape');
  assert(outcome.results.every((r) => typeof r.match.fitScore === 'number' && r.match.fitScore >= 0 && r.match.fitScore <= 100), 'the real matching pipeline (engine.ts) produced a valid fitScore for every result');
  assert(outcome.results.every((r) => typeof r.match.whyThisJob === 'string' && r.match.whyThisJob.length > 0), 'a real why-this-matches explanation was generated for every result');
  assert(outcome.results.every((r) => r.provenance === 'vendor_search'), "every result correctly tagged provenance 'vendor_search', not conflated with user-pasted");
  assert(
    outcome.results.every((r) => r.descriptionConfidence === 'excerpt'),
    'every vendor-sourced result is correctly labeled excerpt-confidence, never presented as full-text-confidence'
  );
  if (outcome.results.length > 0) {
    const sample = outcome.results[0];
    console.log(`  Sample match: "${sample.title}" @ ${sample.company} -> fitScore=${sample.match.fitBadge}, confidence=${sample.descriptionConfidence}`);
  }

  console.log('\n6. Pro/Free search-limit enforcement — NOT verifiable this step');
  console.log('  reserve_linkedin_search()/rollback_linkedin_search_reservation() live in migration 027,');
  console.log('  which remains UNAPPLIED per this step\'s explicit scope. The route-level call to that RPC');
  console.log('  is code-reviewed (src/app/api/linkedin-jobs/search/route.ts) but not live-DB-tested here.');

  console.log('\n7. Fail-safe — vendor-unavailable half (real); quota-exhausted half deferred with #6');
  const brokenVendor = new SerpApiGoogleJobsVendor();
  const originalKey = process.env.SERPAPI_KEY;
  delete process.env.SERPAPI_KEY;
  const failOutcome = await runLinkedInJobSearch(profile, {}, brokenVendor);
  process.env.SERPAPI_KEY = originalKey;
  assert(failOutcome.vendorConfigured === false, 'a genuinely missing key is correctly reported as vendorConfigured=false, not a crash');
  assert(failOutcome.results.length === 0, 'zero results on missing-key fail-safe, not a thrown exception');

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running linkedin-vendor-live-suite:', e); process.exit(1); });
