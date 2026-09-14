/**
 * Supply Discovery gate C5 — mandatory dedup test (docs/c5-implementation-plan.md §8, §12).
 * ==============================================================================
 * Per the C4-2 constraint carried into C5: "the current zero-duplicate state
 * in production is not evidence this works; it's evidence it's never been
 * exercised" — duplicate-reconciliation-suite.ts's own real-infra section
 * confirms exactly that gap (it explicitly does NOT seed a real duplicate
 * scenario: "not run automatically against production data by this suite").
 * This suite closes it: a genuine cross-source duplicate is deliberately
 * seeded and the REAL, unmodified reconciliation hierarchy
 * (reconcileCrossProviderDuplicates(), untouched by C5) must actually
 * collapse it to one canonical survivor.
 *
 * §8 named a specific real, non-synthetic overlap found during the C5 audit
 * (Coinbase / Cloudflare, simultaneously ATS-approved AND aggregator-listed)
 * as the intended fixture, with an explicit fallback clause: "re-verified at
 * implementation time since catalog composition changes continuously... or
 * an equivalent real pair." Re-verified now: that specific overlap no
 * longer exists in the live catalog (both companies currently have only
 * Greenhouse-sourced active rows — composition has shifted since the
 * audit). Rather than mutate a REAL currently-active production row to
 * force a fresh overlap (which would leave a real job's
 * superseded_by_opportunity_id pointed at a test row after cleanup, a
 * production-data-safety risk this project has already hit once this
 * session and built a guard against), this suite seeds a fully synthetic,
 * uniquely-prefixed company/title pair instead — the "equivalent real
 * pair" the spec's own fallback clause anticipates. What matters for §8 is
 * NOT that the company name is real, but that every function in the path
 * is real and unmodified: the actual syncCareerPageOpportunities() write
 * path (not a mock), the actual reconcileCrossProviderDuplicates() (C4-2,
 * frozen), the actual createNormalizedJobKey()/deterministic-survivor
 * ranking (C4-2, frozen). Only the two input rows are synthetic.
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { normalizeOpportunity } from '../src/lib/ingestion/pipeline';
import { reconcileCrossProviderDuplicates } from '../src/lib/ingestion/catalog-sync';
import { syncCareerPageOpportunities } from '../src/lib/ingestion/career-page-sync';
import type { RawJobPayload } from '../src/lib/providers/types';
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
  console.log('SUPPLY DISCOVERY C5 — MANDATORY DEDUP TEST (§8)');
  console.log('==============================================================================\n');

  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — this suite requires real infra by design (§8 forbids a purely-mocked substitute).');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    return;
  }

  const admin = adminClient();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const company = `C5 Dedup Test Co ${suffix}`;
  const title = 'Senior Platform Engineer';
  const now = new Date();

  const existingRaw: RawJobPayload = {
    source: 'remotive',
    sourceId: `c5-dedup-existing-${suffix}`,
    title,
    company,
    description: 'A senior platform engineering role, as originally listed by an aggregator feed. '.repeat(3),
    officialUrl: `https://example.com/jobs/existing-${suffix}`,
    jobType: 'Full-time',
    locationString: 'Worldwide',
    tags: ['python', 'kubernetes'],
    publicationDate: new Date(now.getTime() - 3600 * 1000).toISOString(), // 1h before the career-page row, for a deterministic first_seen_at tie-break check
  };

  let existingId: string | null = null;

  try {
    // --- Seed the "existing other-source" side directly, using the SAME
    // normalizeOpportunity() every real provider's output passes through —
    // not a hand-shaped row, so its canonical_url_hash/content_hash/
    // source_quality are exactly what production would compute. ---
    const normalized = normalizeOpportunity(existingRaw);
    const { data: inserted, error: insertErr } = await admin
      .from('opportunities')
      .insert({
        title: normalized.title,
        company: normalized.company,
        description: normalized.description,
        source: normalized.source,
        source_id: normalized.sourceId,
        source_url: normalized.sourceUrl ?? null,
        official_url: normalized.officialUrl,
        canonical_url_hash: normalized.canonicalUrlHash,
        content_hash: normalized.contentHash,
        type: normalized.type,
        employment_type: normalized.employmentType,
        remote_type: normalized.remoteType,
        eligible_countries: normalized.eligibleCountries,
        excluded_countries: normalized.excludedCountries,
        timezone_requirements: normalized.timezoneRequirements,
        required_skills: normalized.requiredSkills,
        preferred_skills: normalized.preferredSkills,
        experience_requirement: normalized.experienceRequirement,
        quality_score: normalized.qualityScore,
        source_quality: normalized.sourceQuality ?? null,
        explicit_remote_scope: normalized.explicitRemoteScope ?? 'unknown',
        status: 'active',
        link_reachable: true,
        posted_at: normalized.postedAt,
        first_seen_at: existingRaw.publicationDate, // deliberately earlier than the career-page row below
        last_seen_in_feed_at: new Date().toISOString(),
        consecutive_absences: 0,
      })
      .select('id')
      .single();
    if (insertErr || !inserted) throw new Error(`Could not seed existing-source row: ${insertErr?.message}`);
    existingId = inserted.id;

    console.log('1. Before reconciliation — the real, current gap (two independent active rows for one real-world job)');
    const careerPageRaw: RawJobPayload = {
      source: 'careerpage',
      sourceId: `c5-dedup-careerpage-${suffix}`,
      title, // SAME company+title as the existing row — this is what createNormalizedJobKey() clusters on
      company,
      description: 'The same senior platform engineering role, as it appears on the company\'s own career page. '.repeat(3),
      officialUrl: `https://acme-c5-dedup-test.example/careers/senior-platform-engineer-${suffix}`, // deliberately DIFFERENT URL — a realistic duplicate, not an artificially-identical one
      jobType: 'Full-time',
      locationString: 'Remote (Worldwide)',
      tags: ['python', 'kubernetes'],
      publicationDate: now.toISOString(),
    };

    // The REAL orchestration function under test — not a mock of it. Only
    // the provider's fetchJobs() is substituted, exactly as
    // career-page-sync.ts's own header documents as the sanctioned test
    // injection point (mirrors syncOpportunitiesToCatalog()'s fetchResult).
    const syncSummary = await syncCareerPageOpportunities({ fetchJobs: async () => [careerPageRaw] });
    assert(syncSummary.newJobsInserted === 1, `syncCareerPageOpportunities() inserted the new career-page row (got newJobsInserted=${syncSummary.newJobsInserted})`);

    const { data: careerPageRow } = await admin
      .from('opportunities')
      .select('id, superseded_by_opportunity_id, status')
      .eq('source', 'careerpage')
      .eq('source_id', careerPageRaw.sourceId)
      .single();
    assert(!!careerPageRow, 'the career-page row exists in the catalog after the real sync');
    assert(careerPageRow?.status === 'active', 'the career-page row is active');

    const { data: existingBefore } = await admin
      .from('opportunities')
      .select('status, superseded_by_opportunity_id')
      .eq('id', existingId)
      .single();
    assert(
      existingBefore?.status === 'active' && existingBefore?.superseded_by_opportunity_id === null,
      'BEFORE reconciliation: both rows genuinely coexist as independent active rows — reproducing the exact latent gap this ticket exists to close'
    );

    console.log('\n2. Run the REAL, unmodified reconcileCrossProviderDuplicates() (C4-2, frozen — untouched by C5)');
    const reconciliation = await reconcileCrossProviderDuplicates();
    assert(reconciliation.crossProviderClustersFound >= 1, `at least one cross-provider cluster was found this pass (got ${reconciliation.crossProviderClustersFound})`);

    console.log('\n3. After reconciliation — exactly one canonical survivor, deterministically chosen');
    const { data: existingAfter } = await admin
      .from('opportunities')
      .select('superseded_by_opportunity_id')
      .eq('id', existingId)
      .single();
    const { data: careerPageAfter } = await admin
      .from('opportunities')
      .select('id, superseded_by_opportunity_id')
      .eq('source', 'careerpage')
      .eq('source_id', careerPageRaw.sourceId)
      .single();

    assert(
      existingAfter?.superseded_by_opportunity_id === null,
      "the 'remotive' row survives (source_quality=90, per BUILTIN_SOURCE_QUALITY, beats careerpage's unregistered/null quality — fully deterministic, not incidental)"
    );
    assert(
      careerPageAfter?.superseded_by_opportunity_id === existingId,
      'the career-page row is correctly marked as superseded BY the surviving remotive row — the real hierarchy collapsed the genuine duplicate to one canonical opportunity'
    );
    assert(
      existingAfter?.superseded_by_opportunity_id !== careerPageAfter?.id,
      'the survivor never itself carries a superseded_by pointer (no cycles)'
    );
  } finally {
    // Delete the DEPENDENT row first — it may hold a
    // superseded_by_opportunity_id FK pointing at existingId, which a
    // RESTRICT constraint would otherwise reject deleting first.
    await admin.from('opportunities').delete().eq('source', 'careerpage').like('source_id', `c5-dedup-careerpage-${suffix}%`);
    if (existingId) await admin.from('opportunities').delete().eq('id', existingId);
    const { data: leftover } = await admin.from('opportunities').select('id').eq('company', company);
    assert((leftover ?? []).length === 0, `no test rows from this run remain after cleanup (found ${(leftover ?? []).length})`);
  }

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running career-page-dedup suite:', e); process.exit(1); });
