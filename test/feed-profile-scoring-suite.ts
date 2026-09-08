/**
 * RemoteMatch — Feed profile-scoring regression (Live Supply Activation blocker 1)
 * ==============================================================================
 * When /feed scoring moved server-side (Live Supply Activation), the feed
 * route scored every caller against `localStore.getProfile()` — a module
 * singleton that is ALWAYS the "Alex Chen" demo fixture on the server. So
 * User A and User B got an identical feed ranking regardless of their real
 * profiles.
 *
 * Fix: the route no longer touches localStore. GET returns the unscored
 * catalog; POST scores against the profile in the request body (the client
 * sends the one it loaded via loadProfile()). computeScreeningFit is
 * UNCHANGED — a thin scoreOpportunitiesForFeed() wrapper is the tested
 * boundary.
 *
 * This suite proves: a DIFFERENT profile in → a DIFFERENT ranking out, with
 * deliberately opposed profiles/jobs so it cannot pass by accident. Plus a
 * structural check that no demo fixture can leak into the route.
 *
 * Run: npx tsx test/feed-profile-scoring-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PersonProfile, CanonicalOpportunity } from '../src/types/byn';
import { scoreOpportunitiesForFeed } from '../src/lib/matching/engine';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function worldwideProfile(id: string, skills: string[]): PersonProfile {
  const now = new Date().toISOString();
  return {
    id, email: `${id}@example.com`, fullName: id, planTier: 'free',
    dailyEvaluationsCount: 0, lastEvaluationResetAt: now, createdAt: now, updatedAt: now,
    intent: {
      id: `intent-${id}`, profileId: id, employmentTypes: ['Full-time'],
      targetRoles: [skills[0]], yearsOfExperience: '4-6', minSalary: 0,
      preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: now,
    },
    skills: skills.map((s, i) => ({
      id: `s-${id}-${i}`, profileId: id, skillName: s, yearsUsed: 5,
      isPrimary: true, evidenceLevel: 'strong' as const,
    })),
    experiences: [],
    location: {
      id: `loc-${id}`, profileId: id, currentCountry: 'Worldwide', currentTimezone: 'UTC',
      workPreference: 'worldwide', allowedCountries: [], willingTimezones: ['UTC'],
    },
  };
}

function worldwideJob(id: string, title: string, skills: string[]): CanonicalOpportunity {
  const now = new Date().toISOString();
  return {
    id, type: 'job', title, company: 'Worldwide Co',
    description: `${title}. Stack: ${skills.join(', ')}.`,
    source: 'curated', sourceId: id, officialUrl: `https://ex.co/${id}`,
    canonicalUrlHash: `h-${id}`, contentHash: `c-${id}`,
    employmentType: 'Full-time', remoteType: 'Worldwide',
    eligibleCountries: [], excludedCountries: [], timezoneRequirements: [],
    requiredSkills: skills, preferredSkills: [], experienceRequirement: '4-6',
    qualityScore: 85, status: 'active', isActive: true,
    postedAt: now, lastVerifiedAt: now,
  };
}

function run() {
  console.log('='.repeat(78));
  console.log('FEED PROFILE-SCORING REGRESSION (blocker 1)');
  console.log('='.repeat(78) + '\n');

  const reactJob = worldwideJob('opp-curated-fps-react', 'Senior Frontend Engineer', ['React', 'TypeScript', 'Next.js']);
  const pythonJob = worldwideJob('opp-curated-fps-python', 'Senior Backend Engineer', ['Python', 'Django', 'FastAPI']);
  const jobs = [reactJob, pythonJob];

  const alice = worldwideProfile('alice-react', ['React', 'TypeScript', 'Next.js']);
  const bob = worldwideProfile('bob-python', ['Python', 'Django', 'FastAPI']);

  const rankedForAlice = scoreOpportunitiesForFeed(alice, jobs);
  const rankedForBob = scoreOpportunitiesForFeed(bob, jobs);

  // 1. Different profile in -> different top pick out.
  assert(rankedForAlice[0].id === reactJob.id,
    `React-skilled profile ranks the React job first (got ${rankedForAlice[0].id})`);
  assert(rankedForBob[0].id === pythonJob.id,
    `Python-skilled profile ranks the Python job first (got ${rankedForBob[0].id})`);
  assert(rankedForAlice[0].id !== rankedForBob[0].id,
    'A and B get DIFFERENT top opportunities — the caller profile actually drives scoring');

  // 2. Same job, different score per profile — cannot pass accidentally.
  const reactScoreA = rankedForAlice.find((o) => o.id === reactJob.id)!.fitScore;
  const reactScoreB = rankedForBob.find((o) => o.id === reactJob.id)!.fitScore;
  const pythonScoreA = rankedForAlice.find((o) => o.id === pythonJob.id)!.fitScore;
  const pythonScoreB = rankedForBob.find((o) => o.id === pythonJob.id)!.fitScore;
  assert(reactScoreA > reactScoreB,
    `React job scores higher for the React profile (${reactScoreA} vs ${reactScoreB})`);
  assert(pythonScoreB > pythonScoreA,
    `Python job scores higher for the Python profile (${pythonScoreB} vs ${pythonScoreA})`);

  // 3. Structural: the feed route cannot fall back to a demo fixture.
  const routeSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/app/api/opportunities/feed/route.ts'), 'utf8');
  assert(!/\bimport\b[^;]*mock-seed|localStore\.|DEFAULT_DEMO_PROFILE/.test(routeSrc),
    'feed/route.ts has no import of / call into the client-local profile store');
  assert(/scoreOpportunitiesForFeed\(\s*profile\s*,/.test(routeSrc),
    'feed/route.ts scores against the request-body `profile`, not a fixture');
  assert(/body as \{ profile\?: unknown \}|\.profile\b/.test(routeSrc),
    'feed/route.ts reads the profile from the POST body');

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run();
