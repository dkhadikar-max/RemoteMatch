/**
 * Main feed matcher characterization baseline.
 * Run: npx tsx test/main-feed-characterization-suite.ts
 *
 * Golden output intentionally records the current matcher contract. Update
 * only through an explicit product decision when matching semantics change.
 */
import { PersonProfile, CanonicalOpportunity } from '../src/types/byn';
import { checkHardEligibility, computeScreeningFit, scoreOpportunitiesForFeed } from '../src/lib/matching/engine';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: string) {
  if (condition) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const now = '2026-11-01T00:00:00.000Z';
function profile(skills: string[], targetRoles: string[] = ['Frontend Engineer']): PersonProfile {
  return {
    id: 'golden-profile', email: 'golden@example.test', fullName: 'Golden Profile', planTier: 'free',
    dailyEvaluationsCount: 0, lastEvaluationResetAt: now, createdAt: now, updatedAt: now,
    intent: { id: 'intent', profileId: 'golden-profile', employmentTypes: ['Full-time'], targetRoles,
      yearsOfExperience: '4-6', minSalary: 0, preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: now },
    skills: skills.map((skillName, i) => ({ id: `skill-${i}`, profileId: 'golden-profile', skillName,
      yearsUsed: 4, isPrimary: true, evidenceLevel: 'strong' as const })),
    experiences: [],
    location: { id: 'location', profileId: 'golden-profile', currentCountry: 'India', currentTimezone: 'Asia/Kolkata',
      workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
  } as unknown as PersonProfile;
}
function job(id: string, title: string, requiredSkills: string[], remoteType: string = 'Worldwide'): CanonicalOpportunity {
  return {
    id, type: 'job', title, company: 'Golden Co', description: `${title}: ${requiredSkills.join(', ')}`,
    source: 'curated', sourceId: id, officialUrl: `https://example.test/${id}`, canonicalUrlHash: `h-${id}`,
    contentHash: `c-${id}`, employmentType: 'Full-time', remoteType, eligibleCountries: [], excludedCountries: [],
    timezoneRequirements: [], requiredSkills, preferredSkills: [], experienceRequirement: '4-6', qualityScore: 80,
    status: 'active', isActive: true, postedAt: now, lastVerifiedAt: now,
  } as unknown as CanonicalOpportunity;
}
function run() {
  console.log('MAIN FEED MATCHER CHARACTERIZATION');
  const candidate = profile(['React', 'TypeScript', 'Next.js']);
  const react = job('golden-react', 'Frontend Engineer', ['REACT', 'TypeScript', 'Next.js']);
  const partial = job('golden-partial', 'Frontend Engineer', ['React', 'Docker']);
  const backend = job('golden-backend', 'Backend Engineer', ['Python', 'Django']);
  const golden = scoreOpportunitiesForFeed(candidate, [partial, backend, react]);
  const actual = golden.map(({ id, fitScore }) => ({ id, fitScore }));
  const expected = [
    { id: 'golden-react', fitScore: 98 },
    { id: 'golden-partial', fitScore: 68 },
    { id: 'golden-backend', fitScore: 28 },
  ];
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'golden ordered IDs and scores match', JSON.stringify(actual));

  const tieA = job('tie-a', 'Frontend Engineer', []);
  const tieB = job('tie-b', 'Frontend Engineer', []);
  const tieC = job('tie-c', 'Frontend Engineer', []);
  const tied = scoreOpportunitiesForFeed(candidate, [tieB, tieC, tieA]);
  assert(tied.map((o) => o.id).join(',') === 'tie-b,tie-c,tie-a',
    'equal-score ranking preserves deterministic input/catalogue order');
  assert(tied.every((o) => o.fitScore === 50), 'tie fixtures have the same expected score');

  const genericRole = profile(['k8s', 'Node.js'], ['Software Engineer']);
  const aliasJob = job('alias-job', 'Software Engineer', ['Kubernetes', 'Node.js']);
  const aliasFit = computeScreeningFit(genericRole, aliasJob);
  assert(aliasFit.overlapSkills.includes('k8s') && aliasFit.overlapSkills.includes('Node.js'),
    'skill aliases and case-insensitive matching remain represented in the golden corpus');

  const indiaOnly = job('india-only', 'Frontend Engineer', ['React'], 'India');
  const usOnly = job('us-only', 'Frontend Engineer', ['React'], 'US');
  assert(checkHardEligibility(candidate, indiaOnly).isEligible, 'India-scoped opportunity is eligible for India profile');
  assert(!checkHardEligibility(candidate, usOnly).isEligible, 'US-scoped opportunity is ineligible for India profile');

  const contract = job('contract-job', 'Frontend Engineer', ['React']);
  contract.employmentType = 'Contract';
  assert(!checkHardEligibility(candidate, contract).employmentTypeCompatible,
    'employment-type mismatch remains ineligible');

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}
run();
