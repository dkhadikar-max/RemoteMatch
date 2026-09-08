/**
 * RemoteMatch — Live Supply Activation: catalog lifecycle suite
 * ==============================================================================
 * Tests the exact sequences the signed v2 spec review required, using
 * syncOpportunitiesToCatalog()'s test-only fetchResult injection point to
 * drive deterministic provider-success/failure/absence scenarios — this
 * suite does NOT depend on live Remotive/Arbeitnow/Jobicy network behavior
 * for its assertions (unlike gate2-live-supply.ts and seo-audit.ts, which
 * deliberately do exercise the real providers).
 *
 * Every synthetic job uses a source_id prefixed "livesupply-test-" and is
 * passed with the matching absenceScanSourceIdPrefix option — without that,
 * the absence-scan (correctly, in production) considers every active row
 * for a source, which would mean a tiny injected job list incorrectly
 * marks every unrelated REAL active row for that source as absent too. See
 * that option's own doc comment in catalog-sync.ts. Each section cleans up
 * its own rows immediately, before the next section runs, so sections can
 * never see or affect each other's absence counters.
 *
 * Uses real HTTP link checks against example.com for both cases — its root
 * for "reachable" and a deliberately nonexistent path under the same
 * domain for "unreachable" (a real 404, verified independently of DNS/TLS
 * reachability to the domain itself). An earlier version used a separate
 * third-party endpoint (httpstat.us/404) for the unreachable case, but that
 * host timed out from this environment's network (confirmed via a direct
 * curl: connection timeout, while example.com and other domains resolved
 * fine) — verifyLinkFreshness() fails OPEN on a timeout/network error by
 * design (see pipeline.ts), so an unreachable *test host* silently produced
 * a false "active" pass/fail signal having nothing to do with the code
 * under test. Pinning both cases to one already-known-reachable domain
 * removes that external dependency entirely. That part is real network
 * I/O, but the provider-layer success/failure/absence behavior around it is
 * fully controlled.
 *
 * Run: npx tsx test/live-supply-suite.ts
 */
// Test-environment-only: Node 20 has no native WebSocket global, which
// @supabase/realtime-js's client-construction path requires (it checks
// globalThis.WebSocket before falling back to needing an explicit
// transport option — see node_modules/@supabase/realtime-js's
// websocket-factory). syncOpportunitiesToCatalog() calls the shared
// production getSupabaseAdminClient() (src/lib/supabase/admin.ts)
// directly, same as it does in the real app, so that helper is
// deliberately NOT modified for this — this polyfill only affects this
// test process's global scope, before any Supabase client is constructed.
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import { syncOpportunitiesToCatalog, ProviderFetchResult } from '../src/lib/ingestion/catalog-sync';
import { RawJobPayload } from '../src/lib/providers/types';
import { hasRequiredEnv, adminClient } from './helpers/verified-session';

const REACHABLE_URL = 'https://example.com';
const UNREACHABLE_URL = 'https://example.com/this-path-does-not-exist-livesupply-test-404';
const TEST_PREFIX = 'livesupply-test-';
const SYNC_OPTIONS = { absenceScanSourceIdPrefix: TEST_PREFIX };

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function uniqueSourceId(label: string): string {
  return `${TEST_PREFIX}${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeJob(overrides: Partial<RawJobPayload> & { sourceId: string }): RawJobPayload {
  return {
    source: 'remotive',
    title: 'Test Engineer',
    company: 'Test Co',
    description: 'A'.repeat(150), // clears the weak-description threshold
    officialUrl: REACHABLE_URL,
    jobType: 'Full-time',
    publicationDate: new Date().toISOString(),
    ...overrides,
  };
}

function fetchResultFor(jobsBySource: Record<string, RawJobPayload[] | 'fail'>): ProviderFetchResult {
  const outcomes = Object.entries(jobsBySource).map(([sourceKey, jobs]) => ({
    sourceKey,
    success: jobs !== 'fail',
    jobCount: jobs === 'fail' ? 0 : jobs.length,
    ...(jobs === 'fail' ? { error: 'synthetic test failure' } : {}),
  }));
  const successfulRaw = new Map<string, RawJobPayload[]>();
  for (const [sourceKey, jobs] of Object.entries(jobsBySource)) {
    if (jobs !== 'fail') successfulRaw.set(sourceKey, jobs);
  }
  return { outcomes, successfulRaw };
}

async function getRow(source: string, sourceId: string) {
  const admin = adminClient();
  const { data } = await admin
    .from('opportunities')
    .select('id, status, link_reachable, consecutive_absences, is_permanently_removed')
    .eq('source', source)
    .eq('source_id', sourceId)
    .maybeSingle();
  return data as { id: string; status: string; link_reachable: boolean | null; consecutive_absences: number; is_permanently_removed: boolean } | null;
}

async function cleanup(...keys: Array<[string, string]>) {
  const admin = adminClient();
  for (const [source, sourceId] of keys) {
    await admin.from('opportunities').delete().eq('source', source).eq('source_id', sourceId);
  }
}

async function run() {
  console.log('='.repeat(78));
  console.log('LIVE SUPPLY ACTIVATION — CATALOG LIFECYCLE SUITE');
  console.log('='.repeat(78));

  if (!hasRequiredEnv()) {
    console.log('Required Supabase env vars are not all set — cannot run this suite.');
    process.exitCode = 1;
    return;
  }

  // ----------------------------------------------------------------------
  // 1. New job, reachable link -> unknown resolves to active immediately
  // ----------------------------------------------------------------------
  console.log('\n1. NEW JOB, REACHABLE LINK -> active (not deferred to a later cycle)');
  {
    const id = uniqueSourceId('active');
    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: [makeJob({ sourceId: id, officialUrl: REACHABLE_URL })] }), SYNC_OPTIONS);
    const row = await getRow('remotive', id);
    assert(row?.status === 'active', `New job with a reachable link resolves directly to active (got ${row?.status})`);
    assert(row?.link_reachable === true, 'link_reachable recorded as true');
    await cleanup(['remotive', id]);
  }

  // ----------------------------------------------------------------------
  // 2. New job, unreachable link -> unknown resolves to expired immediately
  // ----------------------------------------------------------------------
  console.log('\n2. NEW JOB, UNREACHABLE LINK -> expired immediately (never passes through active)');
  {
    const id = uniqueSourceId('expired');
    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: [makeJob({ sourceId: id, officialUrl: UNREACHABLE_URL })] }), SYNC_OPTIONS);
    const row = await getRow('remotive', id);
    assert(row?.status === 'expired', `New job with an unreachable link resolves directly to expired (got ${row?.status})`);
    assert(row?.link_reachable === false, 'link_reachable recorded as false');
    await cleanup(['remotive', id]);
  }

  // ----------------------------------------------------------------------
  // 3. present -> failure -> failure -> present: consecutive_absences stays
  //    0 and status stays active throughout — a provider failure must
  //    never be counted as an absence.
  // ----------------------------------------------------------------------
  console.log('\n3. present -> failure -> failure -> present (provider failure is never an absence)');
  {
    const id = uniqueSourceId('resilient');
    const job = makeJob({ sourceId: id, officialUrl: REACHABLE_URL });

    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: [job] }), SYNC_OPTIONS); // present
    let row = await getRow('remotive', id);
    assert(row?.status === 'active' && row?.consecutive_absences === 0, `After initial presence: active, absences=0 (got ${row?.status}, ${row?.consecutive_absences})`);

    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: 'fail' }), SYNC_OPTIONS); // failure
    row = await getRow('remotive', id);
    assert(row?.status === 'active' && row?.consecutive_absences === 0, `After 1st provider failure: still active, absences still 0 (got ${row?.status}, ${row?.consecutive_absences})`);

    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: 'fail' }), SYNC_OPTIONS); // failure
    row = await getRow('remotive', id);
    assert(row?.status === 'active' && row?.consecutive_absences === 0, `After 2nd provider failure: still active, absences still 0 (got ${row?.status}, ${row?.consecutive_absences})`);

    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: [job] }), SYNC_OPTIONS); // present again
    row = await getRow('remotive', id);
    assert(row?.status === 'active' && row?.consecutive_absences === 0, `After reappearing: active, absences=0 (got ${row?.status}, ${row?.consecutive_absences})`);

    await cleanup(['remotive', id]);
  }

  // ----------------------------------------------------------------------
  // 4. present -> absent -> absent -> absent: exactly 3 successful
  //    omissions expire the job.
  // ----------------------------------------------------------------------
  console.log('\n4. present -> absent -> absent -> absent (3 successful omissions expire)');
  {
    const id = uniqueSourceId('absence');
    const decoyId = uniqueSourceId('absence-decoy');
    const job = makeJob({ sourceId: id, officialUrl: REACHABLE_URL });
    const decoy = makeJob({ sourceId: decoyId, officialUrl: REACHABLE_URL });

    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: [job, decoy] }), SYNC_OPTIONS); // present
    let row = await getRow('remotive', id);
    assert(row?.status === 'active' && row?.consecutive_absences === 0, `After initial presence: active, absences=0 (got ${row?.status}, ${row?.consecutive_absences})`);

    // Successful cycles that omit `job` but still return `decoy` — a real,
    // successful provider response that genuinely doesn't include this job.
    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: [decoy] }), SYNC_OPTIONS);
    row = await getRow('remotive', id);
    assert(row?.status === 'active' && row?.consecutive_absences === 1, `After 1st absence: still active, absences=1 (got ${row?.status}, ${row?.consecutive_absences})`);

    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: [decoy] }), SYNC_OPTIONS);
    row = await getRow('remotive', id);
    assert(row?.status === 'active' && row?.consecutive_absences === 2, `After 2nd absence: still active, absences=2 (got ${row?.status}, ${row?.consecutive_absences})`);

    await syncOpportunitiesToCatalog(fetchResultFor({ remotive: [decoy] }), SYNC_OPTIONS);
    row = await getRow('remotive', id);
    assert(row?.status === 'expired' && row?.consecutive_absences === 3, `After 3rd absence: expired, absences=3 (got ${row?.status}, ${row?.consecutive_absences})`);

    await cleanup(['remotive', id], ['remotive', decoyId]);
  }

  // ----------------------------------------------------------------------
  // 5. Explicit editorial override — raw status 'EXPIRED' bypasses
  //    verification entirely, even with a reachable link.
  // ----------------------------------------------------------------------
  console.log('\n5. EXPLICIT EDITORIAL OVERRIDE bypasses verification');
  {
    const id = uniqueSourceId('override');
    await syncOpportunitiesToCatalog(
      fetchResultFor({
        curated: [makeJob({ source: 'curated', sourceId: id, officialUrl: REACHABLE_URL, status: 'EXPIRED', isPermanentlyRemoved: true })],
      }),
      SYNC_OPTIONS
    );
    const row = await getRow('curated', id);
    assert(row?.status === 'expired', `Explicit status:'EXPIRED' override wins even with a reachable link (got ${row?.status})`);
    assert(row?.is_permanently_removed === true, 'is_permanently_removed carried through from the override');
    assert(row?.link_reachable === null, 'No link check was ever attempted for an explicitly-overridden job');
    await cleanup(['curated', id]);
  }

  // ----------------------------------------------------------------------
  // 6. Curated skips automated verification — a curated job with an
  //    unreachable link, but no explicit override, still goes active.
  // ----------------------------------------------------------------------
  console.log('\n6. CURATED SKIPS AUTOMATED VERIFICATION (unlike live providers)');
  {
    const id = uniqueSourceId('curated-noverify');
    await syncOpportunitiesToCatalog(
      fetchResultFor({ curated: [makeJob({ source: 'curated', sourceId: id, officialUrl: UNREACHABLE_URL })] }),
      SYNC_OPTIONS
    );
    const row = await getRow('curated', id);
    assert(row?.status === 'active', `Curated job with an unreachable link still goes active — no automated verification applied (got ${row?.status})`);
    assert(row?.link_reachable === null, 'No link check was attempted for a curated job');
    await cleanup(['curated', id]);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Fatal error running live-supply lifecycle suite:', err);
  process.exit(1);
});
