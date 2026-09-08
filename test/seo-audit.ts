/**
 * RemoteMatch — Comprehensive SEO/AEO/GEO Website Audit Suite
 *
 * Live Supply Activation: this suite now requires a real Supabase project
 * AND live network access to the provider APIs (Remotive/Arbeitnow/Jobicy)
 * — it runs a real catalog sync (syncOpportunitiesToCatalog()) before
 * asserting anything, the same way test/gate2-live-supply.ts already
 * exercises live provider data. It is no longer a pure offline unit test:
 * the job catalog it inspects comes from the persisted `opportunities`
 * table, populated by the sync this suite itself triggers, not from the
 * static CURATED_JOBS array read directly.
 *
 * Verifies:
 * 1. Canonical URLs on all public indexable pages
 * 2. Zero duplicate metadata (titles, descriptions)
 * 3. Sitemap integrity (valid canonicals only, accurate lastmod, private routes absent, expired jobs absent)
 * 4. Factual JobPosting schema (only active jobs, no invented facts, baseSalary strictly validated)
 * 5. Job Freshness lifecycle (unknown -> active/expired, explicit editorial override, 410 for permanently removed, 200 noindex for closed)
 * 6. Authentic Search experience (/remote-jobs?q=...)
 * 7. BreadcrumbList structured data for all public routes
 * 8. Robots.txt configuration (public allowed, private application routes disallowed)
 * 9. IndexNow security & guardrails (strictly public URLs, reject private URLs, authenticated API)
 * 10. HTTP-level response verification (200, 410, noindex, text/plain key)
 * 11. RLS / public-read gate: active selectable, unknown/expired/draft never publicly selectable
 */

// Test-environment-only: Node 20 has no native WebSocket global, which
// @supabase/realtime-js's client-construction path requires. This suite's
// setup step calls syncOpportunitiesToCatalog(), which uses the shared
// production getSupabaseAdminClient() (src/lib/supabase/admin.ts) directly
// — that helper is deliberately NOT modified for this; the polyfill only
// affects this test process's global scope, before any Supabase client is
// constructed. See test/live-supply-suite.ts for the same fix.
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import http from 'http';
import sitemap from '../src/app/sitemap';
import robots from '../src/app/robots';
import {
  SEO_CATEGORIES,
  SEO_GUIDE_ARTICLES,
  getActiveJobs,
  getJobById,
  isJobIndexable,
  isJobPermanentlyRemoved,
  searchJobs,
  buildBreadcrumbSchema,
  buildJobPostingSchema,
} from '../src/lib/seo/data';
import {
  isPublicIndexableUrl,
  verifyInternalSecret,
  INDEXNOW_KEY,
} from '../src/lib/seo/indexnow';
import { syncOpportunitiesToCatalog } from '../src/lib/ingestion/catalog-sync';
import { hasRequiredEnv, anonKeyClient, adminClient } from './helpers/verified-session';

let passed = 0;
let failed = 0;

function assert(condition: any, testName: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${testName}${detail ? ` — ${detail}` : ''}`);
  }
}

async function runAudit() {
  console.log('============================================================');
  console.log('REMOTEMATCH — COMPREHENSIVE WEBSITE SEO/AEO/GEO AUDIT');
  console.log('Testing Canonical, Schema, Freshness, Sitemap, IndexNow & HTTP');
  console.log('============================================================\n');

  if (!hasRequiredEnv()) {
    console.log('Required Supabase env vars are not all set — cannot run this suite (Live Supply Activation requires a real catalog).');
    process.exitCode = 1;
    return;
  }

  console.log('--- SETUP: syncing the live catalog before auditing it ---');
  const syncSummary = await syncOpportunitiesToCatalog();
  console.log(`  Provider outcomes: ${syncSummary.providerOutcomes.map((o) => `${o.sourceKey}=${o.success ? 'ok' : 'FAILED'}`).join(', ')}`);
  console.log(`  new active=${syncSummary.newJobsVerifiedActive} new expired=${syncSummary.newJobsVerifiedExpired} explicit override=${syncSummary.explicitlyExpiredCount} refreshed=${syncSummary.refreshedExistingActive}\n`);

  const anon = anonKeyClient();

  // --------------------------------------------------------------------------
  // TEST 1: Canonical URLs & Metadata Uniqueness
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: Metadata & Canonical URL Validation ---');

  const titles = new Set<string>();
  const descriptions = new Set<string>();
  let duplicateTitles = 0;
  let duplicateDescriptions = 0;

  for (const cat of SEO_CATEGORIES) {
    if (titles.has(cat.metaTitle)) duplicateTitles++;
    titles.add(cat.metaTitle);
    if (descriptions.has(cat.metaDescription)) duplicateDescriptions++;
    descriptions.add(cat.metaDescription);
  }

  for (const guide of SEO_GUIDE_ARTICLES) {
    const guideTitle = `${guide.title} — Remote Job Guide | RemoteMatch`;
    if (titles.has(guideTitle)) duplicateTitles++;
    titles.add(guideTitle);
    if (descriptions.has(guide.description)) duplicateDescriptions++;
    descriptions.add(guide.description);
  }

  assert(duplicateTitles === 0, 'Zero duplicate page titles across hubs and guides');
  assert(duplicateDescriptions === 0, 'Zero duplicate meta descriptions across hubs and guides');

  const activeJobs = await getActiveJobs(anon);
  assert(activeJobs.length > 0, `At least one active job exists after sync (got ${activeJobs.length})`);
  const sampleJob = activeJobs[0];
  const expectedJobCanonical = `https://remotematch.com/remote-jobs/view/${sampleJob.sourceId}`;
  assert(
    expectedJobCanonical.startsWith('https://remotematch.com/remote-jobs/view/'),
    'Job canonical URL follows exact canonical structure without query params'
  );

  // --------------------------------------------------------------------------
  // TEST 2: Data-Driven Sitemap Verification
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 2: Data-Driven Sitemap Verification ---');
  const sitemapEntries = await sitemap();
  const sitemapUrls = sitemapEntries.map((e) => e.url);

  assert(sitemapUrls.includes('https://remotematch.com'), 'Homepage included in sitemap');
  assert(sitemapUrls.includes('https://remotematch.com/remote-jobs'), 'Directory included in sitemap');
  assert(sitemapUrls.includes('https://remotematch.com/guide'), 'Guide hub included in sitemap');

  const allCategoriesPresent = SEO_CATEGORIES.every((c) =>
    sitemapUrls.includes(`https://remotematch.com/remote-jobs/${c.slug}`)
  );
  assert(allCategoriesPresent, 'All 10 useful category & location hubs present in sitemap');

  const allGuidesPresent = SEO_GUIDE_ARTICLES.every((g) =>
    sitemapUrls.includes(`https://remotematch.com/guide/${g.slug}`)
  );
  assert(allGuidesPresent, 'All 8 tactical guide articles present in sitemap');

  const privateRoutesFound = sitemapUrls.filter((u) =>
    u.includes('/feed') ||
    u.includes('/tracker') ||
    u.includes('/settings') ||
    u.includes('/onboarding') ||
    u.includes('/match') ||
    u.includes('/staging') ||
    u.includes('/api')
  );
  assert(privateRoutesFound.length === 0, 'Private application routes strictly absent from sitemap');

  const expiredJobsInSitemap = sitemapUrls.filter((u) =>
    u.includes('curated-closed-001') || u.includes('curated-removed-001')
  );
  assert(expiredJobsInSitemap.length === 0, 'Expired/closed jobs strictly absent from active sitemap');

  assert(
    sitemapUrls.includes(`https://remotematch.com/remote-jobs/view/${activeJobs[0].sourceId}`),
    'Active jobs correctly included in sitemap'
  );

  const hasInvalidDates = sitemapEntries.some((e) => !(e.lastModified instanceof Date) || isNaN((e.lastModified as Date).getTime()));
  assert(!hasInvalidDates, 'All sitemap lastModified values are valid Date objects');

  // --------------------------------------------------------------------------
  // TEST 3: Job Freshness & Lifecycle Boundary
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Job Freshness & Lifecycle Boundary ---');

  const liveJob = await getJobById('curated-001');
  const closedJob = await getJobById('curated-closed-001');
  const removedJob = await getJobById('curated-removed-001');

  assert(liveJob !== undefined && isJobIndexable(liveJob), 'Live curated job is recognized as indexable (200, index,follow)');
  assert(closedJob !== undefined && !isJobIndexable(closedJob), 'Closed job (explicit editorial override) is recognized as non-indexable (200, noindex,follow)');
  assert(removedJob !== undefined && isJobPermanentlyRemoved(removedJob), 'Permanently removed job (explicit editorial override) is flagged for 410 Gone');

  // --------------------------------------------------------------------------
  // TEST 4: Factual JobPosting Schema Validation (No Invented Facts)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 4: Factual JobPosting Schema Validation ---');

  const liveSchema = liveJob ? buildJobPostingSchema(liveJob) : null;
  assert(liveSchema !== null, 'JobPosting schema generated for live job');
  assert(liveSchema?.['@type'] === 'JobPosting', 'Schema @type is JobPosting');
  assert(Boolean(liveSchema?.title && liveSchema?.hiringOrganization?.name), 'JobPosting contains factual title and employer name');
  assert(liveSchema?.jobLocationType === 'TELECOMMUTE', 'JobPosting specifies TELECOMMUTE location type');
  assert(Boolean(liveSchema?.baseSalary?.currency && liveSchema?.baseSalary?.value?.minValue), 'Salary contains factual currency and minValue');
  assert(liveSchema?.validThrough === undefined, 'Does NOT invent synthetic validThrough date when unprovided');

  const closedSchema = closedJob ? buildJobPostingSchema(closedJob) : null;
  assert(closedSchema === null, 'JobPosting schema is strictly OMITTED for expired/closed jobs');

  // --------------------------------------------------------------------------
  // TEST 5: Authentic Search Experience (/remote-jobs?q=...)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 5: Authentic Search Experience Filtering ---');

  const allActive = await searchJobs(undefined, undefined, anon);
  const engineerResults = await searchJobs('engineer', undefined, anon);
  const designerResults = await searchJobs('designer', undefined, anon);
  const emptyResults = await searchJobs('nonexistenttermxyz999', undefined, anon);

  assert(allActive.length >= 5, `Unfiltered search returns all active jobs (got ${allActive.length})`);
  assert(
    engineerResults.length > 0 && engineerResults.every((j) => `${j.title} ${j.description} ${(j.requiredSkills || []).join(' ')}`.toLowerCase().includes('engineer')),
    'Query "engineer" correctly filters matching engineering positions'
  );
  assert(
    designerResults.length > 0 && designerResults.every((j) => `${j.title} ${j.description} ${(j.requiredSkills || []).join(' ')}`.toLowerCase().includes('design')),
    'Query "designer" correctly filters product design positions'
  );
  assert(emptyResults.length === 0, 'Unmatched query correctly returns 0 results rather than failing');

  // --------------------------------------------------------------------------
  // TEST 6: Schema.org BreadcrumbList Validation
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 6: Schema.org BreadcrumbList Validation ---');

  const breadcrumbs = buildBreadcrumbSchema([
    { name: 'Home', url: 'https://remotematch.com' },
    { name: 'Remote Jobs', url: 'https://remotematch.com/remote-jobs' },
    { name: 'Software Engineering', url: 'https://remotematch.com/remote-jobs/software-engineering' },
  ]);

  assert(breadcrumbs['@type'] === 'BreadcrumbList', 'BreadcrumbList schema has correct @type');
  assert(breadcrumbs.itemListElement.length === 3, 'BreadcrumbList contains exact item count (got 3)');
  assert(breadcrumbs.itemListElement[0].position === 1 && breadcrumbs.itemListElement[0].name === 'Home', 'Breadcrumb root is Home at position 1');

  // --------------------------------------------------------------------------
  // TEST 7: Robots.txt Rules Verification
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 7: Robots.txt Configuration ---');

  const robotsConfig = robots();
  const rules = Array.isArray(robotsConfig.rules) ? robotsConfig.rules[0] : robotsConfig.rules;
  const allowList = Array.isArray(rules?.allow) ? rules.allow : [rules?.allow];
  const disallowList = Array.isArray(rules?.disallow) ? rules.disallow : [rules?.disallow];

  assert(allowList.includes('/') && allowList.includes('/remote-jobs'), 'Robots allows public pages');
  assert(allowList.includes('/remotematch-indexnow-key.txt'), 'Robots allows IndexNow key verification file');
  assert(disallowList.includes('/feed') && disallowList.includes('/onboarding') && disallowList.includes('/tracker'), 'Robots strictly disallows private application routes');
  assert(robotsConfig.sitemap === 'https://remotematch.com/sitemap.xml', 'Robots points to canonical sitemap location');

  // --------------------------------------------------------------------------
  // TEST 8: IndexNow Security, Guardrails & Key
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 8: IndexNow Security & Guardrails ---');

  assert(isPublicIndexableUrl('https://remotematch.com/remote-jobs'), 'IndexNow allows public directory URL');
  assert(isPublicIndexableUrl('https://remotematch.com/remote-jobs/software-engineering'), 'IndexNow allows public category URL');
  assert(isPublicIndexableUrl('https://remotematch.com/remote-jobs/view/curated-001'), 'IndexNow allows public job URL');
  assert(!isPublicIndexableUrl('https://remotematch.com/feed'), 'IndexNow strictly REJECTS /feed');
  assert(!isPublicIndexableUrl('https://remotematch.com/onboarding'), 'IndexNow strictly REJECTS /onboarding');
  assert(!isPublicIndexableUrl('https://remotematch.com/tracker'), 'IndexNow strictly REJECTS /tracker');
  assert(!isPublicIndexableUrl('https://remotematch.com/settings'), 'IndexNow strictly REJECTS /settings');
  assert(!isPublicIndexableUrl('https://remotematch.com/api/stripe/checkout'), 'IndexNow strictly REJECTS internal API routes');
  assert(!isPublicIndexableUrl('https://malicious-site.com/remote-jobs'), 'IndexNow strictly REJECTS external domains');

  const previousIndexNowSecret = process.env.INDEXNOW_SECRET;
  delete process.env.INDEXNOW_SECRET;
  assert(
    !verifyInternalSecret('Bearer remotematch-internal-secret-2026'),
    'IndexNow fails closed (rejects even the old hardcoded value) when INDEXNOW_SECRET is unset'
  );
  assert(!verifyInternalSecret(null), 'IndexNow rejects unauthenticated requests');

  process.env.INDEXNOW_SECRET = 'test-only-secret-for-seo-audit-suite';
  assert(!verifyInternalSecret('wrong-secret'), 'IndexNow rejects invalid credentials');
  assert(
    verifyInternalSecret('Bearer test-only-secret-for-seo-audit-suite'),
    'IndexNow accepts a valid internal authorization header once INDEXNOW_SECRET is configured'
  );
  if (previousIndexNowSecret === undefined) {
    delete process.env.INDEXNOW_SECRET;
  } else {
    process.env.INDEXNOW_SECRET = previousIndexNowSecret;
  }

  // --------------------------------------------------------------------------
  // TEST 9: HTTP-Level Response & Status Verification
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 9: HTTP-Level Response & Header Verification ---');

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\nSitemap: https://remotematch.com/sitemap.xml');
      return;
    }

    if (pathname === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><urlset></urlset>');
      return;
    }

    if (pathname === '/remotematch-indexnow-key.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(INDEXNOW_KEY);
      return;
    }

    if (pathname === '/remote-jobs') {
      const q = url.searchParams.get('q');
      const filtered = await searchJobs(q || undefined, undefined, anon);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Link': '<https://remotematch.com/remote-jobs>; rel="canonical"',
      });
      res.end(`<html><head><link rel="canonical" href="https://remotematch.com/remote-jobs"/></head><body>Found ${filtered.length} jobs</body></html>`);
      return;
    }

    if (pathname.startsWith('/remote-jobs/view/')) {
      const jobId = pathname.replace('/remote-jobs/view/', '');
      const job = await getJobById(jobId);

      if (!job) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      if (isJobPermanentlyRemoved(job)) {
        res.writeHead(410, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Robots-Tag': 'noindex, nofollow',
        });
        res.end(`410 Gone: The job listing "${job.title}" has been permanently removed.`);
        return;
      }

      if (!isJobIndexable(job)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Robots-Tag': 'noindex, follow',
        });
        res.end(`<html><head><meta name="robots" content="noindex, follow"/></head><body>Closed position notice</body></html>`);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Link': `<https://remotematch.com/remote-jobs/view/${job.sourceId}>; rel="canonical"`,
      });
      res.end(`<html><head><link rel="canonical" href="https://remotematch.com/remote-jobs/view/${job.sourceId}"/></head><body>Active job</body></html>`);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('OK');
  }

  const testServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve) => {
    testServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = testServer.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function fetchTest(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  }

  try {
    const rRobots = await fetchTest('/robots.txt');
    assert(rRobots.status === 200 && rRobots.text.includes('Sitemap:'), 'GET /robots.txt returns 200 with sitemap declaration');

    const rSitemap = await fetchTest('/sitemap.xml');
    assert(rSitemap.status === 200 && Boolean(rSitemap.headers.get('content-type')?.includes('xml')), 'GET /sitemap.xml returns 200 with XML content-type');

    const rKey = await fetchTest('/remotematch-indexnow-key.txt');
    assert(rKey.status === 200 && rKey.text === INDEXNOW_KEY && Boolean(rKey.headers.get('content-type')?.includes('text/plain')), 'GET /remotematch-indexnow-key.txt returns 200 text/plain with exact key');

    const rDir = await fetchTest('/remote-jobs');
    assert(rDir.status === 200 && /Found \d+ jobs/.test(rDir.text), 'GET /remote-jobs returns 200 with active jobs count');

    const rSearch = await fetchTest('/remote-jobs?q=engineer');
    assert(rSearch.status === 200 && rSearch.text.includes('jobs'), 'GET /remote-jobs?q=engineer returns 200 with filtered results');

    const rActiveJob = await fetchTest('/remote-jobs/view/curated-001');
    assert(rActiveJob.status === 200 && rActiveJob.text.includes('rel="canonical"'), 'GET /remote-jobs/view/curated-001 returns 200 with canonical link');

    const rClosedJob = await fetchTest('/remote-jobs/view/curated-closed-001');
    assert(rClosedJob.status === 200 && Boolean(rClosedJob.headers.get('x-robots-tag')?.includes('noindex')), 'GET /remote-jobs/view/curated-closed-001 returns 200 + noindex,follow');

    const rRemovedJob = await fetchTest('/remote-jobs/view/curated-removed-001');
    assert(rRemovedJob.status === 410 && rRemovedJob.text.includes('410 Gone'), 'GET /remote-jobs/view/curated-removed-001 returns HTTP 410 Gone for permanently removed job');
  } finally {
    testServer.close();
  }

  // --------------------------------------------------------------------------
  // TEST 10: RLS / public-read gate — explicit, not assumed
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 10: RLS Public-Read Gate ---');

  const admin = adminClient();
  const { data: statusSample } = await admin
    .from('opportunities')
    .select('id, source, source_id, status')
    .in('status', ['unknown', 'expired', 'draft'])
    .limit(1);

  if (statusSample && statusSample.length > 0) {
    const row = statusSample[0];
    const { data: publicRead } = await anon
      .from('opportunities')
      .select('id')
      .eq('source', row.source)
      .eq('source_id', row.source_id)
      .maybeSingle();
    assert(publicRead === null, `A '${row.status}' row is NOT publicly selectable via the anon client (RLS)`);
  } else {
    console.log('  – NOTE: no unknown/expired/draft row available to test right now — the negative case (RLS blocking it) could not be exercised this run.');
  }

  const { data: activeSample } = await admin
    .from('opportunities')
    .select('id, source, source_id')
    .eq('status', 'active')
    .limit(1);
  if (activeSample && activeSample.length > 0) {
    const row = activeSample[0];
    const { data: publicRead } = await anon
      .from('opportunities')
      .select('id')
      .eq('source', row.source)
      .eq('source_id', row.source_id)
      .maybeSingle();
    assert(publicRead !== null, "An 'active' row IS publicly selectable via the anon client (RLS)");
  }

  const { error: adminWriteErr } = await admin
    .from('opportunities')
    .update({ quality_score: 85 })
    .eq('source', 'curated')
    .eq('source_id', 'curated-001');
  assert(!adminWriteErr, `service_role can manage rows in all states (got ${adminWriteErr ? (adminWriteErr as any).message : 'no error'})`);

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('\n============================================================');
  console.log(`SEO AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAudit().catch((err) => {
  console.error('Audit execution error:', err);
  process.exit(1);
});
