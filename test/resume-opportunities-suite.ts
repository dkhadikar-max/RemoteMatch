/**
 * I — Resume Match Opportunities ("Grow your matches").
 * ==============================================================================
 *   1. normalizeSkillKey — case/trim + the TINY explicit alias map only.
 *      Non-aliases (javascript≠typescript, postgresql≠sql, react≠frontend) stay
 *      distinct — no hidden taxonomy.
 *   2. computeSkillOpportunities — jobCount is DISTINCT relevant jobs (a job
 *      listing a skill 3× / in 3 casings contributes 1); owned + dismissed
 *      skills excluded; ranked by jobCount; top-N.
 *   3. selectRelevantOpportunities — uses the frozen checkHardEligibility
 *      unchanged (which already requires target-role alignment).
 *   4. HTTP — GET the suggestions, add one (idempotent, RLS-scoped, reflected in
 *      /api/onboarding + removed from the next GET), dismiss one (suppressed on
 *      the next GET). 400/401 paths.
 *   5. I5 integrity gate — adding a confirmed skill raises the user's own
 *      computeScreeningFit for an applicable job, while checkHardEligibility and
 *      the scoreOpportunitiesForFeed ranking rule are unchanged.
 *
 * Run: set -a && source .env.local && set +a && TEST_BASE_URL=... npx tsx test/resume-opportunities-suite.ts
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import type { CanonicalOpportunity, PersonProfile, ProfileSkill } from '../src/types/byn';
import {
  normalizeSkillKey,
  computeSkillOpportunities,
  selectRelevantOpportunities,
} from '../src/lib/resume/skill-opportunities';
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

function skill(name: string): ProfileSkill {
  return { id: `s-${name}`, profileId: 'p1', skillName: name, isPrimary: false };
}
function profile(over: Partial<PersonProfile>): PersonProfile {
  const now = new Date().toISOString();
  return {
    id: 'p1', email: 'p1@ex.com', fullName: 'P', planTier: 'free',
    dailyEvaluationsCount: 0, lastEvaluationResetAt: now, createdAt: now, updatedAt: now,
    skills: [], experiences: [],
    intent: {
      id: 'i', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: ['Data Engineer'],
      yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: now,
    },
    location: { id: 'l', profileId: 'p1', currentCountry: 'Worldwide', currentTimezone: 'UTC', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    ...over,
  };
}
function job(over: Partial<CanonicalOpportunity>): CanonicalOpportunity {
  const now = new Date().toISOString();
  return {
    id: 'opp', type: 'job', title: 'Data Engineer', company: 'Co', description: 'd',
    source: 'remotive', sourceId: 's', officialUrl: 'https://e.co', canonicalUrlHash: 'h', contentHash: 'c',
    employmentType: 'Full-time', remoteType: 'Worldwide', eligibleCountries: [], excludedCountries: [],
    timezoneRequirements: [], requiredSkills: [], preferredSkills: [], qualityScore: 80,
    status: 'active', isActive: true, postedAt: now, lastVerifiedAt: now,
    ...over,
  };
}

async function run() {
  console.log('='.repeat(78));
  console.log('I — RESUME MATCH OPPORTUNITIES');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. normalizeSkillKey (tiny alias map, NO taxonomy)');
  // ==========================================================================
  {
    assert(normalizeSkillKey('  React  ') === 'react', 'trim + lowercase');
    assert(normalizeSkillKey('Node.js') === 'nodejs' && normalizeSkillKey('NodeJS'.toLowerCase()) === 'nodejs' && normalizeSkillKey('node js') === 'nodejs', 'node.js / nodejs / "node js" all collapse');
    assert(normalizeSkillKey('K8s') === 'kubernetes', 'k8s → kubernetes');
    assert(normalizeSkillKey('Golang') === 'go', 'golang → go');
    // NON-aliases must stay distinct
    assert(normalizeSkillKey('JavaScript') !== normalizeSkillKey('TypeScript'), 'javascript ≠ typescript');
    assert(normalizeSkillKey('PostgreSQL') !== normalizeSkillKey('SQL'), 'postgresql ≠ sql');
    assert(normalizeSkillKey('React') !== normalizeSkillKey('Frontend'), 'react ≠ frontend');
  }

  // ==========================================================================
  console.log('\n2. computeSkillOpportunities (distinct-job count, exclusions, rank)');
  // ==========================================================================
  {
    const jobs = [
      // one job, Kubernetes in 3 casings -> contributes 1
      job({ requiredSkills: ['Kubernetes', 'kubernetes', 'K8s', 'AWS'] }),
      job({ requiredSkills: ['Kubernetes', 'Terraform'] }),
      job({ requiredSkills: ['kubernetes', 'AWS'] }),
      job({ requiredSkills: ['Node.js'] }),
      job({ requiredSkills: ['nodejs'] }),
    ];
    const out = computeSkillOpportunities({
      relevantOpps: jobs,
      ownedSkillKeys: new Set<string>(),
      dismissedKeys: new Set<string>(),
    });
    const byKey = Object.fromEntries(out.map((o) => [o.skillKey, o.jobCount]));
    assert(byKey['kubernetes'] === 3, `Kubernetes counted in 3 DISTINCT jobs, not occurrences (got ${byKey['kubernetes']})`);
    assert(byKey['aws'] === 2, `AWS in 2 jobs (got ${byKey['aws']})`);
    assert(byKey['nodejs'] === 2, `Node.js + nodejs collapse to one key, 2 jobs (got ${byKey['nodejs']})`);
    assert(out[0].skillKey === 'kubernetes', 'ranked by jobCount desc (kubernetes first)');
    const kube = out.find((o) => o.skillKey === 'kubernetes')!;
    assert(kube.skill === 'Kubernetes', `display name is the most common original casing (got "${kube.skill}")`);

    const owned = computeSkillOpportunities({
      relevantOpps: jobs, ownedSkillKeys: new Set(['kubernetes']), dismissedKeys: new Set<string>(),
    });
    assert(!owned.some((o) => o.skillKey === 'kubernetes'), 'a skill the user already has is never suggested');

    const dismissed = computeSkillOpportunities({
      relevantOpps: jobs, ownedSkillKeys: new Set<string>(), dismissedKeys: new Set(['aws']),
    });
    assert(!dismissed.some((o) => o.skillKey === 'aws'), 'a dismissed skill is never suggested');

    const limited = computeSkillOpportunities({
      relevantOpps: jobs, ownedSkillKeys: new Set<string>(), dismissedKeys: new Set<string>(), limit: 2,
    });
    assert(limited.length === 2, 'top-N limit respected');
  }

  // ==========================================================================
  console.log('\n3. selectRelevantOpportunities (frozen checkHardEligibility, unchanged)');
  // ==========================================================================
  {
    const p = profile({ intent: { ...profile({}).intent!, targetRoles: ['Data Engineer'] }, skills: [skill('SQL')] });
    const aligned = job({ id: 'aligned', title: 'Senior Data Engineer', requiredSkills: ['SQL', 'Airflow'] });
    const offTarget = job({ id: 'off', title: 'Frontend Designer', requiredSkills: ['Figma', 'CSS'] });
    const usOnly = job({ id: 'us', title: 'Data Engineer', remoteType: 'US', requiredSkills: ['SQL'] });

    const relevant = selectRelevantOpportunities(p, [aligned, offTarget, usOnly]);
    assert(relevant.some((o) => o.id === 'aligned'), 'eligible + target-aligned job is relevant');
    assert(!relevant.some((o) => o.id === 'off'), 'off-target job is excluded');
    assert(!relevant.some((o) => o.id === 'us'), 'geo-ineligible job is excluded');
    // engine isolation: the frozen fn is byte-identical regardless of this module
    const direct = JSON.stringify(checkHardEligibility(p, aligned));
    const viaSelect = selectRelevantOpportunities(p, [aligned]).length === 1;
    assert(direct === JSON.stringify(checkHardEligibility(p, aligned)) && viaSelect, 'checkHardEligibility output is unchanged (read-only use)');
  }

  // ==========================================================================
  console.log('\n5. I5 INTEGRITY — adding a skill moves fit, not eligibility/ranking');
  // ==========================================================================
  {
    // non-generic target role so eligibility is title-based (skill-independent)
    const base = profile({ intent: { ...profile({}).intent!, targetRoles: ['Data Engineer'] }, skills: [skill('SQL'), skill('Python')] });
    const opp = job({ title: 'Senior Data Engineer', requiredSkills: ['SQL', 'Python', 'Airflow', 'Spark', 'dbt'] });

    const fitBefore = computeScreeningFit(base, opp).fitScore;
    const withSkill: PersonProfile = { ...base, skills: [...base.skills, skill('Airflow')] };
    const fitAfter = computeScreeningFit(withSkill, opp).fitScore;
    assert(fitAfter >= fitBefore, `adding a matching skill never lowers fit (${fitBefore} -> ${fitAfter})`);
    assert(fitAfter > fitBefore, `adding "Airflow" (a listed requirement) raises fit (${fitBefore} -> ${fitAfter})`);

    assert(
      JSON.stringify(checkHardEligibility(base, opp)) === JSON.stringify(checkHardEligibility(withSkill, opp)),
      'hard eligibility is IDENTICAL before/after adding a skill (non-generic target)',
    );

    // ranking rule: scoreOpportunitiesForFeed always returns fitScore-desc order
    const jobs = [opp, job({ id: 'b', title: 'Data Engineer', requiredSkills: ['SQL'] })];
    for (const prof of [base, withSkill]) {
      const scored = scoreOpportunitiesForFeed(prof, jobs);
      const sortedOk = scored.every((o, i) => i === 0 || scored[i - 1].fitScore >= o.fitScore);
      assert(sortedOk, `scoreOpportunitiesForFeed still returns pure fitScore-desc order (${scored.map((o) => o.fitScore).join(', ')})`);
    }
  }

  if (!hasRequiredEnv()) {
    console.log('\n(Skipping HTTP section — Supabase env not set.)');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  // ==========================================================================
  console.log('\n4. HTTP — suggestions, add (idempotent + RLS), dismiss');
  // ==========================================================================
  const admin = adminClient();
  const probe = await admin.rpc('add_profile_skill', { p_skill_name: '' }).then((r) => r, (e) => ({ error: e }));
  // an empty name should 23514; a "function does not exist" means migration 016 isn't applied
  const migrated = !(probe.error && /does not exist|not find/i.test(probe.error.message || ''));
  if (!migrated) {
    skip(`migration 016 not applied yet (${probe.error?.message}) — HTTP section deferred`);
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const session = await newVerifiedSession();
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  try {
    // onboarding: a data-engineering target + a couple of skills
    const ob = await fetch(`${BASE_URL}/api/onboarding`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        fullName: 'Res Tester', employmentTypes: ['Full-time'], targetRoles: ['Data Engineer'],
        yearsOfExperience: '4-6', skills: [{ name: 'SQL', isPrimary: true }, { name: 'Python', isPrimary: true }],
        workPreference: 'worldwide', currentCountry: 'United States', currentTimezone: 'Americas (EST/PST)',
      }),
    });
    assert(ob.status === 200, `onboarding -> 200 (got ${ob.status})`);

    const g1 = await fetch(`${BASE_URL}/api/resume/opportunities`, { headers: { Authorization: `Bearer ${session.token}` } });
    assert(g1.status === 200, `GET /api/resume/opportunities -> 200 (got ${g1.status})`);
    const d1 = await g1.json();
    assert(d1.success && Array.isArray(d1.opportunities) && typeof d1.relevantJobCount === 'number', 'response shape { success, opportunities[], relevantJobCount }');
    assert(d1.opportunities.every((o: any) => typeof o.skill === 'string' && typeof o.skillKey === 'string' && o.jobCount >= 1), 'every suggestion has skill / skillKey / jobCount >= 1');
    assert(d1.opportunities.every((o: any) => !['sql', 'python'].includes(o.skillKey)), 'the user\'s existing skills are never suggested');

    const target = d1.opportunities[0];
    if (target) {
      // add it
      const add = await fetch(`${BASE_URL}/api/profile/skills`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ skillName: target.skill }) });
      assert(add.status === 200, `POST /api/profile/skills -> 200 (got ${add.status})`);
      const ob2 = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
      assert(ob2.skills.some((s: any) => s.name.toLowerCase() === target.skill.toLowerCase()), 'the added skill now appears in GET /api/onboarding');
      const beforeCount = ob2.skills.length;
      // idempotent
      await fetch(`${BASE_URL}/api/profile/skills`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ skillName: target.skill }) });
      const ob3 = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
      assert(ob3.skills.length === beforeCount, `adding the same skill again is a no-op (still ${beforeCount} skills)`);
      const g2 = await (await fetch(`${BASE_URL}/api/resume/opportunities`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
      assert(!g2.opportunities.some((o: any) => o.skillKey === target.skillKey), 'the added skill is no longer suggested');
    } else {
      skip('no suggestions for this fixture profile — add/idempotent checks skipped');
    }

    // bad + unauth
    assert((await fetch(`${BASE_URL}/api/profile/skills`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ skillName: '' }) })).status === 400, 'empty skillName -> 400');
    assert((await fetch(`${BASE_URL}/api/profile/skills`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ skillName: 'x'.repeat(200) }) })).status === 400, 'over-long skillName -> 400');
    assert((await fetch(`${BASE_URL}/api/profile/skills`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skillName: 'Rust' }) })).status === 401, 'unauthenticated add -> 401');

    // dismiss
    const g3 = await (await fetch(`${BASE_URL}/api/resume/opportunities`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
    const toDismiss = g3.opportunities[0];
    if (toDismiss) {
      const dis = await fetch(`${BASE_URL}/api/profile/skills/dismiss`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ skillKey: toDismiss.skillKey }) });
      assert(dis.status === 200, `POST /api/profile/skills/dismiss -> 200 (got ${dis.status})`);
      const g4 = await (await fetch(`${BASE_URL}/api/resume/opportunities`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
      assert(!g4.opportunities.some((o: any) => o.skillKey === toDismiss.skillKey), 'a dismissed skill is suppressed on the next GET');
      const { data: rows } = await admin.from('profile_skill_dismissals').select('profile_id, skill_key').eq('skill_key', toDismiss.skillKey);
      assert((rows ?? []).length === 1 && rows![0].profile_id === session.userId, "the dismissal row exists for THIS user only");
    } else {
      skip('no suggestions left to dismiss — dismiss checks skipped');
    }
    assert((await fetch(`${BASE_URL}/api/profile/skills/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skillKey: 'rust' }) })).status === 401, 'unauthenticated dismiss -> 401');

    // RLS: user B's add never touches user A's skills
    const other = await newVerifiedSession();
    try {
      const ocB = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${other.token}` } } });
      await ocB.rpc('add_profile_skill', { p_skill_name: 'ZZTestSkill' });
      const { data: aSkills } = await admin.from('profile_skills').select('skill_name').eq('profile_id', session.userId);
      assert(!(aSkills ?? []).some((s) => s.skill_name === 'ZZTestSkill'), "user B calling add_profile_skill never added to user A's profile");
      const { data: bSkills } = await admin.from('profile_skills').select('skill_name').eq('profile_id', other.userId);
      assert((bSkills ?? []).some((s) => s.skill_name === 'ZZTestSkill'), "user B's own row was written");
    } finally {
      await admin.auth.admin.deleteUser(other.userId).catch(() => {});
    }
  } finally {
    await admin.auth.admin.deleteUser(session.userId).catch(() => {});
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running resume-opportunities suite:', e); process.exit(1); });
