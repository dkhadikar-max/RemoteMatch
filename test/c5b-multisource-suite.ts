/**
 * Supply Discovery gate C5-B — multi-source orchestration proof
 * (C:\Users\dell\.claude\plans\vivid-hatching-kitten.md §1/§5).
 * ==============================================================================
 * This is the suite that actually proves the architectural claim this pilot
 * exists to validate: multiple independent sources run in parallel via
 * Promise.allSettled() (mirroring catalog-sync.ts's own proven pattern),
 * and — the safety property carried over from that precedent — a failed
 * provider has ZERO effect on that provider's own existing rows this
 * cycle. Neither property is exercised by wwr-provider-suite.ts or
 * himalayas-provider-suite.ts individually (each only ever runs its own
 * single provider), so it needs its own dedicated test.
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { syncCareerPageOpportunities } from '../src/lib/ingestion/career-page-sync';
import type { RawJobPayload, JobProvider } from '../src/lib/providers/types';
import { hasRequiredEnv, adminClient } from './helpers/verified-session';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ PASS: ${message}`); }
  else { failed++; console.log(`  ✗ FAIL: ${message}`); }
}

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C5-B — MULTI-SOURCE ORCHESTRATION PROOF');
  console.log('==============================================================================\n');

  if (!hasRequiredEnv()) {
    console.log('Missing required env vars. Skipping.');
    return;
  }
  const admin = adminClient();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  console.log('1. Two real sources run genuinely in parallel — a slow provider does not block a fast one');
  {
    let sourceAStartedAt = 0;
    let sourceBStartedAt = 0;
    const providers: JobProvider[] = [
      {
        name: 'test-slow', sourceKey: 'test-source-a',
        fetchJobs: async () => {
          sourceAStartedAt = Date.now();
          await new Promise((r) => setTimeout(r, 300));
          return [];
        },
      },
      {
        name: 'test-fast', sourceKey: 'test-source-b',
        fetchJobs: async () => {
          sourceBStartedAt = Date.now();
          return [];
        },
      },
    ];
    await syncCareerPageOpportunities(providers);
    // If these ran sequentially, source B would start ~300ms+ after source A.
    // Running in parallel, they start within a few ms of each other.
    const startGap = Math.abs(sourceAStartedAt - sourceBStartedAt);
    assert(startGap < 100, `both providers started within ${startGap}ms of each other (genuinely parallel, not sequential — a sequential run would show a ~300ms gap)`);
  }

  console.log('\n2. A failed provider has ZERO effect on that provider\'s OWN existing rows this cycle');
  {
    const survivingSourceId = `c5b-multisource-survivor-${suffix}`;
    // Seed a pre-existing active row attributed to a source that will FAIL this cycle.
    const { error: seedError } = await admin.from('opportunities').insert({
      source: 'weworkremotely', source_id: survivingSourceId,
      title: 'Pre-existing Row', company: 'Test Co', description: 'x',
      official_url: 'https://example.test/x', canonical_url_hash: `hash-${suffix}`,
      content_hash: `content-${suffix}`, employment_type: 'Full-time', remote_type: 'Worldwide',
      eligible_countries: [], excluded_countries: [], timezone_requirements: [],
      required_skills: [], preferred_skills: [], quality_score: 50,
      explicit_remote_scope: 'explicit_worldwide',
      type: 'job', status: 'active', link_reachable: true,
      link_checked_at: new Date().toISOString(), posted_at: new Date().toISOString(),
      first_seen_at: new Date().toISOString(), last_seen_in_feed_at: new Date().toISOString(),
      consecutive_absences: 0,
    });
    if (seedError) throw new Error(`Seed insert failed: ${seedError.message}`);

    const goodJob: RawJobPayload = {
      sourceId: `c5b-multisource-succeed-${suffix}`, source: 'himalayas',
      title: 'A Good Job', company: 'Good Co', description: 'x',
      sourceUrl: 'https://example.test/ok', officialUrl: 'https://example.test/ok',
      jobType: 'Full-time', locationString: 'Worldwide', tags: [],
      publicationDate: new Date().toISOString(),
    };

    const providers: JobProvider[] = [
      { name: 'test-fail', sourceKey: 'weworkremotely', fetchJobs: async () => { throw new Error('simulated provider failure'); } },
      { name: 'test-ok', sourceKey: 'himalayas', fetchJobs: async () => [goodJob] },
    ];

    const summary = await syncCareerPageOpportunities(providers);

    assert(
      summary.providerOutcomes.find((o) => o.sourceKey === 'weworkremotely')?.success === false,
      'the failing provider is correctly recorded as unsuccessful in providerOutcomes'
    );
    assert(
      summary.providerOutcomes.find((o) => o.sourceKey === 'himalayas')?.success === true,
      'the succeeding provider is correctly recorded as successful in providerOutcomes'
    );
    assert(summary.newJobsInserted === 1, `exactly the succeeding provider's job was inserted (got ${summary.newJobsInserted})`);

    const { data: survivorRow } = await admin
      .from('opportunities').select('consecutive_absences, status')
      .eq('source', 'weworkremotely').eq('source_id', survivingSourceId).maybeSingle();
    assert(survivorRow?.consecutive_absences === 0, `the failed provider's pre-existing row was NOT absence-incremented (still 0, got ${survivorRow?.consecutive_absences}) — proves failure isolation`);
    assert(survivorRow?.status === 'active', 'the failed provider\'s pre-existing row was NOT touched at all — status unchanged');

    await admin.from('opportunities').delete().eq('source', 'weworkremotely').eq('source_id', survivingSourceId);
    await admin.from('opportunities').delete().eq('source', 'himalayas').eq('source_id', goodJob.sourceId);
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running c5b-multisource-suite:', e); process.exit(1); });
