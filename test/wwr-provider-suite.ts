/**
 * Supply Discovery gate C5-B — We Work Remotely public RSS feed
 * (C:\Users\dell\.claude\plans\vivid-hatching-kitten.md §2/§5).
 * ==============================================================================
 * Real fetch against the live public feed (structural/field-mapping
 * correctness — content varies over time, so assertions are on shape, not
 * exact job content) plus a real end-to-end run through the actual,
 * unmodified syncCareerPageOpportunities() multi-provider orchestrator,
 * using a synthetic single-job override — the same synthetic-prefix
 * injection pattern ats-provider-suite.ts/career-page-dedup-suite.ts
 * already use, so this never touches real production rows broadly while
 * still proving the REAL insert/dedup/absence-accounting code path.
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { WeWorkRemotelyProvider } from '../src/lib/providers/weworkremotely';
import { syncCareerPageOpportunities } from '../src/lib/ingestion/career-page-sync';
import type { RawJobPayload } from '../src/lib/providers/types';
import { hasRequiredEnv, adminClient } from './helpers/verified-session';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ PASS: ${message}`); }
  else { failed++; console.log(`  ✗ FAIL: ${message}`); }
}

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C5-B — WE WORK REMOTELY PROVIDER');
  console.log('==============================================================================\n');

  console.log('1. REAL-INFRA — live feed fetch, structural correctness (self-skips if unreachable)');
  {
    const provider = new WeWorkRemotelyProvider();
    let jobs: RawJobPayload[] = [];
    try {
      jobs = await provider.fetchJobs();
    } catch (err) {
      console.log(`  – SKIP: live fetch failed (${(err as Error).message}), skipping structural assertions`);
    }

    if (jobs.length > 0) {
      assert(jobs.length > 5, `the real feed returned a substantial number of jobs (got ${jobs.length})`);

      const allHaveCore = jobs.every((j) => j.title && j.company && j.sourceId && j.officialUrl);
      assert(allHaveCore, 'every real job has title/company/sourceId/officialUrl populated');

      const allTaggedCorrectly = jobs.every((j) => j.source === 'weworkremotely');
      assert(allTaggedCorrectly, "every job is tagged source: 'weworkremotely'");

      const allHaveRealDates = jobs.every((j) => {
        const d = new Date(j.publicationDate);
        return !Number.isNaN(d.getTime()) && d.getTime() <= Date.now();
      });
      assert(allHaveRealDates, 'every job has a valid, non-future publicationDate (real <pubDate>, not a guessed fallback)');

      const noCompanyIsUnknownForMost = jobs.filter((j) => j.company === 'Unknown Company').length < jobs.length * 0.1;
      assert(noCompanyIsUnknownForMost, `fewer than 10% of jobs fell back to 'Unknown Company' (the feed's "Company: Role" title split held for the vast majority) — got ${jobs.filter((j) => j.company === 'Unknown Company').length}/${jobs.length}`);

      const sample = jobs[0];
      console.log(`  (sample: "${sample.title}" @ ${sample.company}, location="${sample.locationString}", date=${sample.publicationDate})`);
    } else {
      console.log('  – SKIP: live feed returned 0 jobs (network issue or feed format changed) — cannot run structural assertions');
    }
  }

  console.log('\n2. REAL-INFRA — end-to-end publication through the real, unmodified syncCareerPageOpportunities() (self-skips if env unavailable)');
  if (!hasRequiredEnv()) {
    console.log('  – SKIP: env not configured');
  } else {
    const admin = adminClient();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sourceId = `https://weworkremotely.com/remote-jobs/wwr-test-${suffix}`;

    const syntheticJob: RawJobPayload = {
      sourceId,
      source: 'weworkremotely',
      title: 'Senior Test Engineer',
      company: 'WWR Test Co',
      description: 'A synthetic test posting for the C5-B pilot end-to-end proof.',
      sourceUrl: sourceId,
      officialUrl: sourceId,
      jobType: 'Full-time',
      locationString: 'Anywhere in the World',
      tags: ['Engineering'],
      publicationDate: new Date().toISOString(),
    };

    try {
      const summary = await syncCareerPageOpportunities([
        { name: 'test-wwr', sourceKey: 'weworkremotely', fetchJobs: async () => [syntheticJob] },
      ]);
      assert(summary.newJobsInserted === 1, `syncCareerPageOpportunities() inserted the synthetic weworkremotely row (got newJobsInserted=${summary.newJobsInserted})`);
      assert(summary.providerOutcomes.some((o) => o.sourceKey === 'weworkremotely' && o.success), 'providerOutcomes correctly records the weworkremotely provider as successful');

      const { data } = await admin
        .from('opportunities')
        .select('id, source, source_id')
        .eq('source', 'weworkremotely')
        .eq('source_id', sourceId)
        .maybeSingle();
      assert(!!data, 'the row genuinely exists in the DB, correctly tagged source=weworkremotely — real read, not an inferred summary count');
    } finally {
      await admin.from('opportunities').delete().eq('source', 'weworkremotely').eq('source_id', sourceId);
      const { data: leftover } = await admin.from('opportunities').select('id').eq('source', 'weworkremotely').eq('source_id', sourceId);
      assert((leftover ?? []).length === 0, 'no test row remains after cleanup');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running wwr-provider-suite:', e); process.exit(1); });
