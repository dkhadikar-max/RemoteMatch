/**
 * Main feed matcher characterization baseline.
 * Run: npx tsx test/main-feed-characterization-suite.ts
 *
 * Golden output intentionally records the current matcher contract. Update
 * only through an explicit product decision when matching semantics change.
 */
import { PersonProfile, CanonicalOpportunity } from '../src/types/byn';
import { checkHardEligibility, computeScreeningFit, scoreOpportunitiesForFeed } from '../src/lib/matching/engine';
import { filterAmbiguousTitleTags } from '../src/lib/matching/ambiguous-title-tags';

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

  // Taxonomy collision fixtures: denylisted sales-title fragments must not
  // erase genuine accounting, technical-account, or technical-skill tags.
  const taxonomy = filterAmbiguousTitleTags([
    'Account-Executive', 'Senior-Strategic-Account-Executive',
    'Accounts-Receivable-Manager', 'Technical-Account-Manager',
    'Account-Based-Marketing-Manager', 'Senior-Python-Engineer',
  ]);
  assert(taxonomy.join('|') === [
    'Accounts-Receivable-Manager', 'Technical-Account-Manager',
    'Account-Based-Marketing-Manager', 'Senior-Python-Engineer',
  ].join('|'), 'ambiguous account-title tags are removed while finance, TAM, ABM and technical skill tags survive');

  // Remote-scope characterization for every currently declared RemoteType.
  const remoteCases: Array<[string, boolean]> = [
    ['Worldwide', true], ['India', true], ['US', false], ['EU/EEA', false],
    // These scopes have no additional country rule in the current matcher;
    // this records the existing contract, not a product-policy endorsement.
    ['Specific countries', true], ['Regional', true],
    ['Timezone restricted', true], ['Contractor only', true],
  ];
  for (const [scope, expectedEligible] of remoteCases) {
    const result = checkHardEligibility(candidate, job(`remote-${scope}`, 'Frontend Engineer', ['React'], scope));
    assert(result.isEligible === expectedEligible, `remote scope ${scope} eligibility remains characterized`,
      `expected ${expectedEligible}, got ${result.isEligible}`);
  }

  // Null/default behavior: absent optional intent/location and job metadata
  // uses the matcher defaults (Worldwide candidate, Full-time, 2-3 years).
  const defaultsProfile = {
    ...candidate, intent: undefined, location: undefined,
  } as unknown as PersonProfile;
  const defaultsJob = {
    ...job('defaults', 'General Role', []),
    remoteType: 'Worldwide', employmentType: undefined, experienceRequirement: undefined,
  } as unknown as CanonicalOpportunity;
  const defaultsGate = checkHardEligibility(defaultsProfile, defaultsJob);
  assert(defaultsGate.isEligible && defaultsGate.countryEligible && defaultsGate.employmentTypeCompatible,
    'missing profile intent/location and missing job employment/experience fields use safe matcher defaults');

  // Supersession is a retrieval concern, not a matcher concern. The engine
  // deliberately scores the supplied row; feed retrieval owns filtering it.
  const superseded = {
    ...job('superseded-row', 'Frontend Engineer', ['React']),
    supersededByOpportunityId: 'survivor-row',
  } as CanonicalOpportunity;
  assert(scoreOpportunitiesForFeed(candidate, [superseded]).some((o) => o.id === 'superseded-row'),
    'matcher scores supplied superseded rows; caller owns discoverability filtering');

  // Generic and specific target roles are both represented in a mixed intent.
  const mixedRoleProfile = profile(['React'], ['Software Engineer', 'Frontend Engineer']);
  const frontendSpecific = job('frontend-specific', 'Frontend Engineer', []);
  const unrelatedRole = job('unrelated-role', 'Finance Manager', ['Excel']);
  assert(checkHardEligibility(mixedRoleProfile, frontendSpecific).roleRelevant,
    'a specific target role matches its corresponding title');
  assert(!checkHardEligibility(mixedRoleProfile, unrelatedRole).roleRelevant,
    'generic target role does not admit an unrelated role without skill overlap');

  console.log(`\\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}
run();
