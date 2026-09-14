/**
 * AI Phase 1A — C5 Gemini extraction cache
 * (docs/ai-phase1-implementation-plan.md §6, §9; supabase/migrations/023_gemini_extraction_cache.sql)
 * ==============================================================================
 * Tests the REAL, unmodified getCachedExtraction()/setCachedExtraction()
 * (src/lib/ai/gemini-cache.ts) and the REAL, unmodified
 * extractJobFromCareerPageText()'s cache-hit path (src/lib/ai/career-page-
 * extraction.ts) — not mocks. Uses uniquely-prefixed synthetic source text
 * (and therefore a unique content_hash) so this suite never touches a real
 * cached entry from production C5 syncs.
 *
 * The load-bearing test (§9): a cache hit must never be trusted as-is — the
 * real, unmodified validateExtraction() (extraction-validation.ts) still
 * has to independently reject a cache-derived extraction when fed
 * mismatched current source text, proving the architectural guarantee that
 * caching never becomes a way to bypass evidence validation.
 *
 * REQUIRES: supabase/migrations/023_gemini_extraction_cache.sql applied,
 * and (for Test 3/4) supabase/migrations/020_ai_quota_ledger.sql applied +
 * GEMINI_API_KEY set (career-page-extraction.ts's early return on a
 * missing key would otherwise short-circuit before the cache is even
 * consulted).
 *
 * Run: npx tsx test/gemini-cache-suite.ts
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { hasRequiredEnv, adminClient } from './helpers/verified-session';
import { createContentHash } from '../src/lib/ingestion/pipeline';
import { getCachedExtraction, setCachedExtraction } from '../src/lib/ai/gemini-cache';
import { extractJobFromCareerPageText, type CareerPageExtraction } from '../src/lib/ai/career-page-extraction';
import { validateExtraction } from '../src/lib/ingestion/extraction-validation';
import { GEMINI_MODEL_ID } from '../src/lib/ai/gemini-config';

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

async function main() {
  if (!hasRequiredEnv()) {
    console.error('Missing required env vars. Skipping.');
    process.exit(1);
  }
  const admin = adminClient();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { error: probeError } = await admin.from('gemini_extraction_cache').select('content_hash').limit(1);
  if (probeError) {
    console.error('supabase/migrations/023_gemini_extraction_cache.sql does not appear to be applied yet. Error:', probeError.message);
    process.exit(1);
  }

  console.log('\n=== Test 1: miss on an unseen content hash ===');
  {
    const unseenHash = createContentHash(`unseen-synthetic-text-${runId}`);
    const result = await getCachedExtraction(unseenHash);
    assert(result === null, 'getCachedExtraction returns null for a hash never written');
  }

  console.log('\n=== Test 2: set then get round-trips, officialUrl excluded from storage ===');
  {
    const synthText = `Synthetic Test Posting ${runId} — Senior Widget Engineer, Remote, Full-time. Posted March 1, 2026.`;
    const hash = createContentHash(synthText);
    const extraction: CareerPageExtraction = {
      title: 'Senior Widget Engineer',
      titleEvidence: 'Senior Widget Engineer',
      description: 'A synthetic test posting.',
      locationString: 'Remote',
      locationEvidence: 'Remote',
      publicationDate: '2026-03-01',
      publicationDateEvidence: 'March 1, 2026',
      jobType: 'Full-time',
      jobTypeEvidence: 'Full-time',
      officialUrl: 'https://example.test/original-url',
    };

    await setCachedExtraction(hash, extraction);
    const cached = await getCachedExtraction(hash);

    assert(cached !== null, 'a written entry is readable back');
    assert(cached?.title === extraction.title, 'title round-trips correctly');
    assert(cached?.titleEvidence === extraction.titleEvidence, 'titleEvidence round-trips correctly');
    assert(!('officialUrl' in (cached || {})), 'officialUrl is NOT part of the cached value (caller-supplied truth, not evidence-checked)');

    await admin.from('gemini_extraction_cache').delete().eq('content_hash', hash);
  }

  console.log('\n=== Test 3: extractJobFromCareerPageText — a cache hit skips Gemini entirely (no real ledger reservation made) ===');
  {
    const synthText = `Synthetic Cache-Hit Posting ${runId} — Staff Gadget Engineer, Remote (Worldwide), Contract. Requires 5+ years experience.`;
    const truncated = synthText.slice(0, 4000);
    const hash = createContentHash(truncated);
    const extraction: CareerPageExtraction = {
      title: 'Staff Gadget Engineer',
      titleEvidence: 'Staff Gadget Engineer',
      description: 'A synthetic cache-hit test posting.',
      locationString: 'Remote (Worldwide)',
      locationEvidence: 'Remote (Worldwide)',
      publicationDate: null,
      publicationDateEvidence: null,
      jobType: 'Contract',
      jobTypeEvidence: 'Contract',
      officialUrl: 'https://example.test/original-url',
    };
    await setCachedExtraction(hash, extraction);

    const today = new Date().toISOString().slice(0, 10);
    const ledgerBefore = await admin
      .from('ai_quota_ledger')
      .select('requests_used, requests_reserved')
      .eq('provider', 'gemini').eq('model', GEMINI_MODEL_ID).eq('usage_date', today).eq('feature', 'c5_extraction')
      .maybeSingle();

    const result = await extractJobFromCareerPageText(synthText, 'https://example.test/current-call-url', 'test-employer-id-unused-on-hit');

    assert(result !== null, 'a cache hit returns a non-null extraction');
    assert(result?.officialUrl === 'https://example.test/current-call-url', 'the returned officialUrl is the CURRENT call\'s url, not the originally-cached one');
    assert(result?.title === extraction.title, 'the cached title is returned on a hit');

    const ledgerAfter = await admin
      .from('ai_quota_ledger')
      .select('requests_used, requests_reserved')
      .eq('provider', 'gemini').eq('model', GEMINI_MODEL_ID).eq('usage_date', today).eq('feature', 'c5_extraction')
      .maybeSingle();

    const usedBefore = ledgerBefore.data?.requests_used ?? 0;
    const usedAfter = ledgerAfter.data?.requests_used ?? 0;
    const reservedBefore = ledgerBefore.data?.requests_reserved ?? 0;
    const reservedAfter = ledgerAfter.data?.requests_reserved ?? 0;
    assert(usedAfter === usedBefore, `requests_used unchanged by a cache hit (${usedBefore} -> ${usedAfter}) — no real Gemini call was made`);
    assert(reservedAfter === reservedBefore, `requests_reserved unchanged by a cache hit (${reservedBefore} -> ${reservedAfter}) — no reservation was even attempted`);

    await admin.from('gemini_extraction_cache').delete().eq('content_hash', hash);
  }

  console.log('\n=== Test 4 (load-bearing): a cache-derived extraction still fails real evidence validation against mismatched current source text ===');
  {
    // Simulates the scenario the architecture must guard against: the page
    // at a given content-hash-matching text has, hypothetically, since
    // changed in a way the hash didn't happen to capture (or — more
    // realistically — this proves the INDEPENDENT safety net: even a
    // cache-returned extraction is only ever trusted by career-page.ts
    // after re-running validateExtraction() against whatever text it
    // actually just fetched, not the text the cache entry was built from.
    const cachedExtraction: CareerPageExtraction = {
      title: 'Principal Doohickey Architect',
      titleEvidence: 'Principal Doohickey Architect',
      description: 'A synthetic evidence-mismatch test posting.',
      locationString: 'Remote',
      locationEvidence: 'Remote',
      publicationDate: null,
      publicationDateEvidence: null,
      jobType: 'Full-time',
      jobTypeEvidence: 'Full-time',
      officialUrl: 'https://example.test/x',
    };
    // Deliberately mismatched: this text does NOT contain
    // "Principal Doohickey Architect" anywhere.
    const currentPageText = `This page currently describes a totally different role, Junior Sprocket Technician, on-site only. ${runId}`;

    const validation = validateExtraction(cachedExtraction, currentPageText, {
      sourceId: `test-${runId}`, source: 'careerpage', company: 'Synthetic Test Co', sourceUrl: 'https://example.test/x',
    });

    assert(validation.valid === false, 'validateExtraction() independently REJECTS a cache-derived extraction when the current source text no longer supports it');
    if (!validation.valid) {
      assert(validation.reason.includes('evidence not found'), `rejection reason correctly names an evidence mismatch (got: "${validation.reason}")`);
    }
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
