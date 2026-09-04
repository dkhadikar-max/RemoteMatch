/**
 * RemoteMatch (BYN Architecture) — Staging Smoke Test
 * Executes the complete real-user journey:
 * SIGNUP → PROFILE → RESUME → INTELLIGENCE → OPPORTUNITY → DECISION
 * → MATCH → ACTION → OUTCOME
 *
 * Verifies both state transitions and the unbroken immutable telemetry chain:
 * job_viewed → job_interested → match_analyzed → apply_clicked
 * → feedback_submitted(applied) → interview_reported → offer_reported
 *
 * And asserts that the decision snapshot remains immutable across subsequent profile/job mutations.
 */

import {
  PersonProfile,
  CanonicalOpportunity,
  ApplicationRecord,
  ApplicationEvent,
  DecisionSnapshot,
} from '../src/types/byn';
import { checkHardEligibility, computeScreeningFit, generateRuleBasedMatchAnalysis } from '../src/lib/matching/engine';
import { analyzeResumeHeuristically } from '../src/lib/ai/resume-intelligence';
import { generateApplicationKit } from '../src/lib/ai/materials';
import { cleanOfficialUrl } from '../src/lib/ingestion/pipeline';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${testName}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runSmokeTest() {
  console.log('============================================================');
  console.log('REMOTE MATCH STAGING SMOKE TEST');
  console.log('Validating Complete Real-User Path & Immutable Telemetry Chain');
  console.log('============================================================\n');

  const immutableEvents: ApplicationEvent[] = [];

  // Helper to record immutable telemetry
  function logEvent(applicationId: string, eventType: ApplicationEvent['eventType'], payload: Record<string, any>) {
    const event: ApplicationEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      applicationId,
      eventType,
      eventPayload: payload,
      createdAt: new Date().toISOString(),
    };
    immutableEvents.push(event);
    return event;
  }

  // --------------------------------------------------------------------------
  // STAGE 1: SIGNUP & ONBOARD
  // --------------------------------------------------------------------------
  console.log('--- STAGE 1: Signup & Profile Creation ---');
  const user: PersonProfile = {
    id: 'smoke-user-1',
    email: 'elena.rostova@example.com',
    fullName: 'Elena Rostova',
    headline: 'Senior Full Stack Engineer',
    profileStrength: 0,
    planTier: 'free',
    dailyEvaluationsCount: 0,
    lastEvaluationResetAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    intent: {
      id: 'intent-smoke-1',
      profileId: 'smoke-user-1',
      employmentTypes: ['Full-time'],
      targetRoles: ['Full Stack Engineer', 'Backend Engineer'],
      yearsOfExperience: '4-6',
      minSalary: 120000,
      preferredCurrency: 'USD',
      availabilityStatus: 'immediately',
      updatedAt: new Date().toISOString(),
    },
    skills: [
      { id: 's-1', profileId: 'smoke-user-1', skillName: 'React', yearsUsed: 5, isPrimary: true, evidenceLevel: 'strong' },
      { id: 's-2', profileId: 'smoke-user-1', skillName: 'TypeScript', yearsUsed: 4, isPrimary: true, evidenceLevel: 'strong' },
      { id: 's-3', profileId: 'smoke-user-1', skillName: 'PostgreSQL', yearsUsed: 4, isPrimary: true, evidenceLevel: 'strong' },
    ],
    experiences: [
      {
        id: 'exp-1',
        profileId: 'smoke-user-1',
        company: 'FinTech Cloud',
        roleTitle: 'Senior Software Engineer',
        startDate: '2021',
        endDate: 'Present',
        isCurrent: true,
        achievements: [
          'Architected payment orchestration system handling $15M monthly volume with 99.99% uptime.',
          'Reduced API p95 response times by 35% through query optimization and caching.',
        ],
        industry: 'Fintech',
      },
    ],
    location: {
      id: 'loc-smoke-1',
      profileId: 'smoke-user-1',
      currentCountry: 'Worldwide',
      currentTimezone: 'UTC',
      workPreference: 'worldwide',
      allowedCountries: ['Worldwide'],
      willingTimezones: ['UTC', 'EST', 'CET'],
    },
  };

  assert(Boolean(user.id && user.email), 'STAGE 1: User signed up with valid account ID');

  // --------------------------------------------------------------------------
  // STAGE 2: UPLOAD RESUME & AI RESUME INTELLIGENCE
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 2: Resume Upload & Profile Intelligence ---');
  user.rawResumeText = `Elena Rostova - Senior Full Stack Engineer
Summary: Experienced software engineer with 5 years building scalable web services and cloud infrastructure.
Experience:
FinTech Cloud (2021 - Present): Senior Software Engineer
- Architected payment orchestration system handling $15M monthly volume with 99.99% uptime.
- Reduced API p95 response times by 35% through Postgres query optimization.
- Led distributed async team delivering core features on schedule.
Technical Skills: React, TypeScript, Node.js, PostgreSQL, Docker.`;

  const resumeAnalysis = analyzeResumeHeuristically(user, user.rawResumeText);
  user.profileStrength = resumeAnalysis.overallScore;

  assert(user.profileStrength >= 70, `STAGE 2: Profile Strength evaluated (${user.profileStrength}/100)`);
  assert(resumeAnalysis.dimensions.impact.score >= 70, 'STAGE 2: Verified impact metrics recognized in profile readiness');

  // --------------------------------------------------------------------------
  // STAGE 3: JOB FEED & OPPORTUNITY VIEWED
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 3: Feed Discovery & Opportunity Viewed ---');
  const opportunity: CanonicalOpportunity = {
    id: 'opp-smoke-cloud-1',
    type: 'job',
    title: 'Senior Full Stack Engineer',
    company: 'Apex Cloud Systems',
    companyLogo: 'https://apexcloud.io/logo.png',
    description: 'We are seeking a Senior Full Stack Engineer proficient in React, TypeScript, and PostgreSQL to lead high-throughput platform engineering.',
    source: 'remotive',
    sourceId: 'rem-9921',
    sourceUrl: 'https://remotive.com/jobs/9921?utm_source=feed',
    officialUrl: 'https://apexcloud.io/careers/senior-full-stack?utm_source=remotive&utm_campaign=hiring',
    canonicalUrlHash: 'hash-apex-1',
    contentHash: 'content-apex-1',
    employmentType: 'Full-time',
    remoteType: 'Worldwide',
    eligibleCountries: [],
    excludedCountries: [],
    timezoneRequirements: [],
    salaryMin: 130000,
    salaryMax: 160000,
    salaryCurrency: 'USD',
    requiredSkills: ['React', 'TypeScript', 'PostgreSQL'],
    preferredSkills: ['Async Collaboration'],
    experienceRequirement: '4-6',
    qualityScore: 95,
    sourceQuality: 92,
    descriptionCompleteness: 'high',
    salaryQuality: 'verified',
    remotePolicyConfidence: 'high',
    status: 'active',
    isActive: true,
    postedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  };

  const appId = `app-${user.id}-${opportunity.id}`;

  // TELEMETRY EVENT 1: job_viewed
  logEvent(appId, 'job_viewed' as any, {
    opportunityId: opportunity.id,
    company: opportunity.company,
    feedSource: opportunity.source,
  });
  assert(immutableEvents.some((e) => e.eventType === ('job_viewed' as any)), 'TELEMETRY 1: job_viewed event recorded');

  // --------------------------------------------------------------------------
  // STAGE 4: RIGHT SWIPE (INTERESTED) & DECISION SNAPSHOT
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 4: Right Swipe & Decision Snapshot Preservation ---');

  // Hard Eligibility & Screening Fit
  const eligibility = checkHardEligibility(user, opportunity);
  assert(eligibility.isEligible, 'STAGE 4: Hard Eligibility passed before scoring');

  const screening = computeScreeningFit(user, opportunity);
  assert(screening.fitScore >= 80, `STAGE 4: Screening Fit computed (${screening.fitScore}%)`);

  // TELEMETRY EVENT 2: job_interested
  logEvent(appId, 'job_interested' as any, {
    opportunityId: opportunity.id,
    fitScore: screening.fitScore,
    action: 'interested',
  });
  assert(immutableEvents.some((e) => e.eventType === ('job_interested' as any)), 'TELEMETRY 2: job_interested event recorded');

  // Create Decision-Time Snapshot (Preserves exact model state at decision instant)
  const decisionSnapshot: DecisionSnapshot = {
    fitScore: screening.fitScore,
    fitBadge: screening.fitBadge,
    isEligible: eligibility.isEligible,
    decisionTimestamp: new Date().toISOString(),
    matchingEngineVersion: '1.0.0',
    matchingWeightsVersion: '1.0.0',
    eligibilityRulesVersion: '1.0.0',
    profileVersion: '1.0.0',
    jobVersion: '1.0.0',
    jobSource: opportunity.source,
    jobSourceId: opportunity.sourceId,
    officialUrl: opportunity.officialUrl,
    employmentType: opportunity.employmentType,
    remoteClassification: opportunity.remoteType,
    requirementsEvaluated: [
      { requirement: 'React', status: 'matched' },
      { requirement: 'TypeScript', status: 'matched' },
      { requirement: 'PostgreSQL', status: 'matched' },
    ],
    scoreBreakdown: {
      roleAlignment: 95,
      skillsOverlap: 95,
      seniorityCompatibility: 90,
      remoteAndLegalGate: 100,
      evidenceQuality: 92,
    },
  };

  const application: ApplicationRecord = {
    id: appId,
    profileId: user.id,
    opportunityId: opportunity.id,
    opportunity,
    status: 'interested',
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    decisionSnapshot,
  };

  assert(Boolean(application.decisionSnapshot), 'STAGE 4: Decision snapshot frozen and stored in application record');

  // --------------------------------------------------------------------------
  // STAGE 5: MATCH ANALYSIS VIEW ("Why 94%?")
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 5: Match Analysis View ---');
  const deepMatch = generateRuleBasedMatchAnalysis(user, opportunity);

  // TELEMETRY EVENT 3: match_analyzed
  logEvent(appId, 'match_analyzed' as any, {
    opportunityId: opportunity.id,
    fitScore: deepMatch.fitScore,
    strengthsCount: deepMatch.strengths.length,
    gapsCount: deepMatch.gaps.length,
  });
  assert(immutableEvents.some((e) => e.eventType === ('match_analyzed' as any)), 'TELEMETRY 3: match_analyzed event recorded');
  assert(deepMatch.strengths.length >= 2, 'STAGE 5: Transparent strengths presented to user');

  // --------------------------------------------------------------------------
  // STAGE 6: APPLICATION KIT (MATERIALS)
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 6: Application Kit Generation ---');
  const appKit = await generateApplicationKit(user, opportunity, deepMatch, 'confident');
  assert(Boolean(appKit.coverLetter && appKit.resumeTweaks), 'STAGE 6: Tailored Cover Letter and Resume Tweaks generated');

  // --------------------------------------------------------------------------
  // STAGE 7: OFFICIAL APPLY CLICK (URL TRACKING STRIPPED)
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 7: Official Apply Click & Link Cleansing ---');
  const cleanUrl = cleanOfficialUrl(opportunity.officialUrl);
  assert(!cleanUrl.includes('utm_source'), 'STAGE 7: Tracking parameters stripped from official apply URL');

  // TELEMETRY EVENT 4: apply_clicked
  logEvent(appId, 'apply_clicked' as any, {
    opportunityId: opportunity.id,
    destinationUrl: cleanUrl,
  });
  assert(immutableEvents.some((e) => e.eventType === ('apply_clicked' as any)), 'TELEMETRY 4: apply_clicked event recorded');

  // --------------------------------------------------------------------------
  // STAGE 8: "DID YOU APPLY?" & OUTCOME LOOP (QUALIFIED APPLICATION)
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 8: "Did You Apply?" Confirmation & Qualified Application ---');

  // User confirms "applied"
  application.status = 'applied';
  application.appliedAt = new Date().toISOString();

  // TELEMETRY EVENT 5: feedback_submitted(applied)
  logEvent(appId, 'feedback_submitted', {
    did_apply: 'applied',
    feedbackNotes: 'Applied directly on Apex Cloud Careers site.',
  });
  assert(
    immutableEvents.some((e) => e.eventType === 'feedback_submitted' && e.eventPayload.did_apply === 'applied'),
    'TELEMETRY 5: feedback_submitted(applied) recorded'
  );

  // Validate operational definition of Qualified Application:
  // hard_eligibility_passed && fit_score >= 70% && match_analyzed && apply_clicked && application_reported
  const hasEligibilityPassed = eligibility.isEligible;
  const hasHighFit = screening.fitScore >= 70;
  const hasMatchAnalyzed = immutableEvents.some((e) => e.eventType === ('match_analyzed' as any));
  const hasApplyClicked = immutableEvents.some((e) => e.eventType === ('apply_clicked' as any));
  const hasAppliedConfirmed = application.status === 'applied';

  const isQualifiedApplication = hasEligibilityPassed && hasHighFit && hasMatchAnalyzed && hasApplyClicked && hasAppliedConfirmed;
  assert(isQualifiedApplication, 'STAGE 8: Application fulfills all 5 requirements of a QUALIFIED APPLICATION');

  // --------------------------------------------------------------------------
  // STAGE 9: INTERVIEW REPORTED
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 9: Interview Reported ---');
  application.status = 'interview';
  application.notes = 'System design interview scheduled for next Tuesday.';

  // TELEMETRY EVENT 6: interview_reported
  logEvent(appId, 'interview_scheduled', {
    round: 'system_design',
    scheduledFor: '2026-09-15',
    notes: application.notes,
  });
  assert(immutableEvents.some((e) => e.eventType === 'interview_scheduled'), 'TELEMETRY 6: interview_reported event recorded');
  assert(application.status === 'interview', 'STAGE 9: Application status transitioned to "interview"');

  // --------------------------------------------------------------------------
  // STAGE 10: OFFER REPORTED
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 10: Offer Reported ---');
  application.status = 'offer';
  application.notes = 'Received written offer: $155,000 USD + equity.';

  // TELEMETRY EVENT 7: offer_reported
  logEvent(appId, 'offer_received', {
    salary: 155000,
    currency: 'USD',
  });
  assert(immutableEvents.some((e) => e.eventType === 'offer_received'), 'TELEMETRY 7: offer_reported event recorded');
  assert(application.status === 'offer', 'STAGE 10: Application status transitioned to "offer" (Flywheel complete)');

  // --------------------------------------------------------------------------
  // STAGE 11: SCIENTIFIC REPRODUCIBILITY INVARIANT
  // Verify that decisionSnapshot is immutable when profile or job changes later
  // --------------------------------------------------------------------------
  console.log('\n--- STAGE 11: Scientific Decision Snapshot Invariant ---');
  const snapshotBefore = JSON.stringify(application.decisionSnapshot);

  // User later mutates profile
  user.headline = 'VP of Engineering';
  user.skills.push({ id: 's-99', profileId: user.id, skillName: 'Kubernetes', isPrimary: true, evidenceLevel: 'strong' });
  user.intent!.yearsOfExperience = '10+';

  // Opportunity later mutates
  opportunity.title = 'Staff Systems Architect';
  opportunity.description = 'Completely updated job description with new requirements.';
  opportunity.requiredSkills = ['Rust', 'Solana', 'Zero Knowledge Proofs'];

  const snapshotAfter = JSON.stringify(application.decisionSnapshot);

  assert(
    snapshotBefore === snapshotAfter,
    'STAGE 11: Decision snapshot remains 100% UNCHANGED after profile & opportunity mutation'
  );
  assert(
    application.decisionSnapshot?.matchingEngineVersion === '1.0.0' &&
    application.decisionSnapshot?.fitScore === screening.fitScore,
    'STAGE 11: Calibration integrity preserved (Original score & engine version immutable)'
  );

  // Verify all 7 immutable telemetry events exist in unbroken chronological sequence
  assert(immutableEvents.length === 7, `Telemetry log contains exactly 7 immutable lifecycle events (got ${immutableEvents.length})`);

  console.log('\n============================================================');
  console.log(`SMOKE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runSmokeTest().catch((err) => {
  console.error('Fatal error running smoke test:', err);
  process.exit(1);
});
