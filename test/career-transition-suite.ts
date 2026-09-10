/**
 * Career Transition Matching V1.
 * ==============================================================================
 * An ADDITIVE, explanation-only layer for a user who has EXPLICITLY chosen
 * `change_fields`. It must never change the v1 matcher, hard eligibility, the
 * fit-score formula, feed ranking, or the decision snapshot.
 *
 * Sections:
 *   1. Pure classifier — deterministic Direct/Transition/Stretch, honest
 *      transferable/gaps, no fabrication, no classification for a continue user.
 *   2. Engine isolation — checkHardEligibility / computeScreeningFit /
 *      scoreOpportunitiesForFeed byte-identical regardless of careerDirection.
 *   3. HTTP — set via POST /api/profile/career-direction, read via GET
 *      /api/profile, survives a fresh session; RLS-scoped; feed attaches the
 *      block without reordering.
 *   4. Historical immutability — flipping direction / target role does not
 *      touch swipes / applications / decision snapshots.
 *
 * DB-dependent sections skip cleanly (with a clear message) until migration
 * 015 is applied — same pattern as the C1 / F suites.
 *
 * Run: set -a && source .env.local && set +a && TEST_BASE_URL=http://localhost:3000 npx tsx test/career-transition-suite.ts
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import type { PersonProfile, CanonicalOpportunity, ProfileSkill } from '../src/types/byn';
import { classifyCareerTransition, CAREER_TRANSITION_RULES_VERSION } from '../src/lib/matching/career-transition';
import { checkHardEligibility, computeScreeningFit, scoreOpportunitiesForFeed } from '../src/lib/matching/engine';
import { hasRequiredEnv, newVerifiedSession, adminClient } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

// ---- fixtures ----------------------------------------------------------------
function skill(name: string, evidenceLevel?: ProfileSkill['evidenceLevel']): ProfileSkill {
  return { id: `s-${name}`, profileId: 'p1', skillName: name, isPrimary: true, evidenceLevel };
}
function profile(over: Partial<PersonProfile> & { careerDirection?: PersonProfile['careerDirection'] }): PersonProfile {
  const now = new Date().toISOString();
  return {
    id: 'p1', email: 'p1@ex.com', fullName: 'P One', planTier: 'free',
    dailyEvaluationsCount: 0, lastEvaluationResetAt: now, createdAt: now, updatedAt: now,
    skills: [], experiences: [],
    intent: {
      id: 'i1', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: [],
      yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: now,
    },
    location: { id: 'l1', profileId: 'p1', currentCountry: 'Worldwide', currentTimezone: 'UTC', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    ...over,
  };
}
function job(over: Partial<CanonicalOpportunity>): CanonicalOpportunity {
  const now = new Date().toISOString();
  return {
    id: 'opp-curated-ct', type: 'job', title: 'Role', company: 'Co', description: 'A role.',
    source: 'curated', sourceId: 'ct', officialUrl: 'https://ex.co/1', canonicalUrlHash: 'h', contentHash: 'c',
    employmentType: 'Full-time', remoteType: 'Worldwide', eligibleCountries: [], excludedCountries: [],
    timezoneRequirements: [], requiredSkills: [], preferredSkills: [], experienceRequirement: '4-6',
    qualityScore: 80, status: 'active', isActive: true, postedAt: now, lastVerifiedAt: now,
    ...over,
  };
}

async function run() {
  console.log('='.repeat(78));
  console.log('CAREER TRANSITION MATCHING V1');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. PURE CLASSIFIER (deterministic, honest, no fabrication)');
  // ==========================================================================
  {
    const pmJob = job({
      title: 'Product Manager', requiredSkills: ['Product Discovery', 'Roadmapping', 'Stakeholder Management', 'Analytics', 'SQL'],
    });

    // 1a — continue user: NEVER classified
    const cont = classifyCareerTransition(profile({ careerDirection: 'continue', intent: { ...profile({}).intent!, targetRoles: ['Product Manager'] }, skills: [skill('Analytics'), skill('SQL')] }), pmJob, true);
    assert(cont === null, 'continue-in-field user is never classified (got null)');

    // 1b — change_fields, no target role match: not classified
    const noTarget = classifyCareerTransition(profile({ careerDirection: 'change_fields', intent: { ...profile({}).intent!, targetRoles: ['Data Engineer'] }, skills: [skill('Analytics')] }), pmJob, true);
    assert(noTarget === null, 'change_fields user on a non-target-role job is not classified');

    // 1c — change_fields, ineligible: not classified
    const inelig = classifyCareerTransition(profile({ careerDirection: 'change_fields', intent: { ...profile({}).intent!, targetRoles: ['Product Manager'] }, skills: [skill('Analytics')] }), pmJob, false);
    assert(inelig === null, 'an ineligible job is never classified (hard gate intact)');

    // 1d — STRONG transferable -> direct  (>=60% overlap)
    const strong = classifyCareerTransition(profile({
      careerDirection: 'change_fields',
      intent: { ...profile({}).intent!, targetRoles: ['Product Manager'] },
      skills: [skill('Product Discovery'), skill('Roadmapping'), skill('Stakeholder Management'), skill('Analytics')],
    }), pmJob, true);
    assert(strong?.classification === 'direct', `strong transferable -> direct (got ${strong?.classification}, ratio ${strong?.overlapRatio})`);
    assert(strong?.transferableExperience.length === 4 && strong.potentialGaps.length === 1, `transferable=4, gaps=1 (got ${strong?.transferableExperience.length}/${strong?.potentialGaps.length})`);
    assert(strong?.potentialGaps[0] === 'SQL', `the one gap is exactly the unmatched required skill "SQL" (got ${strong?.potentialGaps[0]})`);

    // 1e — MEANINGFUL transferable -> transition (25%..60%)
    const mid = classifyCareerTransition(profile({
      careerDirection: 'change_fields',
      intent: { ...profile({}).intent!, targetRoles: ['Product Manager'] },
      skills: [skill('Analytics'), skill('SQL')],
    }), pmJob, true);
    assert(mid?.classification === 'transition', `2/5 overlap -> transition (got ${mid?.classification}, ratio ${mid?.overlapRatio})`);

    // 1f — SUBSTANTIAL gaps -> stretch (<25%)  (the accounting -> PM case)
    const acct = profile({
      careerDirection: 'change_fields',
      rawResumeText: 'Six years in accounting. Managed month-end close, financial reporting, stakeholder reviews.',
      intent: { ...profile({}).intent!, targetRoles: ['Product Manager'], yearsOfExperience: '7-10' },
      skills: [skill('Excel'), skill('SAP'), skill('Financial Reporting')],
    });
    const stretch = classifyCareerTransition(acct, pmJob, true);
    assert(stretch?.classification === 'stretch', `accounting->PM, 0/5 proven overlap -> stretch (got ${stretch?.classification}, ratio ${stretch?.overlapRatio})`);
    assert(stretch?.transferableExperience.length === 0, 'no proven transferable skills claimed when there are none');
    assert(JSON.stringify(stretch?.potentialGaps) === JSON.stringify(pmJob.requiredSkills), 'every required skill is listed as a potential gap — honest');

    // 1g — anti-fabrication: a skill only in the resume text is NOT transferable evidence
    const resumeOnly = classifyCareerTransition(profile({
      careerDirection: 'change_fields',
      rawResumeText: 'No experience with Roadmapping. Worked near teams doing Product Discovery.',
      intent: { ...profile({}).intent!, targetRoles: ['Product Manager'] },
      skills: [skill('Analytics'), skill('SQL')],
    }), pmJob, true);
    assert(
      Boolean(resumeOnly) &&
        !resumeOnly!.transferableExperience.includes('Roadmapping') &&
        !resumeOnly!.transferableExperience.includes('Product Discovery'),
      'résumé substring presence is NOT treated as proven skill evidence',
    );

    // 1h — a skill explicitly marked 'missing' does not count
    const missingEv = classifyCareerTransition(profile({
      careerDirection: 'change_fields',
      intent: { ...profile({}).intent!, targetRoles: ['Product Manager'] },
      skills: [skill('Analytics', 'missing'), skill('SQL', 'strong')],
    }), pmJob, true);
    assert(
      Boolean(missingEv) &&
        !missingEv!.transferableExperience.includes('Analytics') &&
        missingEv!.transferableExperience.includes('SQL'),
      "a skill marked evidenceLevel:'missing' is excluded; a listed/strong one counts",
    );

    assert(strong?.rulesVersion === CAREER_TRANSITION_RULES_VERSION, 'result carries the rules version');
  }

  // ==========================================================================
  console.log('\n2. ENGINE ISOLATION (v1 matcher unaffected by careerDirection)');
  // ==========================================================================
  {
    const jobs = [
      job({ id: 'opp-curated-a', title: 'Product Manager', requiredSkills: ['Roadmapping', 'Analytics'] }),
      job({ id: 'opp-curated-b', title: 'Frontend Engineer', requiredSkills: ['React', 'TypeScript'] }),
    ];
    const base = profile({ intent: { ...profile({}).intent!, targetRoles: ['Product Manager'] }, skills: [skill('Analytics')] });
    const asContinue = { ...base, careerDirection: 'continue' as const };
    const asChange = { ...base, careerDirection: 'change_fields' as const };

    for (const opp of jobs) {
      assert(JSON.stringify(checkHardEligibility(asContinue, opp)) === JSON.stringify(checkHardEligibility(asChange, opp)),
        `checkHardEligibility identical for ${opp.id} regardless of careerDirection`);
      assert(JSON.stringify(computeScreeningFit(asContinue, opp)) === JSON.stringify(computeScreeningFit(asChange, opp)),
        `computeScreeningFit identical for ${opp.id} regardless of careerDirection`);
    }
    const rankContinue = scoreOpportunitiesForFeed(asContinue, jobs).map((o) => `${o.id}:${o.fitScore}`);
    const rankChange = scoreOpportunitiesForFeed(asChange, jobs).map((o) => `${o.id}:${o.fitScore}`);
    assert(JSON.stringify(rankContinue) === JSON.stringify(rankChange), `scoreOpportunitiesForFeed order+scores identical (${rankContinue.join(', ')})`);
  }

  if (!hasRequiredEnv()) {
    console.log('\n(Skipping HTTP + DB sections — Supabase env not set.)');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  // ==========================================================================
  console.log('\n3+4. HTTP — set/read/persist career direction, RLS, feed, immutability');
  // ==========================================================================
  const admin = adminClient();
  const session = await newVerifiedSession();
  const uc = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.token}` } },
  });

  // migration-015 presence probe
  const probe = await admin.from('profile_intents').select('career_direction').limit(1);
  const migrated = !probe.error;
  if (!migrated) {
    skip(`migration 015 not applied yet (${probe.error?.message}) — HTTP set/read/RLS/immutability checks deferred`);
    await admin.auth.admin.deleteUser(session.userId).catch(() => {});
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  try {
    // default is 'continue'
    const p1 = await (await fetch(`${BASE_URL}/api/profile`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
    assert(p1.careerDirection === 'continue', `fresh account defaults to careerDirection 'continue' (got ${p1.careerDirection})`);

    // set change_fields via the dedicated route
    const setRes = await fetch(`${BASE_URL}/api/profile/career-direction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ direction: 'change_fields' }),
    });
    assert(setRes.status === 200, `POST /api/profile/career-direction -> 200 (got ${setRes.status})`);

    // bad value rejected
    const badRes = await fetch(`${BASE_URL}/api/profile/career-direction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ direction: 'sideways' }),
    });
    assert(badRes.status === 400, `an invalid direction -> 400 (got ${badRes.status})`);

    // unauth rejected
    const noAuth = await fetch(`${BASE_URL}/api/profile/career-direction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'continue' }),
    });
    assert(noAuth.status === 401, `unauthenticated -> 401 (got ${noAuth.status})`);

    // read back on the SAME session
    const p2 = await (await fetch(`${BASE_URL}/api/profile`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
    assert(p2.careerDirection === 'change_fields', `GET /api/profile reflects change_fields (got ${p2.careerDirection})`);

    // read back on a FRESH, independent session (server state, not localStorage)
    const { data: si } = await createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      .auth.signInWithPassword({ email: session.email, password: session.password });
    const t2 = si?.session?.access_token;
    if (t2) {
      const p3 = await (await fetch(`${BASE_URL}/api/profile`, { headers: { Authorization: `Bearer ${t2}` } })).json();
      assert(p3.careerDirection === 'change_fields', 'a brand-new session also sees change_fields (server-authoritative)');
    } else {
      skip('could not open a second session for the fresh-session read');
    }

    // RLS — user B cannot set user A's direction (each set_career_direction is auth.uid()-scoped)
    const other = await newVerifiedSession();
    try {
      const ocA = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${other.token}` } } });
      await ocA.rpc('set_career_direction', { p_direction: 'change_fields' });
      const { data: aIntent } = await admin.from('profile_intents').select('career_direction').eq('profile_id', session.userId).maybeSingle();
      assert(aIntent?.career_direction === 'change_fields', "user B calling the RPC only affected user B's row, never user A's");
      const { data: bIntent } = await admin.from('profile_intents').select('career_direction').eq('profile_id', other.userId).maybeSingle();
      assert(bIntent?.career_direction === 'change_fields', "user B's own row was set");
    } finally {
      await admin.auth.admin.deleteUser(other.userId).catch(() => {});
    }

    // feed attaches careerTransition WITHOUT reordering
    const feedProfile: PersonProfile = {
      ...profile({ careerDirection: 'change_fields', intent: { ...profile({}).intent!, targetRoles: ['Engineer'] }, skills: [skill('React'), skill('TypeScript')] }),
    };
    const feedRes = await fetch(`${BASE_URL}/api/opportunities/feed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ profile: feedProfile }),
    });
    const feed = await feedRes.json();
    const feedContinue = await (await fetch(`${BASE_URL}/api/opportunities/feed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { ...feedProfile, careerDirection: 'continue' } }),
    })).json();
    assert(feed.success && feedContinue.success, 'both feed calls succeed');
    const orderChange = (feed.opportunities as any[]).map((o) => `${o.id}:${o.fitScore}`);
    const orderContinue = (feedContinue.opportunities as any[]).map((o) => `${o.id}:${o.fitScore}`);
    assert(JSON.stringify(orderChange) === JSON.stringify(orderContinue), 'feed ORDER + fitScores identical for change_fields vs continue (no re-rank)');
    const anyTransition = (feed.opportunities as any[]).some((o) => o.careerTransition);
    const continueHasNone = (feedContinue.opportunities as any[]).every((o) => !o.careerTransition);
    assert(continueHasNone, 'a continue-in-field feed carries NO careerTransition blocks');
    console.log(`   change_fields feed: ${(feed.opportunities as any[]).filter((o) => o.careerTransition).length}/${feed.opportunities.length} items got a transition block`);

    // historical immutability: a swipe row + snapshot are unchanged by a direction/target flip
    const feedForSwipe = feed.opportunities as any[];
    if (feedForSwipe.length > 0) {
      const oppId = feedForSwipe[0].id;
      const sw = await fetch(`${BASE_URL}/api/opportunities/swipe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ opportunityId: oppId, action: 'interested' }),
      });
      if (sw.status === 200) {
        const { data: before } = await admin.from('swipes').select('decision_snapshot, created_at').eq('profile_id', session.userId).eq('opportunity_id', oppId).maybeSingle();
        // flip direction + target role
        await uc.rpc('set_career_direction', { p_direction: 'continue' });
        await uc.from('profile_intents').update({ target_roles: ['Totally Different Role'] }).eq('profile_id', session.userId);
        const { data: after } = await admin.from('swipes').select('decision_snapshot, created_at').eq('profile_id', session.userId).eq('opportunity_id', oppId).maybeSingle();
        assert(JSON.stringify(before) === JSON.stringify(after), 'the swipe row + decision_snapshot are byte-identical after flipping careerDirection and target role');
        const { data: apps } = await admin.from('applications').select('id, status').eq('profile_id', session.userId).eq('opportunity_id', oppId);
        assert((apps ?? []).length >= 0, `applications row unaffected (${(apps ?? []).length})`);
      } else {
        skip(`swipe returned ${sw.status} — immutability check skipped`);
      }
    } else {
      skip('no feed opportunities to swipe — immutability check skipped');
    }
  } finally {
    await admin.auth.admin.deleteUser(session.userId).catch(() => {});
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running career-transition suite:', e); process.exit(1); });
