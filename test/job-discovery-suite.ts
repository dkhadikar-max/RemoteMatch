/**
 * H — Job Discovery UX.
 * ==============================================================================
 *   1. Presentation helpers (pure) — formatPostedAge / formatSalary: honest,
 *      never fabricated ("$140k – $180k" / "Benchmark verified" are gone).
 *   2. Freshness filter (pure) — applyFilters `postedWithinDays` is removal-only:
 *      keeps ≤ N days, drops older, excludes unparseable dates, never reorders
 *      or mutates fitScore.
 *   3. Trust static checks — no fabricated salary literal on the card, no <img>
 *      / "Benchmark verified" in the details modal, no stock-photo "logos" in
 *      the curated fixtures.
 *   4. Posting-date immutability (DB) — `posted_at` is stamped once on insert
 *      and NEVER changed by a later sync, even when the provider sends a
 *      different publicationDate; first_seen_at is a separate concept.
 *
 * Run: set -a && source .env.local && set +a && npx tsx test/job-discovery-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import type { CanonicalOpportunity } from '../src/types/byn';
import { formatPostedAge, formatSalary } from '../src/lib/feed/job-card-format';
import { applyFilters } from '../src/lib/feed/apply-filters';
import { syncOpportunitiesToCatalog, type ProviderFetchResult } from '../src/lib/ingestion/catalog-sync';
import type { RawJobPayload } from '../src/lib/providers/types';
import { hasRequiredEnv, adminClient } from './helpers/verified-session';

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function opp(over: Partial<CanonicalOpportunity>): CanonicalOpportunity {
  return {
    id: 'opp-x', type: 'job', title: 'Role', company: 'Co', description: 'd',
    source: 'remotive', sourceId: 's', officialUrl: 'https://e.co', canonicalUrlHash: 'h', contentHash: 'c',
    employmentType: 'Full-time', remoteType: 'Worldwide', eligibleCountries: [], excludedCountries: [],
    timezoneRequirements: [], requiredSkills: [], preferredSkills: [], qualityScore: 80,
    status: 'active', isActive: true, postedAt: daysAgo(1), lastVerifiedAt: daysAgo(1),
    ...over,
  };
}

async function run() {
  console.log('='.repeat(78));
  console.log('H — JOB DISCOVERY UX');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. PRESENTATION HELPERS (pure, honest)');
  // ==========================================================================
  {
    assert(formatPostedAge(undefined) === null, 'no date → null (render nothing)');
    assert(formatPostedAge('not-a-date') === null, 'garbage date → null');
    assert(formatPostedAge(daysAgo(0)) === 'Posted today', 'now → "Posted today"');
    assert(formatPostedAge(new Date(Date.now() + 5 * DAY).toISOString()) === 'Posted today', 'future date (clock skew) → "Posted today"');
    assert(formatPostedAge(daysAgo(3)) === 'Posted 3d ago', '3 days → "Posted 3d ago"');
    assert(formatPostedAge(daysAgo(29)) === 'Posted 29d ago', '29 days → "Posted 29d ago"');
    assert(formatPostedAge(daysAgo(30)) === 'Posted 30d+ ago', '30 days → "Posted 30d+ ago"');
    assert(formatPostedAge(daysAgo(400)) === 'Posted 30d+ ago', '400 days → "Posted 30d+ ago"');

    assert(formatSalary({ salaryMin: 120000, salaryMax: 160000 }) === '$120k – $160k', 'range');
    assert(formatSalary({ salaryMin: 120000 }) === '$120k', 'min only → "$120k"');
    assert(formatSalary({ salaryMax: 160000 }) === '$160k', 'max only → "$160k"');
    assert(formatSalary({ salaryMin: 120000, salaryMax: 120000 }) === '$120k', 'equal min/max → single');
    assert(formatSalary({}) === 'Salary not listed', 'nothing → "Salary not listed"');
    assert(formatSalary({ salaryMin: 0, salaryMax: 0 }) === 'Salary not listed', 'zeroes → "Salary not listed"');
    assert(!/\$1?40k\s*–\s*\$1?80k/.test(formatSalary({})), 'never emits the old fabricated "$140k – $180k" band');
  }

  // ==========================================================================
  console.log('\n2. FRESHNESS FILTER (applyFilters — removal-only)');
  // ==========================================================================
  {
    const deck = [
      opp({ id: 'a', postedAt: daysAgo(0), fitScore: 50 }),
      opp({ id: 'b', postedAt: daysAgo(2), fitScore: 90 }),
      opp({ id: 'c', postedAt: daysAgo(10), fitScore: 70 }),
      opp({ id: 'd', postedAt: daysAgo(40), fitScore: 95 }),
      opp({ id: 'e', postedAt: 'garbage', fitScore: 60 }),
    ];

    assert(applyFilters(deck, {}).length === 5, 'no filter → deck unchanged');

    const within7 = applyFilters(deck, { postedWithinDays: 7 }).map((o) => o.id);
    assert(JSON.stringify(within7) === JSON.stringify(['a', 'b']), `"7 days" keeps only a,b (got ${within7.join(',')})`);

    const within30 = applyFilters(deck, { postedWithinDays: 30 }).map((o) => o.id);
    assert(JSON.stringify(within30) === JSON.stringify(['a', 'b', 'c']), `"30 days" keeps a,b,c (got ${within30.join(',')})`);

    assert(!applyFilters(deck, { postedWithinDays: 30 }).some((o) => o.id === 'e'), 'an unparseable postedAt is excluded while the freshness filter is active');
    assert(applyFilters(deck, {}).some((o) => o.id === 'e'), 'the same row is kept when no freshness filter is set');

    // removal-only: order + fitScores of survivors are byte-identical to input order
    const survivors = applyFilters(deck, { postedWithinDays: 30 }).map((o) => `${o.id}:${o.fitScore}`);
    assert(survivors.join(',') === 'a:50,b:90,c:70', 'filter preserves input order + fitScores exactly (no re-rank, no mutation)');
  }

  // ==========================================================================
  console.log('\n3. TRUST STATIC CHECKS');
  // ==========================================================================
  {
    const card = readFileSync(join(__dirname, '../src/components/feed/job-card.tsx'), 'utf8');
    const modal = readFileSync(join(__dirname, '../src/components/feed/job-details-modal.tsx'), 'utf8');
    const curated = readFileSync(join(__dirname, '../src/lib/providers/curated.ts'), 'utf8');

    assert(!/['"`]\$1?40k\s*–\s*\$1?80k['"`]/.test(card), 'job-card has no hardcoded "$140k – $180k" salary literal');
    assert(card.includes('formatSalary') && card.includes('formatPostedAge'), 'job-card uses the honest formatters');
    assert(!/<img\b/.test(modal), 'job-details-modal renders no <img> (no unverified logo)');
    assert(!/Benchmark verified/.test(modal), 'job-details-modal has no "Benchmark verified" fabrication');
    assert(!/unsplash\.com/.test(curated) && !/companyLogo/.test(curated), 'curated fixtures carry no stock-photo "companyLogo"');
  }

  if (!hasRequiredEnv()) {
    console.log('\n(Skipping DB section — Supabase env not set.)');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  // ==========================================================================
  console.log('\n4. POSTING-DATE IMMUTABILITY (posted_at is insert-only)');
  // ==========================================================================
  {
    const admin = adminClient();
    const PREFIX = 'jobdisc-test-';
    const sourceId = `${PREFIX}posted-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const OPTS = { absenceScanSourceIdPrefix: PREFIX };
    const REACHABLE = 'https://example.com';

    const makeJob = (publicationDate: string): RawJobPayload => ({
      source: 'remotive', sourceId, title: 'Immutability Probe', company: 'Probe Co',
      description: 'A'.repeat(150), officialUrl: REACHABLE, jobType: 'Full-time', publicationDate,
    });
    const fr = (job: RawJobPayload): ProviderFetchResult => ({
      outcomes: [{ sourceKey: 'remotive', success: true, jobCount: 1 }],
      successfulRaw: new Map([['remotive', [job]]]),
    });
    const readRow = async () => {
      const { data } = await admin.from('opportunities')
        .select('posted_at, first_seen_at, last_seen_in_feed_at')
        .eq('source', 'remotive').eq('source_id', sourceId).maybeSingle();
      return data as { posted_at: string; first_seen_at: string; last_seen_in_feed_at: string } | null;
    };

    try {
      const DATE_X = daysAgo(20);
      await syncOpportunitiesToCatalog(fr(makeJob(DATE_X)), OPTS);
      const r1 = await readRow();
      assert(!!r1 && new Date(r1!.posted_at).getTime() === new Date(DATE_X).getTime(),
        `first sync: posted_at == the provider's publicationDate (${r1?.posted_at})`);
      assert(!!r1 && Math.abs(Date.now() - new Date(r1!.first_seen_at).getTime()) < 5 * 60 * 1000,
        'first_seen_at ≈ now (a catalog-presence timestamp, NOT the posting date)');
      assert(!!r1 && new Date(r1!.first_seen_at).getTime() !== new Date(r1!.posted_at).getTime(),
        'first_seen_at and posted_at are distinct concepts (different values here)');

      await new Promise((res) => setTimeout(res, 1100));
      const DATE_Y = daysAgo(2);
      await syncOpportunitiesToCatalog(fr(makeJob(DATE_Y)), OPTS); // same job, NEWER provided date
      const r2 = await readRow();
      assert(!!r2 && new Date(r2!.posted_at).getTime() === new Date(DATE_X).getTime(),
        `second sync with a changed publicationDate leaves posted_at UNCHANGED (still ${DATE_X}, got ${r2?.posted_at})`);
      assert(!!r2 && new Date(r2!.last_seen_in_feed_at).getTime() > new Date(r1!.last_seen_in_feed_at).getTime(),
        'last_seen_in_feed_at DID advance on the re-sync (feed-presence tracking still works)');
    } finally {
      await admin.from('opportunities').delete().eq('source', 'remotive').eq('source_id', sourceId);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running job-discovery suite:', e); process.exit(1); });
