// ==============================================================================
// RemoteMatch End-to-End Verification Test Suite
// Testing the 10 Critical Product Invariants for Launch Readiness
// ==============================================================================

import {
  PersonProfile,
  CanonicalOpportunity,
  ApplicationStatus,
} from '../src/types/byn';
import {
  checkHardEligibility,
  computeScreeningFit,
  generateRuleBasedMatchAnalysis,
} from '../src/lib/matching/engine';
import {
  analyzeResumeHeuristically,
  generateJobSpecificResumeAnalysis,
} from '../src/lib/ai/resume-intelligence';
import {
  cleanOfficialUrl,
  createNormalizedJobKey,
  deduplicateOpportunities,
  normalizeOpportunity,
} from '../src/lib/ingestion/pipeline';
import { localStore, DEFAULT_DEMO_PROFILE } from '../src/lib/db/mock-seed';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failed++;
  }
}

async function runAllTests() {
  console.log('\n============================================================');
  console.log('REMOTEMATCH — COMPREHENSIVE VERIFICATION TEST SUITE');
  console.log('Testing 10 Core Product & Architectural Invariants');
  console.log('============================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: Resume → Onboarding Contradiction Detection
  // --------------------------------------------------------------------------
  console.log('TEST 1: Resume → Onboarding Contradiction Detection');
  const candidateWithUncertainty: PersonProfile = {
    ...DEFAULT_DEMO_PROFILE,
    skills: [
      { id: 's-react', profileId: 'u1', skillName: 'React', isPrimary: true },
      { id: 's-python', profileId: 'u1', skillName: 'Python', isPrimary: true }, // Not in resume!
    ],
  };

  const resumeWithoutPython = `Alex Chen - Senior Full Stack Engineer.
Worked with React, TypeScript, and Node.js to build scalable web applications.
Experienced in PostgreSQL and modern cloud deployment.`;

  const analysis = analyzeResumeHeuristically(candidateWithUncertainty, resumeWithoutPython);

  const pythonUncertainty = analysis.uncertainties.find((u) => u.skill.toLowerCase() === 'python');
  assert(
    Boolean(pythonUncertainty),
    'Detects claimed skill (Python) missing from resume text',
    'Uncertainty item should be generated'
  );
  assert(
    pythonUncertainty?.prompt.includes('Python') || false,
    'Uncertainty prompt explicitly asks user to clarify missing experience'
  );

  // --------------------------------------------------------------------------
  // TEST 2: Resolution & Persistence Behavior
  // --------------------------------------------------------------------------
  console.log('\nTEST 2: Resolution & Persistence Behavior');
  localStore.updateProfile({
    skills: [
      { id: 's-1', profileId: 'u1', skillName: 'React', isPrimary: true, evidenceLevel: 'strong' },
      { id: 's-2', profileId: 'u1', skillName: 'Python', isPrimary: true, evidenceLevel: 'strong', whereUsed: 'Production data pipeline' },
    ],
  });

  const updatedProfile = localStore.getProfile();
  const pythonSkill = updatedProfile.skills.find((s) => s.skillName === 'Python');
  assert(
    pythonSkill?.evidenceLevel === 'strong' && pythonSkill?.whereUsed === 'Production data pipeline',
    'Resolved uncertainty is stored with evidenceLevel and whereUsed context'
  );

  // --------------------------------------------------------------------------
  // TEST 3: No Hallucination Invariant
  // --------------------------------------------------------------------------
  console.log('\nTEST 3: No Hallucination Invariant');
  const sparseResume = `Alex Chen. Software Developer.
Worked on web development and fixed bugs for client applications.`;
  const sparseAnalysis = analyzeResumeHeuristically(DEFAULT_DEMO_PROFILE, sparseResume);

  // Check impact feedback
  const impactFeedback = sparseAnalysis.dimensions.impact.feedback;
  assert(
    impactFeedback.includes('measurable') || sparseAnalysis.improvementAreas.some((i) => i.action.includes('quantifiable') || i.action.includes('metric')),
    'Advises candidate to add measurable outcomes rather than hallucinating fake % metrics'
  );
  assert(
    !sparseAnalysis.strongAreas.some((a) => /\d{2}%/.test(a)),
    'Does not invent fake percentages in strong areas'
  );

  // --------------------------------------------------------------------------
  // TEST 4: 5-Dimension Profile Strength Calculation
  // --------------------------------------------------------------------------
  console.log('\nTEST 4: 5-Dimension Profile Strength Calculation');
  assert(
    typeof sparseAnalysis.dimensions.relevance.score === 'number' &&
    typeof sparseAnalysis.dimensions.evidence.score === 'number' &&
    typeof sparseAnalysis.dimensions.impact.score === 'number' &&
    typeof sparseAnalysis.dimensions.atsReadability.score === 'number' &&
    typeof sparseAnalysis.dimensions.targetAlignment.score === 'number',
    'All 5 readiness dimensions evaluated independently'
  );

  // Verify sparse resume receives appropriate impact score (not false 95)
  assert(
    sparseAnalysis.dimensions.impact.score <= 60,
    'Sparse resume without metrics does not receive falsely inflated impact score'
  );

  // --------------------------------------------------------------------------
  // TEST 5: Hard Eligibility Gate Correctness
  // --------------------------------------------------------------------------
  console.log('\nTEST 5: Hard Eligibility Gate Correctness');
  const indiaCandidate: PersonProfile = {
    ...DEFAULT_DEMO_PROFILE,
    location: {
      id: 'loc-in',
      profileId: 'u1',
      currentCountry: 'India',
      currentTimezone: 'IST',
      workPreference: 'worldwide',
      allowedCountries: ['India'],
      willingTimezones: ['IST', 'UTC'],
    },
    intent: {
      id: 'intent-in',
      profileId: 'u1',
      employmentTypes: ['Full-time'],
      targetRoles: ['Software Engineer'],
      yearsOfExperience: '4-6',
      preferredCurrency: 'USD',
      availabilityStatus: 'immediately',
      updatedAt: new Date().toISOString(),
    },
  };

  const jobWorldwide: CanonicalOpportunity = {
    ...localStore.getOpportunities()[0],
    remoteType: 'Worldwide',
    eligibleCountries: [],
  };

  const jobUsOnly: CanonicalOpportunity = {
    ...localStore.getOpportunities()[0],
    title: 'Senior Software Engineer (US Only)',
    remoteType: 'US',
    eligibleCountries: ['US'],
  };

  const gateWorldwide = checkHardEligibility(indiaCandidate, jobWorldwide);
  const gateUsOnly = checkHardEligibility(indiaCandidate, jobUsOnly);

  assert(gateWorldwide.isEligible === true, 'India candidate is eligible for Worldwide remote opportunity');
  assert(gateUsOnly.isEligible === false, 'India candidate is BLOCKED by hard gate for US-only opportunity');
  assert(
    gateUsOnly.countryEligible === false && Boolean(gateUsOnly.ineligibilityReason),
    'Hard gate produces clear ineligibility reason (US residency required)'
  );

  // Fit score for blocked job must be demoted / low fit
  const fitUsOnly = computeScreeningFit(indiaCandidate, jobUsOnly);
  assert(
    fitUsOnly.fitScore < 40 && fitUsOnly.fitBadge === 'Low Fit',
    'Ineligible job is demoted to Low Fit (<40%), NEVER showing a false 90%+ badge'
  );

  // --------------------------------------------------------------------------
  // TEST 6: Fit Score Correctness (High vs Low Fit)
  // --------------------------------------------------------------------------
  console.log('\nTEST 6: Fit Score Correctness');
  const matchingJob: CanonicalOpportunity = {
    ...jobWorldwide,
    title: 'Senior Full Stack Engineer',
    requiredSkills: ['React', 'TypeScript', 'Node.js', 'PostgreSQL'],
    experienceRequirement: '4-6',
  };

  const unrelatedJob: CanonicalOpportunity = {
    ...jobWorldwide,
    title: 'Chief Financial Officer (CFO)',
    requiredSkills: ['Financial Auditing', 'GAAP', 'Tax Compliance', 'Treasury'],
    experienceRequirement: '10+',
  };

  const highFitResult = computeScreeningFit(indiaCandidate, matchingJob);
  const lowFitResult = computeScreeningFit(indiaCandidate, unrelatedJob);

  assert(highFitResult.fitScore >= 80, `Matching job receives High Fit score (got ${highFitResult.fitScore}%)`);
  assert(lowFitResult.fitScore < 60, `Unrelated job receives Low/Moderate Fit score (got ${lowFitResult.fitScore}%)`);

  // --------------------------------------------------------------------------
  // TEST 7: 4-Layer Deduplication System
  // --------------------------------------------------------------------------
  console.log('\nTEST 7: 4-Layer Deduplication System');
  const rawBase = {
    sourceId: 'job-100',
    source: 'remotive' as const,
    title: 'Senior Product Designer',
    company: 'Figma',
    description: 'We are hiring a product designer to craft developer tools and UI systems.',
    sourceUrl: 'https://remotive.com/jobs/100',
    officialUrl: 'https://figma.com/careers/designer?utm_source=remotive&utm_campaign=remote_jobs&ref=aggregator',
    jobType: 'Full-time',
    publicationDate: new Date().toISOString(),
  };

  // 4 variants of the same job
  const job1 = normalizeOpportunity(rawBase);
  const job2 = normalizeOpportunity({
    ...rawBase,
    source: 'arbeitnow' as const,
    sourceId: 'arbeit-999', // Different source ID
    officialUrl: 'https://figma.com/careers/designer?utm_source=arbeitnow&ref=tracking', // Same canonical URL
  });
  const job3 = normalizeOpportunity({
    ...rawBase,
    source: 'curated' as const,
    sourceId: 'curated-555',
    title: 'Senior Product Designer ', // Slight whitespace variant
    officialUrl: 'https://figma.com/careers/designer',
  });
  const job4 = normalizeOpportunity({
    ...rawBase,
    source: 'jobicy' as const,
    sourceId: 'jobicy-444',
    title: 'Product Designer (Senior)',
    officialUrl: 'https://figma.com/apply/designer-alternate',
    description: 'We are hiring a product designer to craft developer tools and UI systems.', // Same description hash
  });

  const deduped = deduplicateOpportunities([job1, job2, job3, job4]);
  assert(
    deduped.length === 1,
    `4 duplicate variants correctly collapsed to exactly 1 canonical opportunity (got ${deduped.length})`
  );

  // --------------------------------------------------------------------------
  // TEST 8: Official Application URL Integrity
  // --------------------------------------------------------------------------
  console.log('\nTEST 8: Official Application URL Integrity');
  const dirtyUrl = 'https://jobs.lever.co/company/abc-123?utm_source=jobboard&utm_medium=cpc&ref=aggregator&source=remote';
  const cleanUrl = cleanOfficialUrl(dirtyUrl);
  assert(
    cleanUrl === 'https://jobs.lever.co/company/abc-123',
    'Tracking and UTM parameters cleanly stripped from official apply URL'
  );
  assert(
    deduped[0].officialUrl.startsWith('https://figma.com/careers/designer'),
    'Canonical opportunity officialUrl points directly to destination'
  );

  // --------------------------------------------------------------------------
  // TEST 9: Server Quota & AI Cost Control
  //
  // (Formerly also included a TEST 9 "Outcome Loop & State Transitions" here,
  // exercising localStore.saveApplication/recordFeedback/updateApplicationStatus
  // in-process. That functionality was intentionally moved server-side by the
  // outcome-lifecycle migration — see supabase/migrations/006_outcome_lifecycle.sql
  // and test/outcome-lifecycle-suite.ts, which tests the real thing over HTTP
  // against a verified session, the way security-remediation-suite.ts and
  // auth-invariant-suite.ts already do for their respective surfaces. An
  // in-process localStore test of that surface would now just be testing
  // dead code.)
  // --------------------------------------------------------------------------
  console.log('\nTEST 9: Server Quota & AI Cost Control');
  const currentCount = localStore.getProfile().dailyEvaluationsCount;
  localStore.recordSwipe('opp-quota-test', 'passed');
  const nextCount = localStore.getProfile().dailyEvaluationsCount;
  assert(
    nextCount === currentCount + 1,
    `One evaluated opportunity consumes exactly one quota credit (${currentCount} -> ${nextCount})`
  );

  // Rewind restores credit
  localStore.rewindLastSwipe();
  const rewoundCount = localStore.getProfile().dailyEvaluationsCount;
  assert(
    rewoundCount === currentCount,
    `Rewinding restores the consumed evaluation credit (${nextCount} -> ${rewoundCount})`
  );

  // Job-specific resume analysis verification
  const jobSpecific = generateJobSpecificResumeAnalysis(DEFAULT_DEMO_PROFILE, matchingJob);
  assert(
    jobSpecific.length === 3,
    `Generates exactly 3 concrete job-specific resume improvements (got ${jobSpecific.length})`
  );

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n============================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test suite runtime error:', err);
  process.exit(1);
});
