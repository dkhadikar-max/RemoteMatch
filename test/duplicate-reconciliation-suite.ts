/**
 * M-adjacent-1 — Cross-Provider Duplicate Reconciliation.
 * ==============================================================================
 * Before: deduplicateOpportunities() only ever compared jobs within a single
 *   sync cycle's freshly-fetched raw batch. Two providers listing the same
 *   real-world job across different cycles could permanently coexist as two
 *   independent active rows — confirmed structurally, and confirmed against
 *   real production data (0 actual duplicates today, out of 72 active rows /
 *   4 sources — latent, not yet manifesting).
 * After: reconcileCrossProviderDuplicates() (a separate post-sync pass, never
 *   inside syncOpportunitiesToCatalog()) clusters active rows using the SAME
 *   fingerprint hierarchy deduplicateOpportunities() already computes, picks
 *   a deterministic survivor, and marks every other cluster member's
 *   `superseded_by_opportunity_id`. `status`/`consecutive_absences`/
 *   `link_reachable` are never touched. Recomputed fresh every pass — no
 *   provenance of which predicate matched is stored.
 *
 * IMPORTANT — MIGRATION SEQUENCING:
 *   Section 1 (pure logic) and Section 2 (static checks) need no database and
 *   run unconditionally. Section 3 (real-infra) requires migration 018
 *   (`superseded_by_opportunity_id` column) to be live — it self-skips with a
 *   clear message if the column doesn't exist yet, rather than failing.
 *   Adding this column to catalog-read.ts's shared OPPORTUNITY_COLUMNS also
 *   means EVERY other suite touching the opportunities catalog (job-discovery,
 *   data-source-integrity, tailored-application, etc.) requires migration 018
 *   too — not just this suite. Do not run the full regression against real
 *   Supabase until the migration is confirmed applied.
 *
 * Run: npx tsx test/duplicate-reconciliation-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import {
  clusterActiveRowsForReconciliation,
  rankClusterForSurvivor,
  reconcileCrossProviderDuplicates,
} from '../src/lib/ingestion/catalog-sync';

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

interface Row {
  id: string;
  source: string;
  company: string;
  title: string;
  canonical_url_hash: string | null;
  content_hash: string | null;
  source_quality: number | null;
  first_seen_at: string | null;
  superseded_by_opportunity_id: string | null;
}

function row(overrides: Partial<Row> & { id: string; source: string }): Row {
  return {
    company: 'Acme',
    title: 'Software Engineer',
    canonical_url_hash: null,
    content_hash: null,
    source_quality: 50,
    first_seen_at: '2026-01-01T00:00:00.000Z',
    superseded_by_opportunity_id: null,
    ...overrides,
  };
}

async function run() {
  console.log('='.repeat(78));
  console.log('M-ADJACENT-1 — CROSS-PROVIDER DUPLICATE RECONCILIATION');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. clusterActiveRowsForReconciliation — pure, no database');
  // ==========================================================================
  {
    // Direct match via canonical_url_hash, different sources.
    const a = row({ id: 'A', source: 'remotive', canonical_url_hash: 'url1' });
    const b = row({ id: 'B', source: 'arbeitnow', canonical_url_hash: 'url1' });
    const clusters1 = clusterActiveRowsForReconciliation([a, b]);
    assert(clusters1.length === 1 && clusters1[0].length === 2, 'two rows sharing canonical_url_hash cluster together');

    // Transitive: A~B via URL, B~C via title (no direct A~C key) — all three
    // must land in ONE cluster, proving this isn't naive pairwise grouping.
    const c1 = row({ id: 'A', source: 'remotive', canonical_url_hash: 'url1', title: 'Backend Engineer' });
    const c2 = row({ id: 'B', source: 'arbeitnow', canonical_url_hash: 'url1', title: 'Software Engineer' });
    const c3 = row({ id: 'C', source: 'jobicy', canonical_url_hash: 'url2', title: 'Software Engineer' });
    const clusters2 = clusterActiveRowsForReconciliation([c1, c2, c3]);
    assert(clusters2.length === 1 && clusters2[0].length === 3, 'transitive collision (A~B via URL, B~C via title) merges all three into one cluster');

    // No shared fingerprint at all — must stay separate.
    const d1 = row({ id: 'D', source: 'remotive', canonical_url_hash: 'urlD', title: 'Backend Engineer' });
    const d2 = row({ id: 'E', source: 'arbeitnow', canonical_url_hash: 'urlE', title: 'Frontend Engineer' });
    const clusters3 = clusterActiveRowsForReconciliation([d1, d2]);
    assert(clusters3.length === 2, 'genuinely unrelated rows (no shared fingerprint) never cluster');

    // Documented inherited behavior (NOT a bug this ticket fixes): the
    // shared createNormalizedJobKey() strips seniority words, so "Software
    // Engineer" and "Senior Software Engineer" at the same company DO
    // collide under the company+title layer, even from different sources.
    const f1 = row({ id: 'F', source: 'remotive', company: 'Acme', title: 'Software Engineer', canonical_url_hash: 'urlF', content_hash: 'chF' });
    const f2 = row({ id: 'G', source: 'arbeitnow', company: 'Acme', title: 'Senior Software Engineer', canonical_url_hash: 'urlG', content_hash: 'chG' });
    const clusters4 = clusterActiveRowsForReconciliation([f1, f2]);
    assert(
      clusters4.length === 1 && clusters4[0].length === 2,
      '"Software Engineer" and "Senior Software Engineer" at the same company DO collide (inherited from createNormalizedJobKey — documented, not corrected here)',
    );

    // Same-source collisions cluster too — clustering itself is source-
    // agnostic; the skip-same-provider decision lives in
    // reconcileCrossProviderDuplicates(), not here.
    const h1 = row({ id: 'H', source: 'remotive', canonical_url_hash: 'urlH' });
    const h2 = row({ id: 'I', source: 'remotive', canonical_url_hash: 'urlH' });
    const clusters5 = clusterActiveRowsForReconciliation([h1, h2]);
    assert(clusters5.length === 1 && clusters5[0].length === 2, 'clustering itself does not filter by source (that happens one layer up)');
  }

  // ==========================================================================
  console.log('\n2. rankClusterForSurvivor — deterministic survivor selection');
  // ==========================================================================
  {
    const high = row({ id: 'low-id-but-high-quality', source: 'curated', source_quality: 95, first_seen_at: '2026-06-01T00:00:00.000Z' });
    const low = row({ id: 'aaa-early-but-low-quality', source: 'jobicy', source_quality: 85, first_seen_at: '2026-01-01T00:00:00.000Z' });
    const ranked1 = rankClusterForSurvivor([low, high]);
    assert(ranked1[0].id === high.id, 'higher source_quality wins regardless of first_seen_at or id ordering');

    const early = row({ id: 'zzz', source: 'a', source_quality: 90, first_seen_at: '2026-01-01T00:00:00.000Z' });
    const late = row({ id: 'aaa', source: 'b', source_quality: 90, first_seen_at: '2026-06-01T00:00:00.000Z' });
    const ranked2 = rankClusterForSurvivor([late, early]);
    assert(ranked2[0].id === early.id, 'tie on source_quality: earlier first_seen_at wins over a lexicographically smaller id');

    const idA = row({ id: 'AAA', source: 'a', source_quality: 90, first_seen_at: '2026-01-01T00:00:00.000Z' });
    const idB = row({ id: 'BBB', source: 'b', source_quality: 90, first_seen_at: '2026-01-01T00:00:00.000Z' });
    const ranked3 = rankClusterForSurvivor([idB, idA]);
    assert(ranked3[0].id === 'AAA', 'tie on both source_quality and first_seen_at: lexicographically smaller id wins (final deterministic tiebreak)');

    const three = [
      row({ id: 'X', source: 'jobicy', source_quality: 85 }),
      row({ id: 'Y', source: 'curated', source_quality: 95 }),
      row({ id: 'Z', source: 'arbeitnow', source_quality: 88 }),
    ];
    const ranked4 = rankClusterForSurvivor(three);
    assert(ranked4.map((r) => r.id).join(',') === 'Y,Z,X', '3-way collision ranks by source_quality desc: curated(95) > arbeitnow(88) > jobicy(85)');
    assert(ranked4.length === 3 && new Set(ranked4.map((r) => r.id)).size === 3, 'ranking never drops or duplicates a member');
  }

  // ==========================================================================
  console.log('\n3. STATIC — fingerprint hierarchy untouched, reconciliation isolation, migration additive-only');
  // ==========================================================================
  {
    try {
      const pipelineDiff = execSync('git diff HEAD -- src/lib/ingestion/pipeline.ts', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(pipelineDiff.trim() === '', 'src/lib/ingestion/pipeline.ts (the fingerprint hierarchy: deduplicateOpportunities/createNormalizedJobKey/createContentHash) has zero uncommitted diff from HEAD');
    } catch (e: any) {
      skip(`git diff check unavailable (${e.message})`);
    }

    const catalogSync = readFileSync(join(__dirname, '../src/lib/ingestion/catalog-sync.ts'), 'utf8');
    const reconcileFnMatch = catalogSync.match(/export async function reconcileCrossProviderDuplicates[\s\S]*?\n}\n/);
    assert(!!reconcileFnMatch, 'reconcileCrossProviderDuplicates() function body is present and extractable for isolation checks');
    const fnBody = reconcileFnMatch ? reconcileFnMatch[0] : '';
    assert(!/\.update\(\s*\{\s*status/.test(fnBody), 'reconcileCrossProviderDuplicates() never writes `status`');
    assert(!/consecutive_absences/.test(fnBody), 'reconcileCrossProviderDuplicates() never references `consecutive_absences`');
    assert(!/link_reachable/.test(fnBody), 'reconcileCrossProviderDuplicates() never references `link_reachable`');
    assert(/superseded_by_opportunity_id/.test(fnBody), 'reconcileCrossProviderDuplicates() does write superseded_by_opportunity_id');

    const feedRoute = readFileSync(join(__dirname, '../src/app/api/opportunities/feed/route.ts'), 'utf8');
    const getFnMatch = feedRoute.match(/export async function GET\(\)[\s\S]*?\n}\n/);
    assert(!!getFnMatch && !/supersededByOpportunityId/.test(getFnMatch![0]), 'GET handler does not filter on supersededByOpportunityId — M-adj-2(a) by-id resolution unaffected');
    const postFnMatch = feedRoute.match(/export async function POST\(req: NextRequest\)[\s\S]*$/);
    assert(!!postFnMatch && /supersededByOpportunityId/.test(postFnMatch![0]), 'POST handler does filter on supersededByOpportunityId');

    const migration = readFileSync(join(__dirname, '../supabase/migrations/018_opportunity_reconciliation.sql'), 'utf8');
    assert(migration.includes('ADD COLUMN IF NOT EXISTS superseded_by_opportunity_id'), 'migration 018 adds the one approved column');
    assert(!/DROP\s+(TABLE|COLUMN)/i.test(migration.replace(/-- DOWN:[\s\S]*/i, '')), 'migration 018\'s UP section contains no DROP (additive only; DOWN is documented separately)');
    assert(!/ALTER\s+TABLE.*ALTER\s+COLUMN/i.test(migration), 'migration 018 does not alter any existing column');

    try {
      const engineDiff = execSync('git diff HEAD -- src/lib/matching/engine.ts', { cwd: join(__dirname, '..'), encoding: 'utf8' });
      assert(engineDiff.trim() === '', 'src/lib/matching/engine.ts has zero uncommitted diff from HEAD');
    } catch (e: any) {
      skip(`git diff check unavailable (${e.message})`);
    }
  }

  // ==========================================================================
  console.log('\n4. REAL-INFRA — requires migration 018 (self-skips if not yet applied)');
  // ==========================================================================
  {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      skip('Real-infra reconciliation checks skipped — Supabase env not set.');
    } else {
      try {
        await reconcileCrossProviderDuplicates();
        skip('Real-infra reconciliation ran against the live catalog — see separate manual verification notes for the seeded-duplicate scenario (not run automatically against production data by this suite).');
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/column .*superseded_by_opportunity_id.* does not exist/i.test(msg) || /42703/.test(msg)) {
          skip(`Migration 018 not yet applied — superseded_by_opportunity_id column does not exist (${msg})`);
        } else {
          assert(false, 'reconcileCrossProviderDuplicates() ran against real Supabase without error', msg);
        }
      }
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running duplicate-reconciliation suite:', e); process.exit(1); });
