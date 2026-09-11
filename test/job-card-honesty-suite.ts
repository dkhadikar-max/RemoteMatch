/**
 * L-adjacent-1 — Job Card's Fabricated `metCount`.
 * ==============================================================================
 * Before: metCount was back-calculated from fitScore (the WHOLE scoring
 *   formula — role alignment, seniority, geography — never actual skill
 *   overlap), and requiredSkills[metCount] was an arbitrary array index
 *   presented as a determined missing skill. Every card, every user,
 *   fabricated both numbers.
 * After: deriveSkillMatchSummary() (a thin, uncapped view over the SAME
 *   fuzzy-match/dedup primitive deriveActionableSkillGaps already used —
 *   never a second matching algorithm) computed page-side from the user's
 *   real profile.skills, attached to each opportunity, and rendered as-is.
 *
 *   1. deriveSkillMatchSummary — the exact cases requested: 0/N, N/N,
 *      1/6+ (proves no 5-item cap leaks into the count), fuzzy matching,
 *      duplicate-requirement dedup, firstMissingSkill genuinely unmatched.
 *   2. deriveActionableSkillGaps (L's existing contract) — byte-identical
 *      behavior after the shared-primitive extraction: still capped at 5,
 *      still deduped.
 *   3. Static — job-card.tsx no longer contains metCount/gapsCount;
 *      fitScore / the `?? 94` fallback line is untouched; engine.ts zero
 *      diff.
 *
 * Run: npx tsx test/job-card-honesty-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import type { CanonicalOpportunity, PersonProfile, ProfileSkill } from '../src/types/byn';
import { deriveActionableSkillGaps, deriveSkillMatchSummary } from '../src/lib/match/actionable-skill-gaps';

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

/** Strips `//`-style line comments before a substring check, so an
 *  explanatory comment mentioning the OLD name (e.g. "replaces the old
 *  metCount") never produces a false-positive failure the way a naive
 *  whole-file `.includes()` would. */
function stripLineComments(src: string): string {
  // [^\r\n]* rather than .*$ — this repo's files are CRLF, and `.` never
  // matches a line terminator (including a lone trailing \r), so a naive
  // `.*$` silently fails to strip anything on a CRLF-ending line.
  return src
    .split('\n')
    .map((line) => line.replace(/\/\/[^\r\n]*/, ''))
    .join('\n');
}

function skill(name: string): ProfileSkill {
  return { id: `s-${name}`, profileId: 'p1', skillName: name, isPrimary: false };
}
function profile(skills: string[]): Pick<PersonProfile, 'skills'> {
  return { skills: skills.map(skill) };
}
function opp(requiredSkills: string[]): Pick<CanonicalOpportunity, 'requiredSkills'> {
  return { requiredSkills };
}

async function run() {
  console.log('='.repeat(78));
  console.log('L-ADJACENT-1 — JOB CARD SKILL-MATCH HONESTY');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. deriveSkillMatchSummary — the requested acceptance cases');
  // ==========================================================================
  {
    // 0 matched / N required
    const s1 = deriveSkillMatchSummary(profile([]), opp(['React', 'TypeScript', 'Node.js']));
    assert(s1.matchedCount === 0 && s1.totalCount === 3, `0 matched / 3 required (got matched=${s1.matchedCount}, total=${s1.totalCount})`);
    assert(s1.firstMissingSkill === 'React', `firstMissingSkill is the first genuine gap (got "${s1.firstMissingSkill}")`);

    // N matched / N required
    const s2 = deriveSkillMatchSummary(profile(['React', 'TypeScript', 'Node.js']), opp(['React', 'TypeScript', 'Node.js']));
    assert(s2.matchedCount === 3 && s2.totalCount === 3, `3 matched / 3 required (got matched=${s2.matchedCount}, total=${s2.totalCount})`);
    assert(s2.firstMissingSkill === null, 'firstMissingSkill is null when fully matched');

    // 1 matched / 6+ required — proves NO five-item cap leaks into the count
    const s3 = deriveSkillMatchSummary(
      profile(['React']),
      opp(['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'Docker', 'GraphQL', 'AWS']),
    );
    assert(s3.totalCount === 7, `totalCount reflects all 7 distinct requirements, NOT capped at 5 (got ${s3.totalCount})`);
    assert(s3.matchedCount === 1, `matchedCount === 1 (got ${s3.matchedCount})`);
    assert(
      deriveActionableSkillGaps(profile(['React']), opp(['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'Docker', 'GraphQL', 'AWS'])).length === 5,
      "sanity: L's OWN display list still caps at 5 (the card's count must NOT inherit that cap)",
    );

    // Fuzzy match — same rule as L/I (case-insensitive, two-way substring)
    const s4 = deriveSkillMatchSummary(profile(['React.js']), opp(['React']));
    assert(s4.matchedCount === 1 && s4.totalCount === 1, '"React.js" on profile covers a "React" requirement (fuzzy match)');

    // Duplicate requirement variants dedupe — a job listing "React"/"REACT"/
    // "react" (pure case variants of the same skill) as 3 separate
    // required-skill entries must count as ONE distinct requirement, not 3
    // (misleading counts otherwise). Uses the SAME normalizeSkillKey rule
    // deriveActionableSkillGaps already relies on — "Node.js"/"node js"/
    // "NODE.JS" also collapse via the explicit alias map; "React.js" does
    // NOT alias to "React" (normalizeSkillKey's alias map is deliberately
    // tiny — see skill-opportunities.ts), so it is correctly its own
    // distinct entry, not a dedup case.
    const s5 = deriveSkillMatchSummary(profile([]), opp(['React', 'REACT', 'react']));
    assert(s5.totalCount === 1, `pure case variants of one requirement collapse to 1 distinct entry (got ${s5.totalCount})`);
    const s5b = deriveSkillMatchSummary(profile([]), opp(['Node.js', 'node js', 'NODE.JS']));
    assert(s5b.totalCount === 1, `the tiny explicit alias map (node.js/"node js") also collapses to 1 (got ${s5b.totalCount})`);
    const s5c = deriveSkillMatchSummary(profile([]), opp(['React', 'React.js']));
    assert(s5c.totalCount === 2, '"React" and "React.js" are correctly NOT aliased to each other (the alias map is deliberately tiny)');

    // firstMissingSkill is genuinely unmatched — never a skill the profile has
    const s6 = deriveSkillMatchSummary(profile(['SQL']), opp(['SQL', 'Python']));
    assert(s6.firstMissingSkill === 'Python', `firstMissingSkill ("${s6.firstMissingSkill}") is never a skill the profile actually has`);

    // Never mutates inputs
    const p = profile(['React']);
    const before = JSON.stringify(p);
    deriveSkillMatchSummary(p, opp(['React', 'TypeScript']));
    assert(JSON.stringify(p) === before, 'profile is never mutated');
  }

  // ==========================================================================
  console.log("\n2. deriveActionableSkillGaps — L's existing contract, byte-identical after the extraction");
  // ==========================================================================
  {
    const p = profile(['React']);
    const o = opp(['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'Docker', 'GraphQL', 'AWS']);
    const gaps = deriveActionableSkillGaps(p, o);
    assert(gaps.length === 5, `still capped at 5 (got ${gaps.length})`);
    assert(!gaps.some((g) => g.skill === 'React'), 'a matched skill is never returned as a gap');
    assert(gaps.every((g, i, arr) => arr.findIndex((x) => x.skillKey === g.skillKey) === i), 'still deduped by skillKey');
  }

  // ==========================================================================
  console.log('\n3. STATIC — fabrication removed, fitScore fallback untouched, engine.ts untouched');
  // ==========================================================================
  {
    const card = readFileSync(join(__dirname, '../src/components/feed/job-card.tsx'), 'utf8');
    const cardCode = stripLineComments(card); // explanatory comments may legitimately name the OLD identifiers
    assert(!cardCode.includes('metCount'), 'job-card.tsx no longer contains metCount as CODE (comments mentioning the old name for context are fine)');
    assert(!cardCode.includes('gapsCount'), 'job-card.tsx no longer contains the dead gapsCount variable as CODE');
    assert(card.includes('opportunity.fitScore ?? 94'), 'the fitScore ?? 94 fallback is UNTOUCHED — explicitly out of this ticket\'s scope');
    assert(!cardCode.includes('deriveSkillMatchSummary'), 'job-card.tsx does not compute the summary itself — it only reads the already-attached fields (page-side computation, per the approved design)');
    assert(card.includes('skillsMatchedCount') && card.includes('firstMissingSkill'), 'job-card.tsx reads the real, page-attached skill-match fields');

    const feedPage = readFileSync(join(__dirname, '../src/app/feed/page.tsx'), 'utf8');
    assert(feedPage.includes('deriveSkillMatchSummary'), 'feed/page.tsx computes the summary page-side, using the real profile');

    // Regression guard for a real bug caught by the live browser gate:
    // deriveSkillMatchSummary() returns {matchedCount, totalCount,
    // firstMissingSkill} (per the approved contract) but CanonicalOpportunity
    // declares {skillsMatchedCount, skillsTotalCount, firstMissingSkill}. A
    // bare `{ ...opp, ...deriveSkillMatchSummary(...) }` spread silently sets
    // the WRONG field names (matchedCount/totalCount, which nothing reads),
    // leaving skillsMatchedCount/skillsTotalCount permanently undefined —
    // job-card.tsx then silently falls back to "N skills required for this
    // role" for every card while firstMissingSkill (whose name happens to
    // match) looks correct, masking the bug. feed/page.tsx must map the
    // fields explicitly instead of spreading the summary object raw.
    assert(!feedPage.includes('...deriveSkillMatchSummary('), 'feed/page.tsx does NOT bare-spread deriveSkillMatchSummary()\'s return (that silently mismatches field names — see comment above)');
    assert(
      feedPage.includes('skillsMatchedCount: summary.matchedCount') && feedPage.includes('skillsTotalCount: summary.totalCount'),
      'feed/page.tsx explicitly maps matchedCount/totalCount onto CanonicalOpportunity\'s declared skillsMatchedCount/skillsTotalCount field names',
    );

    const gapsFile = readFileSync(join(__dirname, '../src/lib/match/actionable-skill-gaps.ts'), 'utf8');
    assert(!gapsFile.includes("from '@/lib/matching/engine'"), 'actionable-skill-gaps.ts still never imports engine.ts');

    try {
      const engineDiff = execSync('git diff HEAD -- src/lib/matching/engine.ts', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(engineDiff.trim() === '', 'src/lib/matching/engine.ts has zero uncommitted diff from HEAD');
    } catch (e: any) {
      skip(`git diff check unavailable (${e.message})`);
    }
    try {
      const migrationDiff = execSync('git status --porcelain supabase/migrations', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(migrationDiff.trim() === '', `no new/modified migration file (got: ${migrationDiff.trim() || 'none'})`);
    } catch (e: any) {
      skip(`git status check unavailable (${e.message})`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running job-card-honesty suite:', e); process.exit(1); });
