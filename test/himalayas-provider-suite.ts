/**
 * Supply Discovery gate C5-B — Himalayas public job API
 * (C:\Users\dell\.claude\plans\vivid-hatching-kitten.md §2/§5).
 * ==============================================================================
 * Same shape as wwr-provider-suite.ts: real fetch against the live public
 * API for structural correctness (including proving cursor pagination
 * actually advances across pages, not just returning the same first page
 * repeatedly), plus a real end-to-end run through the actual, unmodified
 * syncCareerPageOpportunities() multi-provider orchestrator using a
 * synthetic single-job override.
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { HimalayasProvider } from '../src/lib/providers/himalayas';
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
  console.log('SUPPLY DISCOVERY C5-B — HIMALAYAS PROVIDER');
  console.log('==============================================================================\n');

  console.log('1. REAL-INFRA — live API fetch, structural correctness + pagination (self-skips if unreachable)');
  {
    const provider = new HimalayasProvider();
    let jobs: RawJobPayload[] = [];
    try {
      jobs = await provider.fetchJobs();
    } catch (err) {
      console.log(`  – SKIP: live fetch failed (${(err as Error).message}), skipping structural assertions`);
    }

    if (jobs.length > 0) {
      // MAX_PAGES=3, PAGE_SIZE=20 in the provider — a genuinely multi-page
      // pull should exceed a single page's worth, proving the cursor
      // actually advanced rather than the loop exiting after page 1.
      assert(jobs.length > 20, `pagination pulled more than a single page's worth of jobs (got ${jobs.length}, page size is 20)`);

      const allHaveCore = jobs.every((j) => j.title && j.company && j.sourceId && j.officialUrl);
      assert(allHaveCore, 'every real job has title/company/sourceId/officialUrl populated');

      const allTaggedCorrectly = jobs.every((j) => j.source === 'himalayas');
      assert(allTaggedCorrectly, "every job is tagged source: 'himalayas'");

      const uniqueIds = new Set(jobs.map((j) => j.sourceId));
      assert(uniqueIds.size === jobs.length, `no duplicate sourceIds across pages (${uniqueIds.size} unique of ${jobs.length} total) — proves the cursor genuinely advanced rather than re-fetching the same page`);

      const allHaveRealDates = jobs.every((j) => {
        const d = new Date(j.publicationDate);
        return !Number.isNaN(d.getTime()) && d.getTime() <= Date.now();
      });
      assert(allHaveRealDates, 'every job has a valid, non-future publicationDate (real pubDate epoch, not a guessed fallback)');

      const sample = jobs[0];
      console.log(`  (sample: "${sample.title}" @ ${sample.company}, location="${sample.locationString}", date=${sample.publicationDate})`);
    } else {
      console.log('  – SKIP: live API returned 0 jobs (network issue or API format changed) — cannot run structural assertions');
    }
  }

  console.log('\n2. REAL-INFRA — end-to-end publication through the real, unmodified syncCareerPageOpportunities() (self-skips if env unavailable)');
  if (!hasRequiredEnv()) {
    console.log('  – SKIP: env not configured');
  } else {
    const admin = adminClient();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sourceId = `https://himalayas.app/companies/himalayas-test/jobs/himalayas-test-${suffix}`;

    const syntheticJob: RawJobPayload = {
      sourceId,
      source: 'himalayas',
      title: 'Senior Test Engineer',
      company: 'Himalayas Test Co',
      description: 'A synthetic test posting for the C5-B pilot end-to-end proof.',
      sourceUrl: sourceId,
      officialUrl: sourceId,
      jobType: 'Full-time',
      locationString: 'Worldwide',
      tags: ['Engineering'],
      publicationDate: new Date().toISOString(),
    };

    try {
      const summary = await syncCareerPageOpportunities([
        { name: 'test-himalayas', sourceKey: 'himalayas', fetchJobs: async () => [syntheticJob] },
      ]);
      assert(summary.newJobsInserted === 1, `syncCareerPageOpportunities() inserted the synthetic himalayas row (got newJobsInserted=${summary.newJobsInserted})`);
      assert(summary.providerOutcomes.some((o) => o.sourceKey === 'himalayas' && o.success), 'providerOutcomes correctly records the himalayas provider as successful');

      const { data } = await admin
        .from('opportunities')
        .select('id, source, source_id')
        .eq('source', 'himalayas')
        .eq('source_id', sourceId)
        .maybeSingle();
      assert(!!data, 'the row genuinely exists in the DB, correctly tagged source=himalayas — real read, not an inferred summary count');
    } finally {
      await admin.from('opportunities').delete().eq('source', 'himalayas').eq('source_id', sourceId);
      const { data: leftover } = await admin.from('opportunities').select('id').eq('source', 'himalayas').eq('source_id', sourceId);
      assert((leftover ?? []).length === 0, 'no test row remains after cleanup');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running himalayas-provider-suite:', e); process.exit(1); });
