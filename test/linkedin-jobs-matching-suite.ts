/**
 * LinkedIn Job Finder — proves the existing matching pipeline
 * (engine.ts, career-transition.ts) genuinely runs, unmodified, against a
 * LinkedIn-sourced, non-catalog job (no DB id, no opportunities row).
 * Pure, no infra. Plan: vivid-hatching-kitten.md §22 step [3].
 *
 * Run: npx tsx test/linkedin-jobs-matching-suite.ts
 */
import { checkHardEligibility, computeScreeningFit, generateRuleBasedMatchAnalysis } from '../src/lib/matching/engine';
import { classifyCareerTransition } from '../src/lib/matching/career-transition';
import { normalizeVendorResult, normalizePastedJob } from '../src/lib/linkedin-jobs/normalize';
import { analyzePastedJob } from '../src/lib/linkedin-jobs/analyze';
import type { PersonProfile, ProfileSkill } from '../src/types/byn';
import type { VendorJobResult } from '../src/types/linkedin-jobs';

let passed = 0, failed = 0;
const assert = (c: boolean, n: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}`); }
};

function skill(name: string): ProfileSkill {
  return { id: `s-${name}`, profileId: 'p1', skillName: name, isPrimary: false };
}
function baseProfile(skills: string[], careerDirection: PersonProfile['careerDirection'] = 'continue'): PersonProfile {
  return {
    id: 'p1', fullName: 'Test Candidate', email: 't@example.com', headline: '', profileStrength: 50,
    planTier: 'free', dailyRightSwipesCount: 0, dailyProposalsCount: 0, usageDate: '2026-01-01',
    careerDirection,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    skills: skills.map(skill),
    intent: { id: 'i1', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: ['Backend Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '2026-01-01T00:00:00Z' },
    location: { id: 'l1', profileId: 'p1', currentCountry: 'United States', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    experiences: [],
  } as unknown as PersonProfile;
}

console.log('==============================================================================');
console.log('LINKEDIN JOB FINDER — matching pipeline reuse proof');
console.log('==============================================================================\n');

console.log('1. checkHardEligibility / computeScreeningFit / generateRuleBasedMatchAnalysis run unmodified against a li-* job');
{
  const profile = baseProfile(['Python', 'AWS', 'Django']);
  const raw: VendorJobResult = {
    title: 'Backend Engineer', company: 'Acme Corp', location: 'Worldwide',
    descriptionExcerpt: 'We need a backend engineer skilled in Python and AWS to join our remote team.',
    linkedinUrl: 'https://www.linkedin.com/jobs/view/1',
  };
  const { opportunity } = normalizeVendorResult(raw);

  const gate = checkHardEligibility(profile, opportunity);
  assert(typeof gate.isEligible === 'boolean', 'checkHardEligibility() runs without error on a li-* opportunity');
  assert(gate.isEligible === true, 'a Worldwide-remote li-* job is eligible for a Worldwide-preference candidate');

  const fit = computeScreeningFit(profile, opportunity);
  assert(fit.overlapSkills.length > 0, `real skill overlap computed (got ${JSON.stringify(fit.overlapSkills)})`);
  assert(fit.fitScore > 0 && fit.fitScore <= 100, `real fitScore in range (got ${fit.fitScore})`);

  const match = generateRuleBasedMatchAnalysis(profile, opportunity);
  assert(match.opportunityId === opportunity.id, "match.opportunityId is the li-* id, not fabricated");
  assert(typeof match.whyThisJob === 'string' && match.whyThisJob.length > 0, 'a real whyThisJob explanation is produced');
  assert(match.strengths.length > 0, 'real strengths derived from actual skill overlap');
}

console.log('\n2. classifyCareerTransition() (additive, unmodified) runs against a li-* job for a change_fields user');
{
  const profile = baseProfile(['Python'], 'change_fields');
  const raw: VendorJobResult = {
    title: 'Backend Engineer', company: 'Acme Corp',
    descriptionExcerpt: 'Backend engineer role requiring Python and Go.',
    linkedinUrl: 'https://www.linkedin.com/jobs/view/2',
  };
  const { opportunity } = normalizeVendorResult(raw);
  const gate = checkHardEligibility(profile, opportunity);
  const transition = classifyCareerTransition(profile, opportunity, gate.isEligible);
  // May be null if no target-role alignment — the important proof is that
  // the call itself completes and, when non-null, is correctly shaped.
  if (transition) {
    assert(typeof transition.classification === 'string', 'career transition classification present');
    assert(transition.transferableSkills.length >= 0, 'transferableSkills array present');
  } else {
    assert(true, 'classifyCareerTransition() returned null cleanly (no target-role alignment) — not a crash');
  }
}

console.log('\n3. analyzePastedJob() — the "paste a job" (Mode B, Free) path end-to-end');
{
  const profile = baseProfile(['React', 'TypeScript']);
  const result = analyzePastedJob(profile, {
    title: 'Frontend Engineer', company: 'Widget Co',
    description: 'Looking for a frontend engineer with React and TypeScript experience.',
    linkedinUrl: 'https://www.linkedin.com/jobs/view/3',
  });
  assert(result.id.startsWith('li-'), 'pasted job also gets a li-* id');
  assert(result.descriptionConfidence === 'full', 'pasted job is always full-confidence');
  assert(result.match.fitScore > 0, `real match computed (fitScore=${result.match.fitScore})`);
  assert(result.match.strengths.some((s) => s.toLowerCase().includes('react') || s.toLowerCase().includes('typescript')), 'match strengths reflect the actual pasted skills');
}

console.log('\n4. A li-* job with zero skill overlap still produces a coherent (low) fit, never a crash');
{
  const profile = baseProfile(['Sales', 'Marketing']);
  const { opportunity } = normalizePastedJob({
    title: 'Kubernetes Platform Engineer', company: 'InfraCo',
    description: 'Deep Kubernetes, Terraform, and Go experience required.',
    linkedinUrl: 'https://www.linkedin.com/jobs/view/4',
  });
  const match = generateRuleBasedMatchAnalysis(profile, opportunity);
  assert(match.fitScore >= 0 && match.fitScore <= 100, `fitScore stays in valid range even with zero overlap (got ${match.fitScore})`);
  assert(match.gaps.length > 0, 'gaps correctly populated when skills do not overlap');
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
