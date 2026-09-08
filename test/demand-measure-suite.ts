/**
 * RemoteMatch — Demand measurement suite (Additional Supply Discovery, C2)
 * ==============================================================================
 * Part A: PGlite — migration 013 applies on the full chain; demand_gap_snapshots
 *         RLS forced; anon + authenticated denied; service_role allowed.
 * Part B: pure `computeGapTable` — the C2 gap-score invariant (gap_score is
 *         withheld whenever the numeric D3 bar is deferred, i.e. ALWAYS in C2,
 *         even for a structurally-measurable dataset), AMENDMENT 2 (only a
 *         genuine status_changed->applied counts; the raw 'interested'
 *         application row is never a signal), recency decay, effective-supply
 *         discounts.
 *
 * Run: npx tsx test/demand-measure-suite.ts
 */
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';
import {
  computeGapTable, MeasureOppRow, MeasureSwipeRow, MeasureAppliedEvent, C2_CONSTANTS,
} from '../src/lib/demand/measure';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const mig = (n: string) => fs.readFileSync(path.resolve(__dirname, `../supabase/migrations/${n}`), 'utf8');

const NOW = Date.parse('2026-09-08T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const WSTART = daysAgo(90);

function opp(over: Partial<MeasureOppRow>): MeasureOppRow {
  return {
    canonical_id: 'opp-remotive-x', title: 'Senior Backend Engineer', description: null,
    required_skills: [], remote_type: 'Worldwide', eligible_countries: [],
    experience_requirement: null, salary_min: null, salary_currency: null,
    posted_at: daysAgo(5), link_checked_at: daysAgo(2), ...over,
  };
}
function swipe(over: Partial<MeasureSwipeRow>): MeasureSwipeRow {
  return {
    profile_id: 'u1', opportunity_id: 'opp-remotive-x', action: 'interested',
    created_at: daysAgo(3),
    decision_snapshot: { demandPatternKey: 'software_engineering|senior|worldwide|-|-' }, ...over,
  };
}

async function partA() {
  console.log('\nPart A — migration 013 (PGlite):');
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$ LANGUAGE sql STABLE;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon') $$ LANGUAGE sql STABLE;
  `);
  for (const m of ['001_initial_schema.sql', '002_row_level_security.sql', '010_live_supply_catalog.sql',
                   '011_add_salary_period.sql', '012_supply_discovery_registry.sql', '013_demand_gap_table.sql']) {
    await db.exec(mig(m));
  }
  assert(true, 'chain 001->013 applies cleanly');

  const rls = await db.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'demand_gap_snapshots'`);
  const r = rls.rows[0] as { relrowsecurity: boolean; relforcerowsecurity: boolean };
  assert(r.relrowsecurity && r.relforcerowsecurity, 'demand_gap_snapshots: RLS ENABLED + FORCED');

  const tryAs = async (role: string, sql: string) => {
    await db.exec(`SET ROLE ${role}; SET request.jwt.claim.role='${role}';`);
    try { await db.query(sql); return 'ok'; }
    catch { return 'denied'; }
    finally { await db.exec('RESET ROLE;'); }
  };
  assert(await tryAs('anon', `SELECT * FROM demand_gap_snapshots`) === 'denied', 'anon cannot read demand_gap_snapshots');
  assert(await tryAs('authenticated', `SELECT * FROM demand_gap_snapshots`) === 'denied', 'authenticated cannot read demand_gap_snapshots');
  assert(await tryAs('authenticated', `INSERT INTO demand_gap_snapshots DEFAULT VALUES`) === 'denied', 'authenticated cannot write demand_gap_snapshots');
  await db.exec(`RESET ROLE; SET request.jwt.claim.role='service_role';`);
  const svc = await db.query(`INSERT INTO demand_gap_snapshots
    (window_start, window_end, signals_available, constants_version, lexicon_version,
     verified_active_users, distinct_demand_patterns, total_demand_observations,
     revealed_demand_observations, application_progression_observations,
     progression_unattributable, dataset_adequate)
    VALUES (now(), now(), '{}', 'v', 'v', 0,0,0,0,0,0, false) RETURNING id`);
  assert(svc.rows.length === 1, 'service_role can write demand_gap_snapshots');
}

function partB() {
  console.log('\nPart B — computeGapTable (pure):');

  // -- AMENDMENT 2: an application at status='applied' but WITH NO genuine
  //    status_changed->applied event is NOT a progression signal.
  {
    const res = computeGapTable({
      now: NOW, windowStart: WSTART, windowEnd: daysAgo(0),
      activeOpps: [opp({})],
      swipes: [],
      appliedEvents: [
        { application_id: 'a1', profile_id: 'u1', opportunity_id: 'opp-remotive-x', applied_event_at: null },
      ],
      priorPatternKeys: [], hasPriorSnapshots: false, eligibleProfileIds: null,
    });
    assert(res.application_progression_observations === 0, 'applied status w/o a status_changed event -> NOT counted (amendment 2)');
    assert(res.total_demand_observations === 0, '  ...and contributes no demand observation');
  }

  // -- AMENDMENT 2: WITH a genuine event -> counted exactly once.
  {
    const res = computeGapTable({
      now: NOW, windowStart: WSTART, windowEnd: daysAgo(0),
      activeOpps: [opp({})],
      swipes: [swipe({})], // the interested swipe = 1 revealed_demand obs
      appliedEvents: [
        { application_id: 'a1', profile_id: 'u1', opportunity_id: 'opp-remotive-x', applied_event_at: daysAgo(2) },
      ],
      priorPatternKeys: [], hasPriorSnapshots: false, eligibleProfileIds: null,
    });
    assert(res.revealed_demand_observations === 1, 'the interested swipe -> 1 revealed_demand obs');
    assert(res.application_progression_observations === 1, 'the genuine applied event -> exactly 1 progression obs');
    assert(res.total_demand_observations === 2, 'revealed demand + application intent are distinct signals (2 total, not double-counted)');
  }

  // -- C2 GAP-SCORE INVARIANT (round-2): a structurally-INSUFFICIENT dataset ->
  //    every gap_score is null, list not ordered by gap, no shortage claim.
  {
    const res = computeGapTable({
      now: NOW, windowStart: WSTART, windowEnd: daysAgo(0),
      activeOpps: [opp({ canonical_id: 'o1' }), opp({ canonical_id: 'o2', title: 'Junior Designer' })],
      swipes: [swipe({ opportunity_id: 'o1' }), swipe({ profile_id: 'u2', opportunity_id: 'o1' })],
      appliedEvents: [], priorPatternKeys: [], hasPriorSnapshots: false, eligibleProfileIds: null,
    });
    assert(res.structurally_measurable === false, 'first run, thin data -> structurally_measurable: false');
    assert(res.d3_evidence_status === 'deferred', '  ...d3_evidence_status: deferred');
    assert(res.gap_ranking_authorized === false, '  ...gap_ranking_authorized: false');
    assert(res.ranked_gaps.every((g) => g.gap_score === null), '  ...every gap_score is null');
    assert(res.ranked_gaps.every((g) => g.gap_score_status === 'withheld_d3_evidence_bar_deferred'),
      '  ...gap_score_status = withheld_d3_evidence_bar_deferred (D3 deferral is the controlling reason)');
    assert(res.adequacy_detail.summary.includes('gap ranking: WITHHELD'), '  ...summary says gap ranking WITHHELD, not a shortage figure');
    // raw numbers still present for diagnostics
    const seKey = res.ranked_gaps.find((g) => g.pattern_key.startsWith('software_engineering'));
    assert(!!seKey && seKey.demand_weight > 0 && seKey.active_supply === 1, '  ...raw demand_weight / active_supply still persisted');
  }

  // -- C2 GAP-SCORE INVARIANT, the important case: a FULLY structurally-measurable
  //    dataset (prior window, multiple users, recurring pattern, a real applied
  //    event) STILL has gap_score withheld — because the numeric D3 evidence bar
  //    is deferred. Structural measurability alone must NOT unlock a ranking.
  {
    const res = computeGapTable({
      now: NOW, windowStart: WSTART, windowEnd: daysAgo(0),
      activeOpps: [opp({ canonical_id: 'o1' })],
      swipes: [
        swipe({ profile_id: 'u1', opportunity_id: 'o1' }),
        swipe({ profile_id: 'u2', opportunity_id: 'o1' }),
        swipe({ profile_id: 'u3', opportunity_id: 'o1' }),
      ],
      appliedEvents: [
        { application_id: 'a1', profile_id: 'u1', opportunity_id: 'o1', applied_event_at: daysAgo(2) },
      ],
      priorPatternKeys: ['software_engineering|senior|worldwide|-|-'],
      hasPriorSnapshots: true,
      eligibleProfileIds: null,
    });
    assert(res.structurally_measurable === true, 'prior window + signals + patterns -> structurally_measurable: TRUE');
    assert(res.adequacy_detail.structurallyMeasurable === true, '  ...(also on adequacy_detail)');
    assert(res.d3_evidence_status === 'deferred', '  ...but d3_evidence_status is STILL deferred in C2');
    assert(res.gap_ranking_authorized === false, '  ...so gap_ranking_authorized is FALSE');
    assert(res.dataset_adequate === true, '  ...dataset_adequate (=structural) can be true while ranking stays withheld');
    assert(res.ranked_gaps.length > 0 && res.ranked_gaps.every((g) => g.gap_score === null),
      '  ...EVERY gap_score is STILL null');
    assert(res.ranked_gaps.every((g) => g.gap_score_status === 'withheld_d3_evidence_bar_deferred'),
      '  ...gap_score_status = withheld_d3_evidence_bar_deferred');
    assert(res.notes.includes('gap_ranking=WITHHELD'), '  ...notes record the withholding + reason');
  }

  // -- recency: an old observation weighs less than a recent one.
  {
    const recent = computeGapTable({ now: NOW, windowStart: WSTART, windowEnd: daysAgo(0),
      activeOpps: [opp({})], swipes: [swipe({ created_at: daysAgo(1) })], appliedEvents: [], priorPatternKeys: [], hasPriorSnapshots: false, eligibleProfileIds: null });
    const old = computeGapTable({ now: NOW, windowStart: WSTART, windowEnd: daysAgo(0),
      activeOpps: [opp({})], swipes: [swipe({ created_at: daysAgo(75) })], appliedEvents: [], priorPatternKeys: [], hasPriorSnapshots: false, eligibleProfileIds: null });
    const dwRecent = recent.ranked_gaps.find((g) => g.observations > 0)!.demand_weight;
    const dwOld = old.ranked_gaps.find((g) => g.observations > 0)!.demand_weight;
    assert(dwRecent > dwOld, `recent swipe weighs more than an old one (${dwRecent} > ${dwOld})`);
    assert(Math.abs(dwOld - Math.pow(0.5, 75 / C2_CONSTANTS.recencyHalfLifeDays)) < 1e-3, '  ...decay matches 0.5^(age/H) (persisted rounded to 3dp)');
  }

  // -- effective supply: stale rows and already-seen rows are discounted.
  {
    const res = computeGapTable({
      now: NOW, windowStart: WSTART, windowEnd: daysAgo(0),
      activeOpps: [
        opp({ canonical_id: 'fresh' }),
        opp({ canonical_id: 'stale', posted_at: daysAgo(120), link_checked_at: daysAgo(120) }),
        opp({ canonical_id: 'seen' }),
      ],
      swipes: [ swipe({ profile_id: 'u1', opportunity_id: 'seen' }) ], // u1 demanded this key AND swiped 'seen'
      appliedEvents: [], priorPatternKeys: [], hasPriorSnapshots: false, eligibleProfileIds: null,
    });
    const g = res.ranked_gaps.find((x) => x.pattern_key.startsWith('software_engineering'))!;
    assert(g.active_supply === 3, 'active_supply counts all 3 rows');
    assert(g.effective_supply === 1, 'effective_supply discounts the stale row and the already-seen row (3 - 1 - 1 = 1)');
  }
}

async function run() {
  console.log('='.repeat(78));
  console.log('DEMAND MEASUREMENT SUITE (C2)');
  console.log('='.repeat(78));
  await partA();
  partB();
  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}
run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
