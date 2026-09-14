/**
 * Supply Discovery gate C3 — Greenhouse/Lever/Ashby ATS adapters.
 * Covers docs/c3-implementation-plan.md §11's ats-provider-suite scope:
 * per-provider response mapping (including Greenhouse's HTML-decoding
 * quirk and Ashby's structured-field mapping), real-infra fetches against
 * the seeded employers, per-employer failure isolation, and end-to-end gate
 * enforcement through the real syncOpportunitiesToCatalog() pipeline using
 * the established synthetic-prefix injection pattern (see
 * job-discovery-suite.ts) — never touching real production rows broadly.
 */
// This suite is the first to call employer-registry.ts's getApprovedEmployers()
// (and therefore getSupabaseAdminClient(), src/lib/supabase/admin.ts) directly
// from a bare Node process rather than through Next.js's server runtime, which
// has a native WebSocket global that bare Node 20 lacks. Production code is
// correct as-is (Railway's runtime works fine, per every other admin.ts
// caller in this codebase) — this polyfill is test-environment-only, same
// reasoning test/helpers/verified-session.ts already applies to its own
// client construction, never something admin.ts itself should import.
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { decodeHtmlEntities, stripHtml, GreenhouseProvider } from '../src/lib/providers/greenhouse';
import { LeverProvider } from '../src/lib/providers/lever';
import { AshbyProvider } from '../src/lib/providers/ashby';
import { getApprovedEmployers } from '../src/lib/ingestion/employer-registry';
import { syncOpportunitiesToCatalog, ProviderFetchResult } from '../src/lib/ingestion/catalog-sync';
import { RawJobPayload } from '../src/lib/providers/types';
import { hasRequiredEnv, adminClient } from './helpers/verified-session';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

function skip(message: string) {
  skipped++;
  console.log(`  – SKIP: ${message}`);
}

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C3 — GREENHOUSE / LEVER / ASHBY ATS ADAPTERS');
  console.log('==============================================================================\n');

  // ==========================================================================
  console.log('1. UNIT — Greenhouse HTML decode/strip (no infra)');
  // ==========================================================================
  assert(
    decodeHtmlEntities('&lt;div&gt;Hello &amp; welcome&lt;/div&gt;') === '<div>Hello & welcome</div>',
    'decodeHtmlEntities correctly reverses the double-encoding Greenhouse\'s content field carries'
  );
  {
    const out = stripHtml('&lt;p&gt;We are &lt;strong&gt;hiring&lt;/strong&gt; today&lt;/p&gt;');
    assert(
      out.includes('We are') && out.includes('hiring') && out.includes('today') && !out.includes('&lt;') && !out.includes('<'),
      `stripHtml decodes entities THEN strips tags — a raw tag-strip alone would never match the escaped tags (got "${out}")`
    );
  }
  assert(
    !stripHtml('&lt;script&gt;evil()&lt;/script&gt;Safe text').includes('<'),
    'no literal HTML tag characters survive stripHtml, even after decoding'
  );
  assert(
    decodeHtmlEntities('&#65;&#66;&#67;') === 'ABC',
    'numeric HTML entities are decoded correctly'
  );

  // ==========================================================================
  console.log('\n2. REAL-INFRA — live fetch against seeded employers (self-skips if env unavailable)');
  // ==========================================================================
  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — real-infra section skipped.');
  } else {
    const admin = adminClient();

    const ghEmployers = await getApprovedEmployers('greenhouse');
    assert(ghEmployers.length >= 10, `at least 10 approved Greenhouse employers seeded (got ${ghEmployers.length})`);
    const leverEmployers = await getApprovedEmployers('lever');
    assert(leverEmployers.length >= 5, `at least 5 approved Lever employers seeded (got ${leverEmployers.length})`);
    const ashbyEmployers = await getApprovedEmployers('ashby');
    assert(ashbyEmployers.length >= 8, `at least 8 approved Ashby employers seeded (got ${ashbyEmployers.length})`);

    console.log('\n  2a. Greenhouse — real fetch');
    const ghJobs = await new GreenhouseProvider().fetchJobs();
    assert(ghJobs.length > 100, `Greenhouse provider returns real jobs across all seeded employers (got ${ghJobs.length})`);
    assert(ghJobs.every((j) => j.source === 'greenhouse'), 'every Greenhouse job is tagged source=greenhouse');
    assert(ghJobs.every((j) => j.sourceId.startsWith('greenhouse-')), 'every Greenhouse sourceId is namespaced by platform+board, never colliding across employers');
    assert(ghJobs.every((j) => !j.description.includes('&lt;') && !j.description.includes('&gt;')), 'no Greenhouse job description contains un-decoded HTML entities');
    assert(ghJobs.every((j) => !/<[a-z][\s\S]*>/i.test(j.description)), 'no Greenhouse job description contains raw HTML tags after stripping');
    assert(new Set(ghJobs.map((j) => j.company)).size >= 10, 'Greenhouse jobs span multiple distinct real employer names, not one hardcoded company');
    assert(ghJobs.every((j) => j.officialUrl.startsWith('https://')), 'every Greenhouse job has a real https officialUrl');

    console.log('\n  2b. Lever — real fetch');
    const leverJobs = await new LeverProvider().fetchJobs();
    assert(leverJobs.length > 0, `Lever provider returns real jobs (got ${leverJobs.length})`);
    assert(leverJobs.every((j) => j.source === 'lever'), 'every Lever job is tagged source=lever');
    assert(leverJobs.every((j) => !Number.isNaN(new Date(j.publicationDate).getTime())), 'every Lever job has a parseable publicationDate derived from createdAt');

    console.log('\n  2c. Ashby — real fetch');
    const ashbyJobs = await new AshbyProvider().fetchJobs();
    assert(ashbyJobs.length > 0, `Ashby provider returns real jobs (got ${ashbyJobs.length})`);
    assert(ashbyJobs.every((j) => j.source === 'ashby'), 'every Ashby job is tagged source=ashby');
    assert(
      ashbyJobs.some((j) => j.locationString?.toLowerCase().includes('remote')),
      'Ashby\'s structured isRemote field is folded into locationString (richer signal than Greenhouse\'s free-text-only location)'
    );

    // ========================================================================
    console.log('\n  2d. Per-employer failure isolation (seeds one deliberately-broken employer)');
    // ========================================================================
    const brokenBoard = 'this-board-definitely-does-not-exist-c3-test';
    const { data: brokenSource } = await admin
      .from('supply_sources')
      .insert({
        platform_slug: 'greenhouse', board: brokenBoard, employer_name: 'C3 Test Broken Employer',
        endpoint_template: `https://boards-api.greenhouse.io/v1/boards/${brokenBoard}/jobs`,
        acquisition_method: 'http_json', extraction_method: 'native_adapter', auth_requirement: 'none',
        permission_basis: 'public_ats_read', review_status: 'approved', reviewed_at: new Date().toISOString(),
        reviewed_by: 'ats-provider-suite-test', review_reason: 'transient test row', status: 'active',
      })
      .select('id')
      .single();
    const { data: brokenEmployer } = await admin
      .from('allowlist_employers')
      .insert({
        canonical_name: 'C3 Test Broken Employer', official_domain: 'c3-test-broken-employer.example',
        career_url: `https://boards.greenhouse.io/${brokenBoard}`, ats_provider: 'greenhouse',
        remote_evidence: 'test fixture', review_status: 'approved', reviewed_at: new Date().toISOString(),
        reviewed_by: 'ats-provider-suite-test', linked_source_id: brokenSource?.id,
      })
      .select('id')
      .single();

    try {
      const jobsWithBrokenEmployer = await new GreenhouseProvider().fetchJobs();
      assert(
        jobsWithBrokenEmployer.length >= ghJobs.length,
        `one broken employer never reduces the OTHER employers' job counts — sibling employers still return their jobs (before=${ghJobs.length}, with-broken=${jobsWithBrokenEmployer.length})`
      );
      assert(
        jobsWithBrokenEmployer.every((j) => !j.sourceId.includes(brokenBoard)),
        'the broken employer itself contributes zero jobs, but does not throw or abort the provider run'
      );

      const { data: afterFailure } = await admin
        .from('supply_sources')
        .select('consecutive_fetch_failures')
        .eq('id', brokenSource?.id)
        .single();
      assert(
        (afterFailure?.consecutive_fetch_failures ?? 0) >= 1,
        `the broken employer's own failure is recorded on its supply_sources row (got consecutive_fetch_failures=${afterFailure?.consecutive_fetch_failures})`
      );
    } finally {
      if (brokenEmployer?.id) await admin.from('allowlist_employers').delete().eq('id', brokenEmployer.id);
      if (brokenSource?.id) await admin.from('supply_sources').delete().eq('id', brokenSource.id);
    }

    // ========================================================================
    console.log('\n  2e. End-to-end gate enforcement via the real sync pipeline (synthetic-prefixed, cleaned up)');
    // ========================================================================
    const PREFIX = 'c3-gate-test-';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const hoursAgoIso = (h: number) => new Date(now - h * 3600 * 1000).toISOString();

    const freshWorldwideId = `${PREFIX}fresh-worldwide-${suffix}`;
    const staleId = `${PREFIX}stale-${suffix}`;
    const unknownScopeId = `${PREFIX}unknown-scope-${suffix}`;
    const deadLinkId = `${PREFIX}dead-link-${suffix}`;

    // Each job gets a DISTINCT title/description (embedding its own
    // sourceId) — the existing cross-provider dedup keys on normalized
    // company+title+content hash (createNormalizedJobKey/createContentHash),
    // completely independent of sourceId/officialUrl. Identical fixture
    // text across all 4 candidates would make them look like the same
    // duplicate job and collapse to one, silently hiding 3 of the 4 gate
    // checks below — this is a test-fixture requirement, not a workaround
    // for any gate itself.
    const makeJob = (sourceId: string, overrides: Partial<RawJobPayload>): RawJobPayload => ({
      source: 'greenhouse', sourceId, title: `C3 Gate Test Position (${sourceId})`, company: `C3 Test Co (${sourceId})`,
      description: `${'A'.repeat(150)} ${sourceId}`, officialUrl: 'https://example.com', jobType: 'Full-time',
      publicationDate: hoursAgoIso(3), locationString: 'Worldwide', ...overrides,
    });

    const jobs: RawJobPayload[] = [
      makeJob(freshWorldwideId, { publicationDate: hoursAgoIso(3), locationString: 'Worldwide' }),
      makeJob(staleId, { publicationDate: hoursAgoIso(72), locationString: 'Worldwide' }),
      makeJob(unknownScopeId, { publicationDate: hoursAgoIso(3), locationString: '' }),
      // A real, resolvable domain with a path guaranteed not to exist —
      // verifyLinkFreshness() only classifies a genuine HTTP 404/410 as
      // dead; a DNS/network failure is deliberately fail-OPEN (treated as
      // reachable, to avoid false drops from transient local network
      // issues) — a fake nonexistent domain would test the wrong branch.
      makeJob(deadLinkId, { publicationDate: hoursAgoIso(3), locationString: 'Worldwide', officialUrl: 'https://example.com/c3-test-genuinely-nonexistent-path-404' }),
    ];

    const fetchResult: ProviderFetchResult = {
      outcomes: [{ sourceKey: 'greenhouse', success: true, jobCount: jobs.length }],
      successfulRaw: new Map([['greenhouse', jobs]]),
    };

    try {
      await syncOpportunitiesToCatalog(fetchResult, { absenceScanSourceIdPrefix: PREFIX });

      const readRow = async (sourceId: string) => {
        const { data } = await admin.from('opportunities').select('status').eq('source', 'greenhouse').eq('source_id', sourceId).maybeSingle();
        return data;
      };

      const freshRow = await readRow(freshWorldwideId);
      assert(!!freshRow, 'a fresh, worldwide, reachable-link ATS candidate WAS inserted into the catalog');
      assert(freshRow?.status === 'active', `the fresh candidate reached 'active' status (URL validation ran and passed) (got ${freshRow?.status})`);

      const staleRow = await readRow(staleId);
      assert(!staleRow, 'a candidate posted 72h ago (stale) was REJECTED — never inserted at all, per the 48h freshness gate');

      const unknownRow = await readRow(unknownScopeId);
      assert(!unknownRow, 'a candidate with no location/remote-scope information was REJECTED — never inserted, per the remote-eligibility gate');

      const deadRow = await readRow(deadLinkId);
      assert(!!deadRow, 'a fresh, worldwide candidate with a dead officialUrl WAS inserted (freshness/remote gates only reject on those two axes)');
      assert(deadRow?.status === 'expired', `but it correctly resolved to 'expired' via the existing verifyNewOrReappearedJob link check — the exact mechanism that prevents another six dead curated listings (got ${deadRow?.status})`);
    } finally {
      await admin.from('opportunities').delete().eq('source', 'greenhouse').like('source_id', `${PREFIX}%`);
      const { data: leftover } = await admin.from('opportunities').select('source_id').eq('source', 'greenhouse').like('source_id', `${PREFIX}%`);
      assert((leftover ?? []).length === 0, `no test rows from this run remain after cleanup (found ${(leftover ?? []).length})`);
    }
  }

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running ats-provider suite:', e); process.exit(1); });
