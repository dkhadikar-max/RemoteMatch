/**
 * RemoteMatch — Live Supply Activation: production smoke test (Step 8)
 * ==============================================================================
 * The last gate of the approved verification order, run against a live
 * server (BASE_URL) and the real Supabase project this session has been
 * testing against throughout — the same single-deploy database referenced
 * by NEXT_PUBLIC_SUPABASE_URL. This is NOT a substitute for steps 1-7 (the
 * deterministic lifecycle/RLS/SEO/P0/P1 suites) — it proves the exact code
 * that will be deployed behaves correctly end-to-end over real HTTP against
 * real infrastructure, one time, immediately before a deploy decision.
 *
 * Covers exactly the 12 points of the approved smoke checklist:
 *   1. Migration 010 is actually present.
 *   2. Existing active catalog remains readable.
 *   3. A real provider sync succeeds (through the actual secured HTTP route,
 *      not the test-only fetchResult-injection path).
 *   4-6. Lifecycle correctness for jobs newly introduced by this real sync
 *      (unknown->active/expired immediately, never left unknown for a
 *      non-curated row) — the exact state-machine sequences themselves
 *      (provider-failure-is-never-an-absence, 3x-omission-expires) are
 *      NOT re-proven here nondeterministically; that determinism guarantee
 *      already comes from test/live-supply-suite.ts (17/17) exercising the
 *      identical function this route calls with no injected fetchResult.
 *      This section confirms only that the real HTTP path reaches that same
 *      function and that its immediate-verification guarantee holds for
 *      whatever real rows actually appeared this cycle.
 *   7. /feed (the API route) consumes the DB-backed active catalog.
 *   8-9. A real right swipe produces the original P0 decision snapshot AND
 *      the three P1 attributes survive the production path.
 *   10. Public /remote-jobs, a category hub, a job detail page, and the
 *      sitemap all work.
 *   11. Expired/permanently-removed SEO behavior (noindex / 410) is intact.
 *   12. Auth/quota behavior is unchanged (spot check only — full coverage
 *      already in auth-invariant-suite.ts / monetization-suite.ts).
 *
 * REQUIRES:
 *   - A running server at BASE_URL (default http://localhost:3000)
 *   - NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
 *     SUPABASE_SERVICE_ROLE_KEY, matching what the running server itself uses
 *   - INGESTION_SYNC_SECRET, matching what the running server has configured
 *     for the /sync route (this suite skips the sync-endpoint checks, not
 *     the whole file, if it's absent — same pattern as the STRIPE group in
 *     security-remediation-suite.ts)
 *
 * Run: npx tsx test/production-smoke.ts
 */
import { hasRequiredEnv, adminClient, anonKeyClient, newVerifiedSession } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const INGESTION_SYNC_SECRET = process.env.INGESTION_SYNC_SECRET;

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function skip(message: string) {
  console.log(`  – SKIP: ${message}`);
  skipped++;
}

async function run() {
  console.log('='.repeat(78));
  console.log('LIVE SUPPLY ACTIVATION — PRODUCTION SMOKE TEST (STEP 8)');
  console.log(`Target: ${BASE_URL}`);
  console.log('='.repeat(78));

  if (!hasRequiredEnv()) {
    console.log('Required Supabase env vars are not all set — cannot run this smoke test.');
    process.exitCode = 1;
    return;
  }

  const admin = adminClient();
  const anon = anonKeyClient();

  // --------------------------------------------------------------------
  // 1. Migration 010 present
  // --------------------------------------------------------------------
  console.log('\n1. MIGRATION 010 PRESENT');
  {
    const probeId = `smoke-migration-probe-${Date.now()}`;
    const { error: insertErr } = await admin.from('opportunities').insert({
      source: 'curated',
      source_id: probeId,
      type: 'job',
      title: 'Migration probe (deleted immediately)',
      company: 'Smoke Test',
      description: 'A'.repeat(150),
      official_url: 'https://example.com',
      canonical_url_hash: `hash-${probeId}`,
      content_hash: `content-${probeId}`,
      employment_type: 'full_time',
      remote_type: 'worldwide',
      eligible_countries: [],
      excluded_countries: [],
      timezone_requirements: [],
      salary_currency: 'USD',
      required_skills: [],
      preferred_skills: [],
      quality_score: 0,
      status: 'unknown', // proves the 'unknown' status value is accepted by the check constraint
      posted_at: new Date().toISOString(),
      link_reachable: null,
      link_checked_at: null,
      consecutive_absences: 0,
      first_seen_at: new Date().toISOString(),
      last_seen_in_feed_at: new Date().toISOString(),
      is_permanently_removed: false,
      explicit_remote_scope: 'unknown',
      source_quality: 1,
      description_completeness: 'high',
      salary_quality: 'unspecified',
      remote_policy_confidence: 'high',
    });
    assert(!insertErr, `Migration 010's 'unknown' status + all new columns are accepted by a real insert${insertErr ? ` (${insertErr.message})` : ''}`);

    const { data: probeRow, error: selectErr } = await admin
      .from('opportunities')
      .select('status, last_verified_at')
      .eq('source', 'curated')
      .eq('source_id', probeId)
      .maybeSingle();
    assert(!selectErr && probeRow?.status === 'unknown', 'Inserted probe row reads back with status=unknown');
    assert(!selectErr && 'last_verified_at' in (probeRow ?? {}), "Deprecated 'last_verified_at' column is still present (not dropped)");

    await admin.from('opportunities').delete().eq('source', 'curated').eq('source_id', probeId);
  }

  // --------------------------------------------------------------------
  // 2. Existing active catalog remains readable
  // --------------------------------------------------------------------
  console.log('\n2. EXISTING ACTIVE CATALOG REMAINS READABLE');
  let activeCountBefore = 0;
  {
    const { data, error } = await anon.from('opportunities').select('id, source_id, first_seen_at').eq('status', 'active');
    assert(!error, `Anon (RLS-scoped) read of active opportunities succeeds${error ? `: ${error.message}` : ''}`);
    activeCountBefore = data?.length ?? 0;
    assert(activeCountBefore > 0, `At least one active job is readable via RLS before this smoke run's sync (got ${activeCountBefore})`);
  }

  // --------------------------------------------------------------------
  // 3. A real provider sync succeeds, through the actual secured route
  // --------------------------------------------------------------------
  console.log('\n3. REAL PROVIDER SYNC VIA THE ACTUAL SECURED /sync ROUTE');
  let syncNewJobFirstSeenAfter: string | null = null;
  if (!INGESTION_SYNC_SECRET) {
    skip('INGESTION_SYNC_SECRET not set in this environment — cannot exercise the secured /sync route');
    skip('(4-6) lifecycle-on-real-sync checks depend on this section\'s sync run');
  } else {
    const noAuthRes = await fetch(`${BASE_URL}/api/opportunities/sync`, { method: 'POST' });
    assert(noAuthRes.status === 401, `POST /api/opportunities/sync with no Authorization is rejected (got ${noAuthRes.status})`);

    const wrongAuthRes = await fetch(`${BASE_URL}/api/opportunities/sync`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-the-real-secret' },
    });
    assert(wrongAuthRes.status === 401, `POST /api/opportunities/sync with a wrong secret is rejected (got ${wrongAuthRes.status})`);

    syncNewJobFirstSeenAfter = new Date().toISOString();
    const realRes = await fetch(`${BASE_URL}/api/opportunities/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${INGESTION_SYNC_SECRET}` },
    });
    const realBody = await realRes.json().catch(() => null);
    assert(realRes.status === 200 && realBody?.success === true, `POST /api/opportunities/sync with the real secret succeeds (got ${realRes.status}, success=${realBody?.success})`);
    const outcomes: Array<{ sourceKey: string; success: boolean; jobCount: number }> = realBody?.providerOutcomes ?? [];
    console.log(`   Provider outcomes: ${outcomes.map((o) => `${o.sourceKey}=${o.success ? 'ok(' + o.jobCount + ')' : 'FAILED'}`).join(', ')}`);
    assert(outcomes.length === 4, `All 4 providers (curated/remotive/arbeitnow/jobicy) reported an outcome (got ${outcomes.length})`);
    assert(outcomes.some((o) => o.success), 'At least one live provider succeeded this cycle');
  }

  // --------------------------------------------------------------------
  // 4-6. Lifecycle correctness for whatever this real sync introduced
  // --------------------------------------------------------------------
  console.log('\n4-6. LIFECYCLE CORRECTNESS ON REAL SYNC OUTPUT (unknown never persists for a live row)');
  if (!INGESTION_SYNC_SECRET || !syncNewJobFirstSeenAfter) {
    skip('No real sync ran this session (see section 3) — skipping');
  } else {
    const { data: newRows, error } = await admin
      .from('opportunities')
      .select('source, source_id, status, link_reachable, link_checked_at')
      .neq('source', 'curated')
      .gte('first_seen_at', syncNewJobFirstSeenAfter);
    if (error) {
      assert(false, `Could not query rows newly discovered by this sync: ${error.message}`);
    } else {
      console.log(`   ${newRows?.length ?? 0} brand-new (non-curated) rows were discovered by this real sync.`);
      const stillUnknown = (newRows ?? []).filter((r) => r.status === 'unknown');
      assert(stillUnknown.length === 0, `Zero brand-new live-provider rows are left in 'unknown' status (got ${stillUnknown.length} of ${newRows?.length ?? 0})`);
      const missingLinkCheck = (newRows ?? []).filter((r) => r.link_checked_at === null);
      assert(missingLinkCheck.length === 0, `Every brand-new live-provider row was link-checked immediately (${missingLinkCheck.length} missing link_checked_at)`);
      if ((newRows?.length ?? 0) === 0) {
        console.log('   (No brand-new rows this cycle — all providers returned already-known jobs. This is a valid outcome, not a failure; the deterministic new-job->active/expired guarantee is proven unconditionally by live-supply-suite.ts regardless.)');
      }
    }
  }

  // --------------------------------------------------------------------
  // 7. /feed consumes the DB-backed active catalog
  // --------------------------------------------------------------------
  console.log('\n7. /api/opportunities/feed CONSUMES THE DB-BACKED ACTIVE CATALOG');
  const session = await newVerifiedSession();
  let feedOpportunityId: string | null = null;
  {
    // /api/opportunities/feed is deliberately unauthenticated by design (see
    // its own doc comment in feed/route.ts): it's a preview list, not a
    // mutation, and RLS's `status = 'active'` filter already restricts it
    // to exactly the same data the public /remote-jobs surface exposes
    // regardless of caller identity — a cookie-less request naturally reads
    // as the `anon` role, which the policy already accounts for. So a 200
    // with no session is the correct, intended contract, not a gap; what
    // actually protects the product surface is the /feed PAGE's middleware
    // redirect (exercised in section 12) plus every *mutating* route
    // (swipe, match-analysis) requiring a verified session, which do
    // reject unauthenticated callers (proven in section 7's next check and
    // in security-remediation-suite.ts).
    const unauthed = await fetch(`${BASE_URL}/api/opportunities/feed`);
    assert(unauthed.status === 200, `GET /api/opportunities/feed with no session returns the public active catalog by design (got ${unauthed.status})`);

    const res = await fetch(`${BASE_URL}/api/opportunities/feed`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    const body = await res.json().catch(() => null);
    const opportunities: Array<{ id: string; status?: string }> = Array.isArray(body) ? body : body?.opportunities ?? [];
    assert(res.status === 200, `GET /api/opportunities/feed with a verified session succeeds (got ${res.status})`);
    assert(opportunities.length > 0, `Feed returns a non-empty set of opportunities (got ${opportunities.length})`);
    feedOpportunityId = opportunities[0]?.id ?? null;
    assert(Boolean(feedOpportunityId && feedOpportunityId.startsWith('opp-')), `Feed opportunity ids use the DB-backed canonical id format (got ${feedOpportunityId})`);
  }

  // --------------------------------------------------------------------
  // 8-9. Real right swipe -> P0 decision snapshot + P1 attributes
  // --------------------------------------------------------------------
  console.log('\n8-9. REAL RIGHT SWIPE -> P0 DECISION SNAPSHOT + P1 ATTRIBUTES SURVIVE');
  if (!feedOpportunityId) {
    assert(false, 'Cannot exercise swipe — no opportunity id was available from the feed');
  } else {
    const swipeRes = await fetch(`${BASE_URL}/api/opportunities/swipe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunityId: feedOpportunityId, action: 'interested' }),
    });
    const swipeBody = await swipeRes.json().catch(() => null);
    assert(swipeRes.status === 200 && swipeBody?.success === true, `Real right swipe on a DB-backed job succeeds (got ${swipeRes.status})`);

    const snap = swipeBody?.decisionSnapshot;
    assert(Boolean(snap), 'A decision snapshot was returned');
    assert(typeof snap?.fitScore === 'number', `P0 fitScore present (got ${snap?.fitScore})`);
    assert(typeof snap?.isEligible === 'boolean', 'P0 isEligible present');
    assert(typeof snap?.officialUrl === 'string' && snap.officialUrl.length > 0, 'P0 officialUrl present');
    assert(typeof snap?.salaryDisclosed === 'boolean', `P1 salaryDisclosed present (got ${snap?.salaryDisclosed})`);
    assert(typeof snap?.postingAgeDaysAtDecision === 'number', `P1 postingAgeDaysAtDecision present (got ${snap?.postingAgeDaysAtDecision})`);
    assert(
      ['explicit_worldwide', 'explicit_restricted', 'unknown'].includes(snap?.remoteScopeExplicit),
      `P1 remoteScopeExplicit is a valid value (got ${snap?.remoteScopeExplicit})`
    );
    assert(typeof swipeBody?.remaining === 'number' && swipeBody.remaining === 14, `Quota decremented correctly after the swipe (remaining=${swipeBody?.remaining}, expected 14)`);

    // Confirm what's actually persisted matches what the route returned —
    // not just what the HTTP response claims.
    const { data: swipeRow, error: swipeRowErr } = await admin
      .from('swipes')
      .select('decision_snapshot')
      .eq('profile_id', session.userId)
      .eq('opportunity_id', feedOpportunityId)
      .eq('action', 'interested')
      .maybeSingle();
    assert(!swipeRowErr && Boolean(swipeRow), 'The swipe row is durably persisted in Supabase');
    assert(
      swipeRow?.decision_snapshot?.salaryDisclosed === snap?.salaryDisclosed &&
        swipeRow?.decision_snapshot?.remoteScopeExplicit === snap?.remoteScopeExplicit,
      'Persisted decision_snapshot matches the P1 values returned over HTTP (not just an in-memory echo)'
    );
  }

  // --------------------------------------------------------------------
  // 10. Public /remote-jobs, category hub, job detail, sitemap
  // --------------------------------------------------------------------
  console.log('\n10. PUBLIC SURFACES (remote-jobs, category, detail, sitemap)');
  let sampleSourceId: string | null = null;
  {
    const { data } = await anon.from('opportunities').select('source_id, canonical_url_hash').eq('status', 'active').limit(1).maybeSingle();
    sampleSourceId = data?.source_id ?? null;
  }
  {
    const dirRes = await fetch(`${BASE_URL}/remote-jobs`);
    assert(dirRes.status === 200, `GET /remote-jobs returns 200 (got ${dirRes.status})`);

    const catRes = await fetch(`${BASE_URL}/remote-jobs/software-engineering`);
    assert(catRes.status === 200, `GET /remote-jobs/software-engineering returns 200 (got ${catRes.status})`);

    if (sampleSourceId) {
      const detailRes = await fetch(`${BASE_URL}/remote-jobs/view/${sampleSourceId}`);
      assert(detailRes.status === 200, `GET /remote-jobs/view/${sampleSourceId} (a real active job) returns 200 (got ${detailRes.status})`);
    } else {
      skip('No active job source_id available to test the detail page');
    }

    const sitemapRes = await fetch(`${BASE_URL}/sitemap.xml`);
    const sitemapBody = await sitemapRes.text();
    assert(sitemapRes.status === 200, `GET /sitemap.xml returns 200 (got ${sitemapRes.status})`);
    assert(sitemapBody.includes('<urlset'), 'Sitemap response is a valid urlset');
    if (sampleSourceId) {
      assert(sitemapBody.includes(`/remote-jobs/view/${sampleSourceId}`), 'Sitemap includes the same real active job');
    }
  }

  // --------------------------------------------------------------------
  // 11. Expired / permanently-removed SEO behavior intact
  // --------------------------------------------------------------------
  console.log('\n11. EXPIRED/PERMANENTLY-REMOVED SEO BEHAVIOR');
  {
    // The closed-but-not-removed case is a normal 200 page render whose
    // noindex directive comes from Next's Metadata API `robots` field —
    // that renders as an HTML <meta name="robots"> tag, not an HTTP header
    // (unlike the 410 case below, which middleware.ts constructs as a raw
    // Response with a real X-Robots-Tag header — that's the one case an
    // HTTP header actually applies to).
    const closedRes = await fetch(`${BASE_URL}/remote-jobs/view/curated-closed-001`);
    const closedHtml = await closedRes.text();
    assert(closedRes.status === 200, `GET /remote-jobs/view/curated-closed-001 (closed) returns 200 (got ${closedRes.status})`);
    assert(/<meta[^>]*name="robots"[^>]*content="[^"]*noindex/i.test(closedHtml), 'Closed job page HTML carries a noindex robots meta tag');

    const removedRes = await fetch(`${BASE_URL}/remote-jobs/view/curated-removed-001`);
    assert(removedRes.status === 410, `GET /remote-jobs/view/curated-removed-001 (permanently removed) returns 410 (got ${removedRes.status})`);
  }

  // --------------------------------------------------------------------
  // 12. Auth/quota behavior unchanged (spot check)
  // --------------------------------------------------------------------
  console.log('\n12. AUTH/QUOTA BEHAVIOR UNCHANGED (spot check; full coverage in auth-invariant-suite.ts)');
  {
    const noSessionSwipe = await fetch(`${BASE_URL}/api/opportunities/swipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunityId: feedOpportunityId ?? 'opp-curated-curated-001', action: 'interested' }),
    });
    assert(noSessionSwipe.status === 401, `POST /api/opportunities/swipe with no session -> 401 (got ${noSessionSwipe.status})`);

    const feedPageRes = await fetch(`${BASE_URL}/feed`, { redirect: 'manual' });
    assert([307, 308].includes(feedPageRes.status), `GET /feed with no session redirects to login (got ${feedPageRes.status})`);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Fatal error running production smoke test:', err);
  process.exit(1);
});
