/**
 * RemoteMatch — C2 demand-gap: one-off measurement runner
 * ==============================================================================
 * Runs measureDemandGap() against the real Supabase project and prints the full
 * result. Writes one demand_gap_snapshots row unless --dry-run is passed.
 *
 * This is the tool used to produce the initial figures in docs/c2-addendum.md.
 * It is read-heavy and idempotent-ish (each run appends one snapshot row).
 *
 * Run:  npx tsx test/demand-measure-run.ts [--dry-run] [--window-days=90]
 */
import { adminClient, hasRequiredEnv } from './helpers/verified-session';
import { measureDemandGap } from '../src/lib/demand/measure';

async function main() {
  if (!hasRequiredEnv()) {
    console.error('Required Supabase env vars are not all set — cannot run.');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const windowArg = process.argv.find((a) => a.startsWith('--window-days='));
  const windowDays = windowArg ? Number(windowArg.split('=')[1]) : undefined;

  const admin = adminClient();
  const result = await measureDemandGap(admin, windowDays ? { windowDays } : undefined);

  console.log('='.repeat(78));
  console.log('C2 DEMAND-GAP MEASUREMENT' + (dryRun ? '  (DRY RUN — not persisted)' : ''));
  console.log('='.repeat(78));
  console.log(`window            : ${result.window_start}  ->  ${result.window_end}`);
  console.log(`constants         : ${result.constants_version}   lexicon: ${result.lexicon_version}`);
  console.log(`signals available : [${result.signals_available.join(', ') || 'NONE'}]  (of 4 — 2 have no server-side source)`);
  console.log(`verified active users        : ${result.verified_active_users}`);
  console.log(`distinct demand patterns     : ${result.distinct_demand_patterns}`);
  console.log(`total demand observations    : ${result.total_demand_observations}`);
  console.log(`  revealed demand (swipes)   : ${result.revealed_demand_observations}`);
  console.log(`  application progression     : ${result.application_progression_observations}`);
  console.log(`  progression unattributable  : ${result.progression_unattributable}`);
  console.log('');
  console.log('(1) STRUCTURAL CRITERIA — do the mechanics have enough data to run the measurement:');
  for (const c of result.adequacy_detail.criteria.filter((x) => x.kind === 'structural')) {
    const mark = c.blocking ? 'BLOCKING' : 'ok      ';
    console.log(`  ${mark}  ${c.name.padEnd(28)} observed=${String(c.observed).padEnd(20)} rule: ${c.rule}${c.detail ? '   — ' + c.detail : ''}`);
  }
  console.log(`  => structurally_measurable = ${result.structurally_measurable}`);
  console.log('');
  console.log('(2) DEFERRED-THRESHOLD METRICS — observed values only; the numeric D3 bar is NOT set in C2:');
  for (const c of result.adequacy_detail.criteria.filter((x) => x.kind === 'deferred_threshold')) {
    console.log(`  ${c.name.padEnd(30)} observed=${String(c.observed).padEnd(20)} threshold: ${c.rule}${c.detail ? '   — ' + c.detail : ''}`);
  }
  console.log(`  => d3_evidence_status = ${result.d3_evidence_status}`);
  console.log('');
  console.log(`METHOD : ${result.adequacy_detail.method}`);
  console.log(`VERDICT: ${result.adequacy_detail.summary}`);
  console.log(`GAP RANKING AUTHORIZED: ${result.gap_ranking_authorized}  (gap_score emitted only when true)`);
  console.log('');
  console.log('RANKED GAPS' + (result.gap_ranking_authorized ? ' (by gap_score)' : ' (gap_score WITHHELD; ordered by observations for diagnostics)'));
  for (const g of result.ranked_gaps.slice(0, 20)) {
    console.log(
      `  ${g.pattern_key.padEnd(52)} obs=${String(g.observations).padStart(3)} users=${String(g.distinct_users).padStart(2)} `
      + `dw=${g.demand_weight.toFixed(2).padStart(7)} active=${String(g.active_supply).padStart(3)} eff=${String(g.effective_supply).padStart(3)} `
      + `gap=${g.gap_score === null ? 'WITHHELD' : g.gap_score.toFixed(3)}`,
    );
  }
  if (result.ranked_gaps.length > 20) console.log(`  ... ${result.ranked_gaps.length - 20} more`);

  if (dryRun) {
    console.log('\n(dry run — no demand_gap_snapshots row written)');
    return;
  }
  const { error } = await admin.from('demand_gap_snapshots').insert({
    computed_at: result.computed_at, window_start: result.window_start, window_end: result.window_end,
    signals_available: result.signals_available, constants_version: result.constants_version,
    lexicon_version: result.lexicon_version, verified_active_users: result.verified_active_users,
    distinct_demand_patterns: result.distinct_demand_patterns,
    total_demand_observations: result.total_demand_observations,
    revealed_demand_observations: result.revealed_demand_observations,
    application_progression_observations: result.application_progression_observations,
    progression_unattributable: result.progression_unattributable,
    dataset_adequate: result.dataset_adequate, adequacy_detail: result.adequacy_detail,
    ranked_gaps: result.ranked_gaps, notes: result.notes,
  });
  if (error) { console.error('\nFAILED to persist snapshot:', error.message); process.exit(1); }
  console.log('\ndemand_gap_snapshots row written.');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
