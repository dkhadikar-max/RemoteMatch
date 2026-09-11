/**
 * L — Match Explanation 2.0.
 * ==============================================================================
 *   1. deriveActionableSkillGaps (L3) — pure, isolated from engine.ts: correct
 *      skill-shaped diff, dedupe within one job, cap at 5, never returns a
 *      skill the profile already demonstrates (same fuzzy rule as engine.ts /
 *      career-transition.ts), uses I's normalizeSkillKey (no second
 *      normalization rule).
 *   2. Static — no engine.ts diff from the pre-L baseline (the "(Verified)"
 *      wording fix is a render-time substitution only, per L6); the new panel
 *      calls exactly ticket I's two existing endpoints and no new route
 *      exists; match-analysis-view.tsx substitutes "(Verified)" ->
 *      "(from your profile)" at render time only.
 *   3. Copy guarantee — the confirm string is always a question ("Do you have
 *      X experience?"), never an assertion ("You don't have X" / "add X to
 *      strengthen").
 *
 * Run: npx tsx test/match-explanation-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import type { CanonicalOpportunity, PersonProfile, ProfileSkill } from '../src/types/byn';
import { deriveActionableSkillGaps } from '../src/lib/match/actionable-skill-gaps';
import { normalizeSkillKey } from '../src/lib/resume/skill-opportunities';

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
  console.log('L — MATCH EXPLANATION 2.0');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. deriveActionableSkillGaps (L3 — pure, engine.ts-isolated)');
  // ==========================================================================
  {
    const p = profile({ skills: [skill('SQL'), skill('Python')] });
    const opp = job({ requiredSkills: ['SQL', 'Python', 'Airflow', 'Spark', 'dbt', 'Kafka'] });
    const gaps = deriveActionableSkillGaps(p, opp);
    assert(!gaps.some((g) => g.skillKey === 'sql' || g.skillKey === 'python'), 'a skill the profile already has is never returned as a gap');
    assert(gaps.some((g) => g.skill === 'Airflow'), 'a genuinely missing requirement is returned');
    assert(gaps.length <= 5, `capped at 5 (got ${gaps.length})`);

    // dedupe within one job (case/alias variants of the same requirement)
    const oppDup = job({ requiredSkills: ['Kubernetes', 'kubernetes', 'K8s'] });
    const dupGaps = deriveActionableSkillGaps(profile({ skills: [] }), oppDup);
    assert(dupGaps.length === 1 && dupGaps[0].skillKey === 'kubernetes', `variants of the same skill collapse to one gap (got ${dupGaps.length})`);

    // fuzzy match — substring either direction, same rule as engine.ts/career-transition.ts
    const fuzzyProfile = profile({ skills: [skill('React.js')] });
    const fuzzyOpp = job({ requiredSkills: ['React'] });
    assert(deriveActionableSkillGaps(fuzzyProfile, fuzzyOpp).length === 0, '"React.js" on profile covers a "React" requirement (two-way substring match)');

    // normalizeSkillKey reuse — no second normalization rule
    const aliasOpp = job({ requiredSkills: ['Node.js'] });
    const aliasGaps = deriveActionableSkillGaps(profile({ skills: [] }), aliasOpp);
    assert(aliasGaps[0]?.skillKey === normalizeSkillKey('Node.js'), 'skillKey uses I\'s normalizeSkillKey verbatim');

    // no gaps when everything is covered
    const fullyCovered = profile({ skills: [skill('SQL')] });
    assert(deriveActionableSkillGaps(fullyCovered, job({ requiredSkills: ['SQL'] })).length === 0, 'no gaps when every requirement is covered');

    // never mutates inputs
    const before = JSON.stringify(p);
    deriveActionableSkillGaps(p, opp);
    assert(JSON.stringify(p) === before, 'profile is never mutated');
  }

  // ==========================================================================
  console.log('\n2. STATIC — engine.ts untouched, no new route, render-time-only substitution');
  // ==========================================================================
  {
    try {
      const diff = execSync('git diff HEAD -- src/lib/matching/engine.ts', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(diff.trim() === '', 'src/lib/matching/engine.ts has zero uncommitted diff from HEAD (L6-b: never modified for L)');
    } catch (e: any) {
      skip(`git diff check unavailable (${e.message})`);
    }

    const view = readFileSync(join(__dirname, '../src/components/match/match-analysis-view.tsx'), 'utf8');
    assert(view.includes("replace('(Verified)'"), 'the "(Verified)" -> "(from your profile)" substitution happens at render time in match-analysis-view.tsx');
    assert(view.includes('whyThisJob'), 'match.whyThisJob is rendered (L4) — zero new computation');
    assert(!view.includes('requirementChecklist'), 'requirementChecklist stays unsurfaced (L5)');

    const engine = readFileSync(join(__dirname, '../src/lib/matching/engine.ts'), 'utf8');
    assert(engine.includes("'Verified'"), 'engine.ts itself still generates the original wording — the fix is client-side only, per L6-b');

    const whatYouCanDo = readFileSync(join(__dirname, '../src/components/match/what-you-can-do.tsx'), 'utf8');
    assert(whatYouCanDo.includes("fetch('/api/profile/skills'"), 'What you can do calls the add-skill endpoint');
    assert(whatYouCanDo.includes("'/api/profile/skills/dismiss'"), 'What you can do calls the dismiss endpoint');
    assert(!whatYouCanDo.includes('/api/profile/skills/gap') && !whatYouCanDo.includes('/api/match/'), 'no new skills/dismissal route is introduced for L');

    const gapHelper = readFileSync(join(__dirname, '../src/lib/match/actionable-skill-gaps.ts'), 'utf8');
    assert(!gapHelper.includes("from '@/lib/matching/engine'") && !gapHelper.includes('from "../matching/engine"'), 'actionable-skill-gaps.ts never imports engine.ts (isolation, matches career-transition.ts / skill-opportunities.ts pattern)');
    assert(!gapHelper.includes('match.gaps') && !gapHelper.includes('.gaps['), 'gaps are derived structurally, never by parsing engine.ts\'s gaps[] sentence strings');
  }

  // ==========================================================================
  console.log('\n3. COPY GUARANTEE — always a question, never an assertion of possession');
  // ==========================================================================
  {
    const src = readFileSync(join(__dirname, '../src/components/match/what-you-can-do.tsx'), 'utf8');
    assert(src.includes('Do you have {gap.skill} experience?') || /Do you have \{.*\} experience\?/.test(src), 'confirm copy is phrased as a question');
    assert(!/you don.?t have/i.test(src), 'never asserts the user lacks a skill');
    assert(!/we found/i.test(src) && !/add .* to strengthen/i.test(src), 'never claims the system discovered the skill, never phrased as a recommendation to add');
    assert(src.includes('could increase') && src.includes("isn't currently part of your profile") || src.includes('isn&rsquo;t currently part of your profile'), 'dismissed-row reassurance copy matches ticket I\'s exact wording');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running match-explanation suite:', e); process.exit(1); });
