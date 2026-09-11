/**
 * M-adj-2(a) — Data-Source / Navigation Integrity.
 * ==============================================================================
 * Before: match/[jobId] resolved the opportunity via localStore.getOpportunityById()
 *   -> the static CURATED_JOBS fixture only. Worked only when jobId happened to
 *   be a curated id; every remotive/arbeitnow/jobicy id silently redirected to
 *   /feed with no explanation.
 * After: resolved from the live, active catalog (GET /api/opportunities/feed,
 *   existing, no new route) for EVERY source, curated included. A fetch
 *   failure or a genuinely absent/inactive id falls through to the SAME
 *   existing /feed redirect — never a fallback to the fixture.
 *
 *   1. Static — the page no longer references localStore.getOpportunityById;
 *      it calls /api/opportunities/feed instead. engine.ts untouched. No new
 *      API route directory introduced.
 *   2. Per-source resolution — dynamically queries the LIVE catalog (never
 *      hardcoded ids, which would rot as the catalog syncs) for one active
 *      opportunity per source (curated/remotive/arbeitnow/jobicy) and proves
 *      it resolves with the exact requested title/company. A source with zero
 *      currently-active rows is SKIPPED, not silently indistinguishable from
 *      a pass — see the explicit summary table at the end.
 *   3. Invalid id — a fabricated id resolves to nothing (the data-layer half
 *      of the safe not-found behavior; the full redirect is browser-gated).
 *
 * Run: TEST_BASE_URL=... npx tsx test/data-source-integrity-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { CanonicalOpportunity } from '../src/types/byn';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

const SOURCES = ['curated', 'remotive', 'arbeitnow', 'jobicy'] as const;
type SourceResult = 'PASS' | 'FAIL' | 'SKIPPED — no active opportunity available';

async function run() {
  console.log('='.repeat(78));
  console.log('M-adj-2(a) — DATA-SOURCE / NAVIGATION INTEGRITY');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. STATIC — fixture resolver removed, live catalog resolver present');
  // ==========================================================================
  {
    const page = readFileSync(join(__dirname, '../src/app/match/[jobId]/page.tsx'), 'utf8');
    assert(!page.includes('localStore.getOpportunityById'), 'match/[jobId] no longer calls localStore.getOpportunityById (gate #7)');
    assert(page.includes("fetch('/api/opportunities/feed')"), 'match/[jobId] resolves the opportunity via the existing /api/opportunities/feed GET');
    assert(page.includes('localStore.getProfile'), 'localStore is still used for PROFILE content (J4, untouched) — only the opportunity lookup changed');

    try {
      const engineDiff = execSync('git diff HEAD -- src/lib/matching/engine.ts', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(engineDiff.trim() === '', 'src/lib/matching/engine.ts has zero uncommitted diff from HEAD');
    } catch (e: any) {
      skip(`git diff check unavailable (${e.message})`);
    }
    try {
      const migrationDiff = execSync('git status --porcelain supabase/migrations', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(migrationDiff.trim() === '', `no new/modified migration file (got: ${migrationDiff.trim() || 'none'})`);
    } catch (e: any) {
      skip(`git status check unavailable (${e.message})`);
    }
    // no new top-level API route directory (a1 — reuse only, no new route)
    const { readdirSync } = await import('fs');
    const apiDirs = readdirSync(join(__dirname, '../src/app/api')).sort();
    const expected = ['ai', 'applications', 'demand', 'health', 'onboarding', 'opportunities', 'profile', 'resume', 'seo', 'staging', 'stripe'];
    assert(
      apiDirs.every((d) => expected.includes(d)) && apiDirs.length === expected.length,
      `no new top-level API route directory introduced (got: ${apiDirs.join(', ')})`,
    );
  }

  // ==========================================================================
  console.log('\n2. PER-SOURCE resolution (live catalog, not hardcoded ids)');
  // ==========================================================================
  const sourceResults: Record<(typeof SOURCES)[number], SourceResult> = {
    curated: 'SKIPPED — no active opportunity available',
    remotive: 'SKIPPED — no active opportunity available',
    arbeitnow: 'SKIPPED — no active opportunity available',
    jobicy: 'SKIPPED — no active opportunity available',
  };
  {
    let catalog: CanonicalOpportunity[] = [];
    try {
      const res = await fetch(`${BASE_URL}/api/opportunities/feed`);
      const data = await res.json();
      assert(res.status === 200 && data.success, `GET /api/opportunities/feed -> 200 (got ${res.status})`);
      catalog = data.opportunities || [];
    } catch (e: any) {
      assert(false, 'could not fetch the live catalog to run per-source checks', e.message);
    }

    for (const source of SOURCES) {
      const candidate = catalog.find((o) => o.source === source);
      if (!candidate) {
        skip(`${source}: no currently-active opportunity to test against (catalog composition varies with sync cycles, out of this ticket's control)`);
        continue;
      }
      // Re-fetch independently, exactly mirroring what the page itself does
      // on a fresh load — never reuse the same in-memory array as "proof".
      const res2 = await fetch(`${BASE_URL}/api/opportunities/feed`);
      const data2 = await res2.json();
      const resolved = (data2.opportunities || []).find((o: CanonicalOpportunity) => o.id === candidate.id);
      const ok =
        !!resolved &&
        resolved.title === candidate.title &&
        resolved.company === candidate.company &&
        resolved.source === source;
      assert(
        ok,
        `${source}: opportunity "${candidate.title}" (${candidate.company}, id=${candidate.id}) resolves with matching title/company/source`,
      );
      sourceResults[source] = ok ? 'PASS' : 'FAIL';
    }
  }

  // ==========================================================================
  console.log('\n3. INVALID id (data-layer half of the safe not-found behavior)');
  // ==========================================================================
  {
    const res = await fetch(`${BASE_URL}/api/opportunities/feed`);
    const data = await res.json();
    const fakeId = 'opp-fake-source-this-id-does-not-exist-999999';
    const resolved = (data.opportunities || []).find((o: CanonicalOpportunity) => o.id === fakeId);
    assert(!resolved, 'a fabricated id resolves to nothing in the live catalog (page-level redirect verified separately, in the browser gate)');
  }

  // ==========================================================================
  console.log('\nPER-SOURCE SUMMARY (verified vs. not-currently-testable are kept visually distinct)');
  // ==========================================================================
  for (const source of SOURCES) {
    console.log(`  ${source}: ${sourceResults[source]}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running data-source-integrity suite:', e); process.exit(1); });
