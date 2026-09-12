/**
 * Short-Skill Matching — approved remediation for a two-way substring
 * fuzzy-match defect independently reimplemented six times across
 * engine.ts, career-transition.ts, and actionable-skill-gaps.ts. A bare
 * short skill like "C" trivially false-matched almost any longer skill
 * string ("react".includes("c")), inflating fitScore/eligibility and
 * producing fabricated "(Verified)" claims. Confirmed against real
 * production data: 18 of 72 active opportunities (25%) carry a required
 * skill of <= 3 characters; the bare tag "C" alone appears on 6 of 72
 * (8.3%).
 *
 * All six sites now import one shared predicate, skillMatches()
 * (src/lib/matching/skill-match.ts) — no caller has its own variant.
 * Scoring formula/weights unchanged; only the match classification that
 * feeds them changes. No migration. No production changes in this ticket.
 *
 * Run: npx tsx test/skill-match-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { skillMatches } from '../src/lib/matching/skill-match';
import { checkHardEligibility, computeScreeningFit, generateRuleBasedMatchAnalysis } from '../src/lib/matching/engine';
import { classifyCareerTransition } from '../src/lib/matching/career-transition';
import { deriveSkillMatchSummary, deriveActionableSkillGaps } from '../src/lib/match/actionable-skill-gaps';
import type { PersonProfile, CanonicalOpportunity, ProfileSkill } from '../src/types/byn';

/** Strips both block comments (including JSDoc, spanning multiple lines)
 *  and line comments before a substring/count check, so an explanatory
 *  comment mentioning "skillMatches()" for context is never double-counted
 *  alongside the real call site. */
function stripLineComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/[^\r\n]*/, ''))
    .join('\n');
}

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

function skill(name: string): ProfileSkill {
  return { id: `s-${name}`, profileId: 'p1', skillName: name, isPrimary: false };
}
function baseProfile(skills: string[]): PersonProfile {
  return {
    id: 'p1', fullName: 'Test', email: 't@example.com', headline: '', profileStrength: 50,
    planTier: 'free', dailyRightSwipesCount: 0, dailyProposalsCount: 0, usageDate: '2026-01-01',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    skills: skills.map(skill),
    intent: { id: 'i1', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: ['Software Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '2026-01-01T00:00:00Z' },
    location: { id: 'l1', profileId: 'p1', currentCountry: 'United States', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    experiences: [],
  } as unknown as PersonProfile;
}
function baseOpp(requiredSkills: string[]): CanonicalOpportunity {
  return {
    id: 'opp-test-1', type: 'job', title: 'Software Engineer', company: 'TestCo',
    description: 'A real remote job.', source: 'curated', sourceId: 'test-1',
    officialUrl: 'https://example.com/test-1', canonicalUrlHash: 'h1', contentHash: 'c1',
    employmentType: 'Full-time', remoteType: 'Worldwide', eligibleCountries: [], excludedCountries: [],
    timezoneRequirements: [], salaryCurrency: 'USD', salaryPeriod: 'unknown',
    requiredSkills, preferredSkills: [], experienceRequirement: '2-3', qualityScore: 70,
    status: 'active', isActive: true, postedAt: '2026-01-01T00:00:00Z', lastVerifiedAt: '2026-01-01T00:00:00Z',
  } as unknown as CanonicalOpportunity;
}

async function run() {
  console.log('='.repeat(78));
  console.log('SHORT-SKILL MATCHING');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. skillMatches() — the full approved decision-table matrix');
  // ==========================================================================
  {
    assert(skillMatches('C', 'React') === false, '"C" / "React" → no match');
    assert(skillMatches('C', 'C') === true, '"C" / "C" → match');
    assert(skillMatches('Go', 'Google') === false, '"Go" / "Google" → no match');
    assert(skillMatches('Go', 'Go') === true, '"Go" / "Go" → match');
    assert(skillMatches('React', 'React.js') === true, '"React" / "React.js" → match (existing tier-3 behavior preserved)');
    assert(skillMatches('SQL', 'PostgreSQL') === false, '"SQL" / "PostgreSQL" → no match (no semantic exception added, per the approved decision)');
    assert(skillMatches('AWS', 'AWS Lambda') === true, '"AWS" / "AWS Lambda" → match (whole-token compound)');
    assert(skillMatches('AWS', 'AWS') === true, '"AWS" / "AWS" → match');
    assert(skillMatches('C', 'C#') === false, '"C" / "C#" → no match (atomic token, explicitly tested — not incidental to the C fix)');
    assert(skillMatches('C', 'C++') === false, '"C" / "C++" → no match (atomic token, explicitly tested)');

    // Reverse-direction equivalents — symmetry.
    assert(skillMatches('React', 'C') === false, 'reverse: "React" / "C" → no match');
    assert(skillMatches('C', 'C') === true, 'reverse: "C" / "C" → match');
    assert(skillMatches('Google', 'Go') === false, 'reverse: "Google" / "Go" → no match');
    assert(skillMatches('React.js', 'React') === true, 'reverse: "React.js" / "React" → match');
    assert(skillMatches('PostgreSQL', 'SQL') === false, 'reverse: "PostgreSQL" / "SQL" → no match');
    assert(skillMatches('AWS Lambda', 'AWS') === true, 'reverse: "AWS Lambda" / "AWS" → match');
    assert(skillMatches('C#', 'C') === false, 'reverse: "C#" / "C" → no match');
    assert(skillMatches('C++', 'C') === false, 'reverse: "C++" / "C" → no match');

    // Case/whitespace normalization.
    assert(skillMatches('  react  ', 'REACT') === true, 'case/whitespace normalization: "  react  " / "REACT" → match');
    assert(skillMatches('  c  ', 'C') === true, 'case/whitespace normalization on a short skill: "  c  " / "C" → match');

    // Existing alias-map behavior (normalizeSkillKey, unmodified) still works.
    assert(skillMatches('golang', 'go') === true, 'existing alias map: "golang" / "go" → match');
    assert(skillMatches('Node.js', 'nodejs') === true, 'existing alias map: "Node.js" / "nodejs" → match');
    assert(skillMatches('node js', 'Node.js') === true, 'existing alias map: "node js" / "Node.js" → match');
    assert(skillMatches('k8s', 'Kubernetes') === true, 'existing alias map: "k8s" / "Kubernetes" → match');

    // The tokenizer generalizes — not hand-fit to the one AWS Lambda example.
    assert(skillMatches('GCP', 'GCP Storage') === true, 'tokenizer generalizes: "GCP" / "GCP Storage" → match');
    assert(skillMatches('GCP', 'GCPStorage') === false, 'no delimiter, no match: "GCP" / "GCPStorage" (fused) → no match');

    // Neither argument, empty/whitespace-only — fails closed, never throws.
    assert(skillMatches('', 'React') === false, 'empty string never matches');
    assert(skillMatches('   ', 'React') === false, 'whitespace-only string never matches');
  }

  // ==========================================================================
  console.log('\n2. STATIC — one shared predicate, no duplicated implementations, engine.ts scope');
  // ==========================================================================
  {
    const engineSrc = readFileSync(join(__dirname, '../src/lib/matching/engine.ts'), 'utf8');
    const ctSrc = readFileSync(join(__dirname, '../src/lib/matching/career-transition.ts'), 'utf8');
    const gapsSrc = readFileSync(join(__dirname, '../src/lib/match/actionable-skill-gaps.ts'), 'utf8');

    assert(!/function\s+skillMatches/.test(ctSrc), 'career-transition.ts no longer defines its own skillMatches()');
    assert(!/function\s+fuzzyMatches/.test(gapsSrc), 'actionable-skill-gaps.ts no longer defines its own fuzzyMatches()');
    assert(engineSrc.includes("from './skill-match'"), 'engine.ts imports the shared predicate');
    assert(ctSrc.includes("from './skill-match'"), 'career-transition.ts imports the shared predicate');
    assert(gapsSrc.includes("from '@/lib/matching/skill-match'"), 'actionable-skill-gaps.ts imports the shared predicate');

    const engineCode = stripLineComments(engineSrc);
    const ctCode = stripLineComments(ctSrc);
    const gapsCode = stripLineComments(gapsSrc);

    const engineSkillMatchCalls = (engineCode.match(/skillMatches\(/g) || []).length;
    assert(engineSkillMatchCalls === 3, `engine.ts calls skillMatches() at exactly its 3 sites (got ${engineSkillMatchCalls})`);
    const ctSkillMatchCalls = (ctCode.match(/skillMatches\(/g) || []).length;
    assert(ctSkillMatchCalls === 2, `career-transition.ts calls skillMatches() at exactly its 2 sites (got ${ctSkillMatchCalls})`);
    const gapsSkillMatchCalls = (gapsCode.match(/skillMatches\(/g) || []).length;
    assert(gapsSkillMatchCalls === 1, `actionable-skill-gaps.ts calls skillMatches() at exactly its 1 site (got ${gapsSkillMatchCalls})`);

    assert(!/\.includes\([a-zA-Z]+\)\s*\|\|\s*[a-zA-Z]+\.includes\(/.test(engineCode), 'engine.ts has no remaining raw two-way substring skill check');

    try {
      const migrationDiff = execSync('git status --porcelain supabase/migrations', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(migrationDiff.trim() === '', `no new/modified migration file (got: ${migrationDiff.trim() || 'none'})`);
    } catch (e: any) {
      skip(`git status check unavailable (${e.message})`);
    }
  }

  // ==========================================================================
  console.log('\n3. REGRESSION — computeScreeningFit (the site that feeds fitScore itself)');
  // ==========================================================================
  {
    const profile = baseProfile(['React']);
    const oppRequiringC = baseOpp(['C']);
    const screening = computeScreeningFit(profile, oppRequiringC);
    assert(!screening.overlapSkills.includes('React'), 'React no longer false-matches a bare "C" requirement in overlapSkills');
    assert(screening.missingSkills.length > 0, '"C" correctly reported as a missing skill, not a false overlap');

    // Sanity: the SAME candidate genuinely matching a real "C" requirement
    // still works — the fix removes the false positive, not real matches.
    const cProfile = baseProfile(['C']);
    const screeningReal = computeScreeningFit(cProfile, oppRequiringC);
    assert(screeningReal.overlapSkills.includes('C'), 'a profile that genuinely lists "C" still matches a "C" requirement');
  }

  // ==========================================================================
  console.log('\n4. REGRESSION — checkHardEligibility (generic-role-title skill-overlap fallback)');
  // ==========================================================================
  {
    const profile = baseProfile(['React']);
    profile.intent!.targetRoles = ['Engineer']; // purely generic title -> skill-overlap fallback path
    const oppRequiringOnlyC = baseOpp(['C']);
    const gate = checkHardEligibility(profile, oppRequiringOnlyC);
    assert(gate.roleRelevant === false, 'a profile with only "React" is no longer falsely marked role-relevant via a bare "C" requirement');
  }

  // ==========================================================================
  console.log('\n5. REGRESSION — generateRuleBasedMatchAnalysis (the exact Match Detail bug that started this audit)');
  // ==========================================================================
  {
    const profile = baseProfile(['React']);
    const oppRequiringC = baseOpp(['C']);
    const analysis = generateRuleBasedMatchAnalysis(profile, oppRequiringC);
    assert(
      !analysis.strengths.some((s) => s.includes('Core capability in C')),
      'no longer produces "Core capability in C (Verified)" for a profile whose only skill is React',
    );
  }

  // ==========================================================================
  console.log('\n6. REGRESSION — L-adjacent-1 deriveSkillMatchSummary().matchedCount');
  // ==========================================================================
  {
    const profile = baseProfile(['React']);
    const oppRequiringC = baseOpp(['C', 'TypeScript']);
    const summary = deriveSkillMatchSummary(profile, oppRequiringC);
    assert(summary.matchedCount === 0, `matchedCount no longer inflated by the false "C" match (got ${summary.matchedCount})`);
    assert(summary.firstMissingSkill === 'C', `firstMissingSkill correctly reports the genuinely-missing "C" (got "${summary.firstMissingSkill}")`);

    // L's own capped display list — byte-identical contract for cases that
    // never involved a short skill (the vast majority of real usage).
    const gaps = deriveActionableSkillGaps(baseProfile(['React']), baseOpp(['TypeScript', 'Node.js', 'PostgreSQL', 'Docker', 'GraphQL', 'AWS']));
    assert(gaps.length === 5, "L's existing capped-at-5 contract for ordinary (non-short) skills is unaffected");
  }

  // ==========================================================================
  console.log('\n7. REGRESSION — K career-transition (covering-skills + generic-role fallback)');
  // ==========================================================================
  {
    const profile = baseProfile(['React']);
    profile.careerDirection = 'change_fields';
    profile.intent!.targetRoles = ['Engineer']; // generic -> skill-overlap fallback in alignedTargetRole
    const oppRequiringC = baseOpp(['C']);
    const isEligible = checkHardEligibility(profile, oppRequiringC).isEligible;
    const transition = classifyCareerTransition(profile, oppRequiringC, isEligible);
    // With only a false "C" match removed and no real overlap, this should
    // not classify as Direct/Transition on the strength of a fabricated
    // skill-covering signal.
    assert(
      transition === null || transition.classification !== 'direct',
      'career-transition no longer treats a false "C" match as covering-skill evidence',
    );
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running skill-match suite:', e); process.exit(1); });
