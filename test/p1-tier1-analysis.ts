/**
 * RemoteMatch — P1 Job-Quality Intelligence: Tier 1 exploratory analysis
 * ==============================================================================
 * Per the approved P1 scoping document. This is a REPORTING tool, not a
 * pass/fail test — it produces evidence, it does not gate a build. Re-run
 * this periodically as production outcome data accumulates.
 *
 * What this does NOT do, by the P1 contract:
 *   - No product action of any kind, regardless of what it finds.
 *   - No conclusion above Tier 1 (see the evidence ladder) — a bucket
 *     crossing N>=30 here is "worth continued observation," nothing more.
 *   - No p-value / significance claim — deliberately not computed, per
 *     the scoping document's reasoning about sparse-data signal hunting.
 *   - No comparison of a below-threshold bucket's rate against anything.
 *     A bucket with N < TIER1_MIN_PER_BUCKET is observationally
 *     insufficient — its raw counts are shown, but its rate is NOT a
 *     Tier 1 finding and must never be read side-by-side with a bucket
 *     that does meet the threshold (a "2/17 = 11.8%" bucket is not
 *     comparable to a "9/40 = 22.5%" one just because both are numbers).
 *   - `quality_score` / `computeQualityScore()` are deliberately excluded
 *     from this experiment, even though the value already exists —
 *     including it would blur which specific observable attributes are
 *     under evaluation and risk smuggling the existing heuristic into an
 *     exercise meant to evaluate candidate attributes on their own.
 *
 * For every bucket, per the mandatory reporting requirement: denominator,
 * raw counts, conversion rates, AND source composition — so a result is
 * never read as an attribute effect when it might just be provider mix.
 *
 * The report also always states: total eligible applications, records
 * excluded for missing data, the observation window (earliest/latest
 * decision in the dataset), and how many archived applications had their
 * historical interview/offer outcome reconstructed from event history
 * (i.e. would have been undercounted by looking at current status alone).
 *
 * Run: npx tsx test/p1-tier1-analysis.ts
 * (reads whichever Supabase project NEXT_PUBLIC_SUPABASE_URL points at —
 * point your env at production to analyze production data.)
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TIER1_MIN_PER_BUCKET = 30;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.log('Missing required Supabase env vars — cannot run this analysis.');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

interface SwipeRow {
  opportunity_id: string;
  profile_id: string;
  decision_snapshot: {
    salaryDisclosed?: boolean;
    postingAgeDaysAtDecision?: number;
    remoteScopeExplicit?: 'explicit_worldwide' | 'explicit_restricted' | 'unknown';
    jobSource?: string;
    decisionTimestamp?: string;
  } | null;
}

interface DatasetRow {
  salaryDisclosed: boolean;
  postingAgeDaysAtDecision: number;
  remoteScopeExplicit: string;
  jobSource: string | undefined;
  decisionTimestamp: string | undefined;
  currentStatus: string;
  reachedInterview: boolean;
  reachedOffer: boolean;
  /** True if currentStatus alone (e.g. 'archived') would have missed an
   *  interview/offer this application actually reached at some point. */
  outcomeReconstructedFromHistory: boolean;
}

/** Supabase/PostgREST caps an unpaginated select at 1000 rows by default —
 *  silently, not as an error. At this session's own accumulated test-data
 *  volume (400+ application rows) that ceiling is already within reach,
 *  and a script whose whole purpose is reporting accurate denominators
 *  must never silently under-count because of it. */
async function fetchAllRows<T>(table: string, build: (query: any) => any): Promise<T[]> {
  const PAGE_SIZE = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await build(admin.from(table)).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read ${table} (rows ${from}-${from + PAGE_SIZE - 1}): ${error.message}`);
    all.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function fetchDataset(): Promise<{ dataset: DatasetRow[]; totalSwipesSeen: number; excludedForMissingData: number }> {
  // Every right-swipe with a decision snapshot — this is the full
  // population any P1 bucket is drawn from.
  const swipes = await fetchAllRows<SwipeRow>('swipes', (q) =>
    q.select('profile_id, opportunity_id, decision_snapshot').eq('action', 'interested')
  );

  const applications = await fetchAllRows<{ id: string; profile_id: string; opportunity_id: string; status: string }>(
    'applications',
    (q) => q.select('id, profile_id, opportunity_id, status')
  );

  const appByKey = new Map(applications.map((a) => [`${a.profile_id}:${a.opportunity_id}`, a]));

  // Whether an application ever reached interview/offer must be read from
  // its full event history, not just its current status — an application
  // that reached "interview" and was later archived would otherwise be
  // undercounted, exactly the failure mode get_application_outcome() (P0)
  // exists to prevent. Same principle, applied here directly against the
  // event log rather than via that RPC, since we need it for every
  // application in the dataset at once rather than one at a time.
  const applicationIds = applications.map((a) => a.id);
  const everReachedByAppId = new Map<string, { interview: boolean; offer: boolean }>();
  // Batched rather than one `.in()` call with every id — at any
  // nontrivial scale (this repo's own test data alone reached 400+
  // application rows), a single `.in()` with all ids builds a query
  // string long enough to fail outright at the network layer before ever
  // reaching Postgres. This is exactly the kind of thing this script
  // needs to keep working through as real production volume grows.
  const APPLICATION_ID_BATCH_SIZE = 150;
  for (let i = 0; i < applicationIds.length; i += APPLICATION_ID_BATCH_SIZE) {
    const batch = applicationIds.slice(i, i + APPLICATION_ID_BATCH_SIZE);
    const { data: events, error: eventsErr } = await admin
      .from('application_events')
      .select('application_id, event_type, event_payload')
      .eq('event_type', 'status_changed')
      .in('application_id', batch);
    if (eventsErr) throw new Error(`Could not read application_events (batch starting at ${i}): ${eventsErr.message}`);
    for (const e of events ?? []) {
      const toStatus = (e.event_payload as { toStatus?: string } | null)?.toStatus;
      const entry = everReachedByAppId.get(e.application_id) ?? { interview: false, offer: false };
      if (toStatus === 'interview') entry.interview = true;
      if (toStatus === 'offer') entry.offer = true;
      everReachedByAppId.set(e.application_id, entry);
    }
  }

  const dataset: DatasetRow[] = [];
  let excludedForMissingData = 0;
  const totalSwipesSeen = swipes.length;

  for (const s of swipes) {
    const snap = s.decision_snapshot;
    // Only include swipes that actually carry the P1 fields — older
    // swipes (before this instrumentation shipped) legitimately don't,
    // and must not be silently treated as "false"/"unknown" for these
    // attributes. They're excluded from analysis, not defaulted.
    if (!snap || snap.salaryDisclosed === undefined || snap.postingAgeDaysAtDecision === undefined) {
      excludedForMissingData++;
      continue;
    }

    const app = appByKey.get(`${s.profile_id}:${s.opportunity_id}`);
    if (!app) {
      excludedForMissingData++;
      continue;
    }
    const everReached = everReachedByAppId.get(app.id) ?? { interview: false, offer: false };
    const reachedInterview = everReached.interview || everReached.offer;
    const reachedOffer = everReached.offer;
    // Would current-status-only inspection have missed this? Only
    // meaningful to flag when the current status itself doesn't already
    // show interview/offer directly.
    const currentStatusShowsIt = app.status === 'interview' || app.status === 'offer';
    const outcomeReconstructedFromHistory = (reachedInterview || reachedOffer) && !currentStatusShowsIt;

    dataset.push({
      salaryDisclosed: snap.salaryDisclosed,
      postingAgeDaysAtDecision: snap.postingAgeDaysAtDecision,
      remoteScopeExplicit: snap.remoteScopeExplicit ?? 'unknown',
      jobSource: snap.jobSource,
      decisionTimestamp: snap.decisionTimestamp,
      currentStatus: app.status,
      reachedInterview,
      reachedOffer,
      outcomeReconstructedFromHistory,
    });
  }

  return { dataset, totalSwipesSeen, excludedForMissingData };
}

function sourceComposition(rows: Array<{ jobSource?: string }>): string {
  const total = rows.length;
  if (total === 0) return '(no rows)';
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.jobSource ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([source, count]) => `${source} ${((count / total) * 100).toFixed(0)}%`)
    .join(', ');
}

function reportBucket(label: string, rows: DatasetRow[]) {
  const n = rows.length;
  const interviewCount = rows.filter((r) => r.reachedInterview).length;
  const offerCount = rows.filter((r) => r.reachedOffer).length;
  const meetsT1 = n >= TIER1_MIN_PER_BUCKET;

  console.log(`  ${label}`);
  if (!meetsT1) {
    // Deliberately does NOT print a percentage on the same line as a
    // qualifying bucket's — raw counts only, with an explicit statement
    // that this is not a comparable rate, per the evidence-ladder gate.
    console.log(`    N = ${n} — INSUFFICIENT (Tier 1 requires N >= ${TIER1_MIN_PER_BUCKET})`);
    console.log(`    raw counts only, NOT a Tier 1 finding, NOT comparable to any other bucket: interview ${interviewCount}/${n}, offer ${offerCount}/${n}`);
    console.log(`    source composition: ${sourceComposition(rows)}`);
    return;
  }

  const interviewRate = (interviewCount / n) * 100;
  const offerRate = (offerCount / n) * 100;
  console.log(`    N = ${n} — meets Tier 1 threshold (exploratory finding, not yet an evidence candidate — see the evidence ladder)`);
  console.log(`    interview rate: ${interviewCount}/${n} = ${interviewRate.toFixed(1)}%`);
  console.log(`    offer rate:     ${offerCount}/${n} = ${offerRate.toFixed(1)}%`);
  console.log(`    source composition: ${sourceComposition(rows)}`);
}

async function main() {
  console.log('='.repeat(78));
  console.log('P1 TIER 1 EXPLORATORY ANALYSIS — Job-Quality Intelligence');
  console.log(`Project: ${SUPABASE_URL}`);
  console.log('='.repeat(78));
  console.log(
    '\nThis is exploratory reporting only, per the approved P1 scoping document.\n' +
    'No result here authorizes any product change, and a correlation appearing\n' +
    'here is not validation of anything — the evidence ladder in the signed\n' +
    'spec is the gate, not this script\'s output.\n'
  );

  const { dataset, totalSwipesSeen, excludedForMissingData } = await fetchDataset();

  const timestamps = dataset
    .map((d) => d.decisionTimestamp)
    .filter((t): t is string => Boolean(t))
    .sort();
  const windowStart = timestamps[0] ?? '(none)';
  const windowEnd = timestamps[timestamps.length - 1] ?? '(none)';
  const reconstructedCount = dataset.filter((d) => d.outcomeReconstructedFromHistory).length;

  console.log('--- Dataset summary ---');
  console.log(`  Total right-swipes examined:              ${totalSwipesSeen}`);
  console.log(`  Excluded (missing P1 instrumentation):    ${excludedForMissingData}`);
  console.log(`  Total eligible applications in analysis:  ${dataset.length}`);
  console.log(`  Observation window:                       ${windowStart}  to  ${windowEnd}`);
  console.log(`  Archived applications with reconstructed  ${reconstructedCount}`);
  console.log(`  historical interview/offer outcome:`);

  if (dataset.length === 0) {
    console.log('\nNo instrumented data yet — this is expected immediately after deploy.');
    console.log('Re-run this script after production traffic accumulates.');
    return;
  }

  console.log('\n--- salary_disclosed ---');
  reportBucket('disclosed = true', dataset.filter((d) => d.salaryDisclosed === true));
  reportBucket('disclosed = false', dataset.filter((d) => d.salaryDisclosed === false));

  console.log('\n--- posting_age_days_at_decision ---');
  reportBucket('0-7 days', dataset.filter((d) => d.postingAgeDaysAtDecision >= 0 && d.postingAgeDaysAtDecision <= 7));
  reportBucket('8-30 days', dataset.filter((d) => d.postingAgeDaysAtDecision > 7 && d.postingAgeDaysAtDecision <= 30));
  reportBucket('31-60 days', dataset.filter((d) => d.postingAgeDaysAtDecision > 30 && d.postingAgeDaysAtDecision <= 60));
  reportBucket('60+ days', dataset.filter((d) => d.postingAgeDaysAtDecision > 60));

  console.log('\n--- remote_scope_explicit ---');
  reportBucket('explicit_worldwide', dataset.filter((d) => d.remoteScopeExplicit === 'explicit_worldwide'));
  reportBucket('explicit_restricted', dataset.filter((d) => d.remoteScopeExplicit === 'explicit_restricted'));
  reportBucket('unknown', dataset.filter((d) => d.remoteScopeExplicit === 'unknown'));

  console.log('\n' + '='.repeat(78));
  console.log('End of Tier 1 report. No conclusions drawn; no action implied.');
  console.log('An apparent correlation here is not evidence — see the signed P1');
  console.log('evidence ladder (Tier 2 requires N>=100/bucket, replication across');
  console.log('two non-overlapping windows, and a source/confound check).');
  console.log('='.repeat(78));
}

main().catch((err) => {
  console.error('Fatal error running P1 Tier 1 analysis:', err);
  process.exit(1);
});
