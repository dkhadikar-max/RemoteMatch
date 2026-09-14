/**
 * C5 Acquisition Validation Amendment — Finding B (docs/c5-acquisition-
 * validation-amendment.md §2): the write-time remote-eligibility gate in
 * career-page-sync.ts. Real-infra, self-skips if env unavailable — the
 * core assertion (zero catalog insertion) can only be genuinely proven
 * against a real DB read, not an inferred summary count alone.
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { syncCareerPageOpportunities } from '../src/lib/ingestion/career-page-sync';
import { classifyExplicitRemoteScope } from '../src/lib/ingestion/pipeline';
import type { RawJobPayload } from '../src/lib/providers/types';
import { hasRequiredEnv, adminClient } from './helpers/verified-session';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ PASS: ${message}`); }
  else { failed++; console.log(`  ✗ FAIL: ${message}`); }
}
function skip(message: string) { skipped++; console.log(`  – SKIP: ${message}`); }

function makeRaw(suffix: string, locationString: string): RawJobPayload {
  return {
    source: 'careerpage',
    sourceId: `c5-remote-gate-test-${suffix}`,
    title: 'Remote Gate Test Position',
    company: `C5 Remote Gate Test Co ${suffix}`,
    description: 'A'.repeat(150),
    officialUrl: `https://example.com/careers/remote-gate-test-${suffix}`,
    jobType: 'Full-time',
    locationString,
    tags: [],
    publicationDate: new Date().toISOString(),
  };
}

async function run() {
  console.log('==============================================================================');
  console.log('C5 ACQUISITION VALIDATION AMENDMENT — FINDING B: REMOTE-ELIGIBILITY WRITE GATE');
  console.log('==============================================================================\n');

  console.log('1. Classifier behavior lock-in (pure, no infra — documents the exact inputs used below)');
  assert(classifyExplicitRemoteScope('') === 'unknown', "empty locationString classifies 'unknown' (Finding A's exact failure shape before the fix)");
  assert(classifyExplicitRemoteScope('Remote - USA') === 'explicit_restricted', "'Remote - USA' (the real, confirmed Coinbase/Okta shape) classifies 'explicit_restricted', not 'unknown'");
  assert(classifyExplicitRemoteScope('Worldwide') === 'explicit_worldwide', "'Worldwide' classifies 'explicit_worldwide'");
  assert(classifyExplicitRemoteScope('Remote') === 'unknown', "'Remote' alone, no scope qualifier, classifies 'unknown' — locking in current (frozen, unmodified) classifier behavior for this ambiguous input");

  console.log('\n2. REAL-INFRA — write-time gate against the real syncCareerPageOpportunities() (self-skips if env unavailable)');
  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — real-infra section skipped.');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exit(1);
    return;
  }

  const admin = adminClient();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const cases: { label: string; locationString: string; expectInserted: boolean }[] = [
    { label: 'empty-location', locationString: '', expectInserted: false },
    { label: 'remote-usa', locationString: 'Remote - USA', expectInserted: true },
    { label: 'worldwide', locationString: 'Worldwide', expectInserted: true },
    { label: 'bare-remote', locationString: 'Remote', expectInserted: false },
  ];

  try {
    for (const c of cases) {
      const raw = makeRaw(`${c.label}-${suffix}`, c.locationString);
      const summary = await syncCareerPageOpportunities({ fetchJobs: async () => [raw] });

      const { data } = await admin
        .from('opportunities')
        .select('id, explicit_remote_scope')
        .eq('source', 'careerpage')
        .eq('source_id', raw.sourceId)
        .maybeSingle();

      if (c.expectInserted) {
        assert(summary.newJobsInserted === 1, `[${c.label}] syncCareerPageOpportunities() reports 1 new insert (got ${summary.newJobsInserted})`);
        assert(!!data, `[${c.label}] the row genuinely exists in the DB — real read, not an inferred summary count`);
      } else {
        assert(summary.newJobsInserted === 0, `[${c.label}] syncCareerPageOpportunities() reports ZERO new inserts (got ${summary.newJobsInserted})`);
        assert(!data, `[${c.label}] the row genuinely does NOT exist in the DB — confirmed by direct read, not an inferred summary count`);
      }
    }
  } finally {
    for (const c of cases) {
      await admin.from('opportunities').delete().eq('source', 'careerpage').eq('source_id', `c5-remote-gate-test-${c.label}-${suffix}`);
    }
    const { data: leftover } = await admin
      .from('opportunities')
      .select('id')
      .eq('source', 'careerpage')
      .like('source_id', `c5-remote-gate-test-%-${suffix}`);
    assert((leftover ?? []).length === 0, `no test rows from this run remain after cleanup (found ${(leftover ?? []).length})`);
  }

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running career-page-remote-gate suite:', e); process.exit(1); });
