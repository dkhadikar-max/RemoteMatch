/**
 * RemoteMatch — Dataset-adequacy assessment suite (Additional Supply Discovery, C2)
 * ==============================================================================
 * Pure. The assessment answers TWO independent questions and never collapses
 * them:
 *   (1) structurallyMeasurable — facts only, no invented number.
 *   (2) d3EvidenceStatus       — ALWAYS 'deferred' in C2 (spec §5/§17).
 * gapRankingAuthorized = (1) && (2)==='authorized'  — ALWAYS false in C2.
 *
 * The invariant under test: no derived+approved D3 thresholds -> gap ranking is
 * never authorized, even for a structurally-measurable dataset.
 *
 * Run: npx tsx test/demand-adequacy-suite.ts
 */
import * as adequacyModule from '../src/lib/demand/adequacy';
import { assessDatasetAdequacy, DEFERRED_D3_THRESHOLD_METRICS, AdequacyInput } from '../src/lib/demand/adequacy';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** A structurally-measurable input, to mutate one structural fact at a time. */
function measurable(): AdequacyInput {
  return {
    totalDemandObservations: 12,
    verifiedActiveUsers: 5,
    distinctPatterns: 3,
    patterns: [{ pattern_key: 'software_engineering|senior|worldwide|-|-', observations: 8, distinct_users: 4, active_supply: 10 }],
    recurringPatterns: 2,
    signalsAvailable: ['revealed_demand', 'application_progression'],
    hasPriorSnapshots: true,
  };
}

console.log('='.repeat(78));
console.log('DATASET-ADEQUACY ASSESSMENT SUITE (C2 — structural vs. deferred D3 bar)');
console.log('='.repeat(78) + '\n');

// --- no invented numeric D3 thresholds anywhere ---
console.log('no hard-coded D3 thresholds:');
assert(!('ADEQUACY_THRESHOLDS' in adequacyModule), 'adequacy.ts exports NO ADEQUACY_THRESHOLDS');
assert(Array.isArray(DEFERRED_D3_THRESHOLD_METRICS) && DEFERRED_D3_THRESHOLD_METRICS.length > 0,
  'DEFERRED_D3_THRESHOLD_METRICS lists the metrics whose thresholds are deferred');
{
  const r = assessDatasetAdequacy(measurable());
  const deferred = r.criteria.filter((c) => c.kind === 'deferred_threshold');
  assert(deferred.length === DEFERRED_D3_THRESHOLD_METRICS.length, 'every deferred metric appears as a criterion');
  assert(deferred.every((c) => c.blocking === null && c.rule === 'deferred'),
    'deferred criteria: blocking=null, rule="deferred" — never a gate');
  assert(deferred.every((c) => typeof c.observed === 'number' || typeof c.observed === 'string'),
    'deferred criteria still REPORT the observed value (for later derivation)');
  assert(r.method.includes('DEFERRED') && r.method.toLowerCase().includes('not be read as a d3 authorization'),
    'result.method states the D3 bar is deferred and this is not a D3 authorization');
}

// --- THE INVARIANT: structural measurability never unlocks a ranking on its own
console.log('\nD3 bar is deferred -> gap ranking is never authorized:');
{
  const r = assessDatasetAdequacy(measurable());
  assert(r.structurallyMeasurable === true, 'clean input -> structurallyMeasurable: true');
  assert(r.d3EvidenceStatus === 'deferred', '  ...d3EvidenceStatus: "deferred" (C2 never advances it)');
  assert(r.gapRankingAuthorized === false, '  ...gapRankingAuthorized: FALSE despite being structurally measurable');
  assert(r.summary.includes('structural adequacy: MEASURABLE'), '  ...summary line 1: structural adequacy MEASURABLE');
  assert(r.summary.includes('D3 evidence bar: deferred'), '  ...summary line 2: D3 evidence bar deferred');
  assert(r.summary.includes('gap ranking: WITHHELD'), '  ...summary line 3: gap ranking WITHHELD');
}

// --- each STRUCTURAL blocker, one at a time -> structurallyMeasurable false ---
console.log('\nstructural blockers:');
for (const [label, mutate] of [
  ['no demand signal at all', (i: AdequacyInput) => { i.totalDemandObservations = 0; }],
  ['no signal source has data', (i: AdequacyInput) => { i.signalsAvailable = []; }],
  ['no patterns to rank', (i: AdequacyInput) => { i.distinctPatterns = 0; }],
  ['recurrence not measurable (first run)', (i: AdequacyInput) => { i.hasPriorSnapshots = false; }],
] as const) {
  const input = measurable();
  mutate(input);
  const r = assessDatasetAdequacy(input);
  assert(r.structurallyMeasurable === false, `${label} -> structurallyMeasurable: false`);
  assert(r.criteria.some((c) => c.kind === 'structural' && c.blocking === true), `  ...a structural criterion is blocking`);
  assert(r.gapRankingAuthorized === false, `  ...gapRankingAuthorized still false`);
  assert(r.summary.startsWith('structural adequacy: INSUFFICIENT'), `  ...summary line 1: INSUFFICIENT`);
}

// a deferred metric being low must NOT change structural measurability
{
  const input = measurable();
  input.verifiedActiveUsers = 0;
  input.patterns[0].observations = 0;
  input.patterns[0].distinct_users = 0;
  const r = assessDatasetAdequacy(input);
  assert(r.structurallyMeasurable === true, 'low verified_active_users / observations alone -> STILL structurally measurable');
  assert(r.gapRankingAuthorized === false, '  ...and gap ranking still not authorized');
}

// --- production-like: everything zero -> not measurable, multiple structural blockers ---
{
  const r = assessDatasetAdequacy({
    totalDemandObservations: 0, verifiedActiveUsers: 0, distinctPatterns: 0,
    patterns: [], recurringPatterns: 0, signalsAvailable: [], hasPriorSnapshots: false,
  });
  assert(r.structurallyMeasurable === false, 'production-like (all zero) -> not structurally measurable');
  assert(r.gapRankingAuthorized === false, '  ...gap ranking not authorized');
  const blocking = r.criteria.filter((c) => c.kind === 'structural' && c.blocking === true).map((c) => c.name);
  assert(blocking.length >= 3, `  ...multiple structural blockers (${blocking.join(', ')})`);
  assert(r.summary.includes('gap ranking: WITHHELD'), '  ...summary: gap ranking WITHHELD');
  assert(r.criteria.find((c) => c.name === 'has_a_demand_signal_source')?.detail?.includes('active_user_requirement') ?? false,
    '  ...names the architecturally-absent signal sources');
}

console.log('\n' + '='.repeat(78));
console.log(`${passed} passed, ${failed} failed.`);
console.log('='.repeat(78));
if (failed > 0) process.exitCode = 1;
