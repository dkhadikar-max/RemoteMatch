/**
 * N — Behavioral Feed Personalization.
 * ==============================================================================
 *   1. deriveEffectiveDecisions (N6) — rewind collapses the event log to
 *      current state, not raw event count. A passed row superseded by a
 *      rewind contributes nothing — not even a phantom negative.
 *   2. excludeDecidedOpportunities (N3) — unconditional, independent of the
 *      personalization threshold.
 *   3. applyBehavioralPersonalization (N1/N7/N10/N11) — below-threshold is a
 *      byte-identical no-op; at-threshold reorders ONLY (fitScore/fitBadge
 *      untouched on every object); the NUDGE_CAP bound is exact — provably
 *      cannot overcome a >NUDGE_CAP real fitScore gap, and can at exactly the
 *      boundary; boost-only (no negative nudge from 'passed' patterns).
 *   4. Static — engine.ts / pattern.ts zero diff; the module never imports
 *      engine.ts; no new migration; no new API route (same feed route,
 *      extended).
 *
 * Run: npx tsx test/behavioral-personalization-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import type { CanonicalOpportunity } from '../src/types/byn';
import {
  deriveEffectiveDecisions,
  excludeDecidedOpportunities,
  computeLikedPatternCounts,
  behavioralNudgeFor,
  applyBehavioralPersonalization,
  MIN_DECISIONS_FOR_PERSONALIZATION,
  NUDGE_CAP,
  type SwipeRow,
  type EffectiveDecision,
} from '../src/lib/feed/behavioral-personalization';

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

let seq = 0;
function swipe(over: Partial<SwipeRow>): SwipeRow {
  seq += 1;
  return {
    id: over.id ?? `s${seq}`,
    opportunity_id: over.opportunity_id ?? 'opp-a',
    action: over.action ?? 'interested',
    created_at: over.created_at ?? new Date(2026, 0, seq).toISOString(),
    rewound_decision_id: over.rewound_decision_id ?? null,
  };
}

function job(over: Partial<CanonicalOpportunity> & { id: string }): CanonicalOpportunity & { fitScore: number; fitBadge: string } {
  const now = new Date().toISOString();
  return {
    type: 'job', title: 'Software Engineer', company: 'Co', description: 'd',
    source: 'remotive', sourceId: over.id.replace(/^opp-\w+-/, ''), officialUrl: 'https://e.co',
    canonicalUrlHash: 'h', contentHash: 'c', employmentType: 'Full-time', remoteType: 'Worldwide',
    eligibleCountries: [], excludedCountries: [], timezoneRequirements: [], requiredSkills: [],
    preferredSkills: [], qualityScore: 80, status: 'active', isActive: true, postedAt: now, lastVerifiedAt: now,
    fitScore: 70, fitBadge: 'Good Fit',
    ...over,
  } as CanonicalOpportunity & { fitScore: number; fitBadge: string };
}

async function run() {
  console.log('='.repeat(78));
  console.log('N — BEHAVIORAL FEED PERSONALIZATION');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. deriveEffectiveDecisions (N6 — current state, not raw event count)');
  // ==========================================================================
  {
    // interested A, rewind A -> no effective A
    const s1 = swipe({ id: 's1', opportunity_id: 'A', action: 'interested' });
    const r1 = swipe({ id: 'r1', opportunity_id: 'A', action: 'rewind', rewound_decision_id: 's1' });
    const eff1 = deriveEffectiveDecisions([s1, r1]);
    assert(!eff1.has('A'), 'interested(A), rewind(A) -> no effective decision for A');

    // interested A, rewind A, interested A -> interested A
    const s2 = swipe({ id: 's2', opportunity_id: 'A', action: 'interested' });
    const eff2 = deriveEffectiveDecisions([s1, r1, s2]);
    assert(eff2.get('A')?.action === 'interested', 'interested(A), rewind(A), interested(A) -> effective interested(A)');

    // passed A, rewind A, interested A -> interested A (passed contributes NOTHING, not even a phantom negative)
    const p1 = swipe({ id: 'p1', opportunity_id: 'B', action: 'passed' });
    const r2 = swipe({ id: 'r2', opportunity_id: 'B', action: 'rewind', rewound_decision_id: 'p1' });
    const s3 = swipe({ id: 's3', opportunity_id: 'B', action: 'interested' });
    const eff3 = deriveEffectiveDecisions([p1, r2, s3]);
    assert(eff3.get('B')?.action === 'interested', 'passed(B), rewind(B), interested(B) -> effective interested(B)');
    assert(eff3.size === 1, 'exactly one effective decision for B (the passed row is fully superseded)');

    // a decision with no rewind is simply itself
    const p2 = swipe({ id: 'p2', opportunity_id: 'C', action: 'passed' });
    const eff4 = deriveEffectiveDecisions([p2]);
    assert(eff4.get('C')?.action === 'passed', 'an un-rewound passed decision stays effective as passed');

    // out-of-order rows: correctness must not depend on input order
    const eff5 = deriveEffectiveDecisions([s3, s1, r1, s2]);
    assert(!eff5.has('A') === false && eff5.get('A')?.action === 'interested', 'order-independent: A still resolves to the later interested()');
  }

  // ==========================================================================
  console.log('\n2. excludeDecidedOpportunities (N3 — unconditional)');
  // ==========================================================================
  {
    const catalog = [job({ id: 'opp-x-1' }), job({ id: 'opp-x-2' }), job({ id: 'opp-x-3' })];
    const eff = new Map<string, EffectiveDecision>([
      ['opp-x-1', { opportunityId: 'opp-x-1', action: 'interested' }],
    ]);
    const out = excludeDecidedOpportunities(catalog, eff);
    assert(out.length === 2 && !out.some((o) => o.id === 'opp-x-1'), 'a decided job (interested) is excluded');

    const effPassed = new Map<string, EffectiveDecision>([
      ['opp-x-2', { opportunityId: 'opp-x-2', action: 'passed' }],
    ]);
    const out2 = excludeDecidedOpportunities(catalog, effPassed);
    assert(!out2.some((o) => o.id === 'opp-x-2'), 'a decided job (passed) is ALSO excluded (exclusion, unlike the nudge, is action-agnostic)');

    // unconditional: works even with only 1 effective decision, well below the personalization threshold
    assert(1 < MIN_DECISIONS_FOR_PERSONALIZATION, 'sanity: this test is below the personalization threshold');
    const out3 = excludeDecidedOpportunities(catalog, eff);
    assert(out3.length === 2, 'exclusion applies even with just 1 effective decision (independent of the 5-decision gate)');

    assert(excludeDecidedOpportunities(catalog, new Map()) === catalog, 'zero effective decisions -> same array reference returned (no-op)');
  }

  // ==========================================================================
  console.log('\n3. applyBehavioralPersonalization (N1/N7/N10/N11)');
  // ==========================================================================
  {
    // Below threshold: completely unchanged, same reference.
    const catalog = [
      job({ id: 'opp-a-1', fitScore: 80 }),
      job({ id: 'opp-a-2', fitScore: 60 }),
      job({ id: 'opp-a-3', fitScore: 40 }),
    ];
    const fourDecisions = new Map<string, EffectiveDecision>([
      ['x1', { opportunityId: 'x1', action: 'interested' }],
      ['x2', { opportunityId: 'x2', action: 'interested' }],
      ['x3', { opportunityId: 'x3', action: 'interested' }],
      ['x4', { opportunityId: 'x4', action: 'passed' }],
    ]);
    assert(fourDecisions.size === MIN_DECISIONS_FOR_PERSONALIZATION - 1, 'sanity: exactly one below threshold');
    const belowResult = applyBehavioralPersonalization(catalog, fourDecisions);
    assert(
      belowResult.map((o) => o.id).join(',') === catalog.map((o) => o.id).join(',') && belowResult.length === catalog.length,
      'below MIN_DECISIONS_FOR_PERSONALIZATION -> byte-identical order to the pre-N input (N10 no-signal path)',
    );

    assert(
      applyBehavioralPersonalization(catalog, new Map()) === catalog,
      'zero effective decisions -> same array reference (fully short-circuited)',
    );

    // At threshold: liked pattern (software_engineering/mid/worldwide/-/-),
    // SATURATED to NUDGE_CAP with 3 distinct liked jobs sharing that exact
    // pattern (+2 passed, to reach the 5-decision minimum without adding
    // more liked-pattern weight) — every bound proof below relies on the
    // nudge actually reaching its cap, not just being nonzero.
    const likedJobs = [
      job({ id: 'opp-liked-1', title: 'Software Engineer', fitScore: 90 }),
      job({ id: 'opp-liked-2', title: 'Backend Engineer', fitScore: 88 }),
      job({ id: 'opp-liked-3', title: 'Full Stack Engineer', fitScore: 86 }),
    ];
    const fiveDecisions = new Map<string, EffectiveDecision>([
      ['opp-liked-1', { opportunityId: 'opp-liked-1', action: 'interested' }],
      ['opp-liked-2', { opportunityId: 'opp-liked-2', action: 'interested' }],
      ['opp-liked-3', { opportunityId: 'opp-liked-3', action: 'interested' }],
      ['seed-4', { opportunityId: 'seed-4', action: 'passed' }],
      ['seed-5', { opportunityId: 'seed-5', action: 'passed' }],
    ]);
    const candidateSamePattern = job({ id: 'opp-cand-1', title: 'Software Developer', fitScore: 79 });
    const candidateHigherFit = job({ id: 'opp-cand-2', title: 'Product Manager', fitScore: 85 });
    // The 3 liked jobs themselves are EXCLUDED (they're decided) — the
    // candidate pool is what remains, ranked by fitScore + nudge.
    const result = applyBehavioralPersonalization([...likedJobs, candidateHigherFit, candidateSamePattern], fiveDecisions);
    assert(!likedJobs.some((lj) => result.some((r) => r.id === lj.id)), 'none of the already-decided liked jobs reappear in the output');
    assert(
      result.every((o) => o.fitScore === (o.id === 'opp-cand-1' ? 79 : 85)),
      'fitScore is never mutated by personalization',
    );
    assert(
      behavioralNudgeFor(candidateSamePattern, computeLikedPatternCounts(fiveDecisions, [...likedJobs, candidateSamePattern])) === NUDGE_CAP,
      'sanity: this fixture genuinely saturates the nudge at NUDGE_CAP for a matching-pattern candidate',
    );

    // Bound proof: a candidate can NEVER overcome a real fitScore gap > NUDGE_CAP.
    const farBehind = job({ id: 'opp-far-1', title: 'Software Developer', fitScore: 50 }); // same pattern as liked, but 40pt behind an 90-fit rival
    const farAhead = job({ id: 'opp-far-2', title: 'Product Manager', fitScore: 90 });
    const boundResult = applyBehavioralPersonalization([...likedJobs, farBehind, farAhead], fiveDecisions);
    const idx = boundResult.map((o) => o.id);
    assert(
      idx.indexOf('opp-far-2') < idx.indexOf('opp-far-1'),
      `a >NUDGE_CAP real fitScore gap (${90 - 50}pt) can never be overcome by the nudge (order: ${idx.join(',')})`,
    );

    // Exact-boundary proof, part A: a gap of NUDGE_CAP - 1 is small enough to
    // be OVERCOME OUTRIGHT (a genuine reorder, no tie-break involved) — proves
    // the bound is exact, not overly conservative.
    const justUnderLow = job({ id: 'opp-under-1', title: 'Software Developer', fitScore: 80 - (NUDGE_CAP - 1) });
    const justUnderHigh = job({ id: 'opp-under-2', title: 'Product Manager', fitScore: 80 });
    const underResult = applyBehavioralPersonalization([...likedJobs, justUnderHigh, justUnderLow], fiveDecisions);
    const uIdx = underResult.map((o) => o.id);
    assert(
      uIdx.indexOf('opp-under-1') < uIdx.indexOf('opp-under-2'),
      `a (NUDGE_CAP - 1)-point real gap IS overcome outright by the boosted job (order: ${uIdx.join(',')})`,
    );

    // Exact-boundary proof, part B: a gap of EXACTLY NUDGE_CAP produces a
    // tied combined score (low + NUDGE_CAP == high + 0) — this suite documents
    // that ties resolve in favor of the real, frozen fitScore, not the softer
    // behavioral signal, matching the input's already-fitScore-desc order.
    const atBoundLow = job({ id: 'opp-bound-1', title: 'Software Developer', fitScore: 80 - NUDGE_CAP });
    const atBoundHigh = job({ id: 'opp-bound-2', title: 'Product Manager', fitScore: 80 });
    const boundaryResult = applyBehavioralPersonalization([...likedJobs, atBoundHigh, atBoundLow], fiveDecisions);
    const bIdx = boundaryResult.map((o) => o.id);
    assert(
      bIdx.indexOf('opp-bound-2') < bIdx.indexOf('opp-bound-1'),
      `at EXACTLY a NUDGE_CAP-point gap (a tied combined score), the real higher fitScore wins the tie-break (order: ${bIdx.join(',')})`,
    );

    // Boost-only (N11): a heavily-PASSED pattern never produces a negative nudge.
    const passedPatternJob = job({ id: 'opp-passed-1', title: 'Marketing Manager', fitScore: 70 });
    const manyPasses = new Map<string, EffectiveDecision>([
      ['mp1', { opportunityId: 'mp1', action: 'passed' }],
      ['mp2', { opportunityId: 'mp2', action: 'passed' }],
      ['mp3', { opportunityId: 'mp3', action: 'passed' }],
      ['mp4', { opportunityId: 'mp4', action: 'passed' }],
      ['mp5', { opportunityId: 'mp5', action: 'passed' }],
    ]);
    const nudge = behavioralNudgeFor(passedPatternJob, computeLikedPatternCounts(manyPasses, [passedPatternJob]));
    assert(nudge === 0, 'a pattern with only passed (never interested) history gets nudge 0, never negative');

    // Nudge is capped even with many likes of the exact same pattern.
    const manyLikesSamePattern = new Map<string, EffectiveDecision>(
      Array.from({ length: 10 }, (_, i) => [`like${i}`, { opportunityId: `like${i}`, action: 'interested' as const }]),
    );
    const likedCatalog = Array.from({ length: 10 }, (_, i) => job({ id: `like${i}`, title: 'Software Engineer' }));
    const cappedNudge = behavioralNudgeFor(job({ id: 'opp-cap-test', title: 'Software Engineer' }), computeLikedPatternCounts(manyLikesSamePattern, likedCatalog));
    assert(cappedNudge === NUDGE_CAP, `10 matching likes still cap at NUDGE_CAP=${NUDGE_CAP} (got ${cappedNudge})`);
  }

  // ==========================================================================
  console.log('\n4. STATIC — engine.ts/pattern.ts untouched, no new route/migration');
  // ==========================================================================
  {
    const module = readFileSync(join(__dirname, '../src/lib/feed/behavioral-personalization.ts'), 'utf8');
    assert(!module.includes("from '@/lib/matching/engine'"), 'behavioral-personalization.ts never imports engine.ts');
    assert(module.includes("from '@/lib/demand/pattern'"), 'reuses pattern.ts as the ONLY pattern representation');

    const route = readFileSync(join(__dirname, '../src/app/api/opportunities/feed/route.ts'), 'utf8');
    assert(route.includes('applyBehavioralPersonalization'), 'feed route wires the personalization layer');
    // M-adjacent-1 — the feed route now pre-filters cross-provider
    // duplicates (opportunity.supersededByOpportunityId) out of the
    // discoverable set BEFORE scoring, so the scoring call's argument is
    // named `discoverable` rather than the raw `opportunities`. The scoring
    // FUNCTION itself is untouched (engine.ts diff-checked below); only its
    // input set is filtered upstream. Updating this literal string is a
    // regression-guard alignment, not an N behavior change.
    assert(route.includes('scoreOpportunitiesForFeed(profile, discoverable)'), 'v1 scoring call is untouched');

    try {
      const engineDiff = execSync('git diff HEAD -- src/lib/matching/engine.ts', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(engineDiff.trim() === '', 'src/lib/matching/engine.ts has zero uncommitted diff from HEAD');
      const patternDiff = execSync('git diff HEAD -- src/lib/demand/pattern.ts', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(patternDiff.trim() === '', 'src/lib/demand/pattern.ts (C2) has zero uncommitted diff from HEAD — read-only reuse only');
      const migrationDiff = execSync('git status --porcelain supabase/migrations', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(migrationDiff.trim() === '', `no new/modified migration file for N (got: ${migrationDiff.trim() || 'none'})`);
    } catch (e: any) {
      skip(`git diff checks unavailable (${e.message})`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running behavioral-personalization suite:', e); process.exit(1); });
