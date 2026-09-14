/**
 * Supply Discovery gate C5 — career-page provider (docs/c5-implementation-plan.md §7, §12).
 * Mirrors ats-provider-suite.ts's structure: unit coverage with no infra,
 * then a real-infra section (self-skips if env unavailable) that seeds
 * synthetic allowlist_employers rows, mocks global.fetch for the page
 * fetch itself (never the DB), and cleans up unconditionally.
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { detectExtractionMethod, parseJsonLd, detectPageKind, discoverJobPostingLinks, CareerPageProvider } from '../src/lib/providers/career-page';
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

const JSON_LD_PAGE = `
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Staff Platform Engineer",
  "description": "Build and operate our core platform services.",
  "datePosted": "2026-09-13",
  "employmentType": "FULL_TIME",
  "jobLocationType": "TELECOMMUTE",
  "applicantLocationRequirements": { "@type": "Country", "name": "Worldwide" }
}
</script>
</head><body><h1>Staff Platform Engineer</h1></body></html>
`;

const JSON_LD_GRAPH_PAGE = `
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@graph": [
    { "@type": "Organization", "name": "Acme Corp" },
    {
      "@type": "JobPosting",
      "title": "Product Designer",
      "description": "Design delightful product experiences.",
      "datePosted": "2026-09-11",
      "employmentType": "FULL_TIME",
      "jobLocation": { "@type": "Place", "address": { "addressLocality": "Berlin", "addressCountry": "DE" } }
    }
  ]
}
</script>
</head><body></body></html>
`;

const NON_JOBPOSTING_LD_PAGE = `
<html><head>
<script type="application/ld+json">
{ "@context": "https://schema.org/", "@type": "Organization", "name": "Acme Corp" }
</script>
</head><body><h1>Careers at Acme</h1><p>Senior Data Engineer — Remote. Full-time. Posted 2026-09-10.</p></body></html>
`;

const MALFORMED_LD_PAGE = `
<html><head>
<script type="application/ld+json">
{ this is not valid json at all
</script>
</head><body><h1>Careers</h1></body></html>
`;

// Finding A (c5-acquisition-validation-amendment.md §1) fixtures — the
// exact real shapes observed live against Coinbase's/Okta's own
// JobPosting markup 2026-09-14.
const JSON_LD_STRING_ADDRESS_PAGE = `
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Operational Excellence Senior Program Lead",
  "description": "Real-world address-as-string shape.",
  "datePosted": "2026-09-11T18:15:13-04:00",
  "employmentType": "FULL_TIME",
  "jobLocation": { "@type": "Place", "address": "Remote - USA" }
}
</script>
</head><body></body></html>
`;

const JSON_LD_NO_LOCATION_PAGE = `
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "No Location Signal At All",
  "description": "Neither jobLocation, jobLocationType, nor applicantLocationRequirements present.",
  "datePosted": "2026-09-11",
  "employmentType": "FULL_TIME"
}
</script>
</head><body></body></html>
`;

// Finding C (c5-acquisition-validation-amendment.md §3) fixtures — real
// shape observed live against Canonical's actual /careers page 2026-09-14:
// Organization-typed JSON-LD (not JobPosting) + category links, not
// individual postings.
const REAL_SHAPE_INDEX_PAGE = `
<html><head>
<script type="application/ld+json">
{ "@context": "https://schema.org/", "@type": "Organization", "name": "Acme Corp" }
</script>
</head><body>
<nav><a href="/about">About</a><a href="/careers">Careers</a><a href="/careers">Careers (duplicate)</a></nav>
<main>
  <a href="/careers/engineering">Engineering</a>
  <a href="/careers/sales">Sales</a>
  <a href="/careers/engineering#top">Engineering (fragment duplicate)</a>
  <a href="https://not-acme-at-all.example/careers/fake-role">Off-domain job-shaped link</a>
</main>
<footer><a href="/privacy">Privacy</a><a href="/careers/engineering">Engineering (footer duplicate)</a></footer>
</body></html>
`;

// Discovery-heuristic refinement fixtures (2026-09-14) — real shapes
// observed live during acquisition re-validation: Coinbase's locale-variant
// landing pages (/en-in/careers, /es-us/careers, ...), DuckDuckGo's
// image-asset "links" (careers-bg-sm.jpg/.svg), Coalition Technologies'
// WordPress oEmbed API endpoint (/wp-json/oembed/...).
const LOCALE_AND_NOISE_INDEX_PAGE = `
<html><head>
<script type="application/ld+json">
{ "@context": "https://schema.org/", "@type": "Organization", "name": "Acme Corp" }
</script>
</head><body>
<main>
  <a href="/en-in/careers">Careers (India)</a>
  <a href="/es-us/careers">Careers (US Spanish)</a>
  <a href="/en-de/careers">Careers (Germany)</a>
  <a href="/en-gb/careers">Careers (UK)</a>
  <a href="/careers/positions/8198059?gh_jid=8198059">Real distinct posting</a>
  <a href="/static-assets/backgrounds/careers-bg-sm.jpg">Careers background image</a>
  <a href="/static-assets/backgrounds/careers-fg-lg.svg">Careers foreground svg</a>
  <a href="/wp-json/oembed/1.0/embed?url=https%3A%2F%2Facme.com%2Fcareers">oEmbed API endpoint</a>
  <a href="/en-us/careers/software-engineer-123">A genuinely distinct locale-prefixed posting (US)</a>
  <a href="/en-gb/careers/software-engineer-456">A genuinely distinct locale-prefixed posting (UK)</a>
</main>
</body></html>
`;

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C5 — CAREER-PAGE PROVIDER');
  console.log('==============================================================================\n');

  // ==========================================================================
  console.log('1. UNIT — detectExtractionMethod (no infra)');
  // ==========================================================================
  assert(
    detectExtractionMethod('https://acme.com/careers/staff-platform-engineer', JSON_LD_PAGE) === 'json_ld',
    'a page with a JobPosting JSON-LD block is detected as json_ld'
  );
  assert(
    detectExtractionMethod('https://acme.com/careers/product-designer', JSON_LD_GRAPH_PAGE) === 'json_ld',
    'a JobPosting nested inside an @graph array is still detected as json_ld'
  );
  assert(
    detectExtractionMethod('https://acme.com/careers/data-eng', NON_JOBPOSTING_LD_PAGE) === 'gemini',
    'JSON-LD present but NOT a JobPosting (e.g. Organization only) falls through to gemini, not a false json_ld positive'
  );
  assert(
    detectExtractionMethod('https://acme.com/careers/no-structured-data', '<html><body><h1>Careers</h1><p>Senior Engineer role.</p></body></html>') === 'gemini',
    'a page with no JSON-LD at all is detected as gemini'
  );
  assert(
    detectExtractionMethod('https://boards.greenhouse.io/acme/jobs/12345', '<html></html>') === 'ats_redirect',
    'a URL resolving to a known ATS host is detected as ats_redirect regardless of page content'
  );
  assert(
    detectExtractionMethod('https://jobs.lever.co/acme/abc123', '<html></html>') === 'ats_redirect',
    'lever.co host is also detected as ats_redirect'
  );
  assert(
    detectExtractionMethod('not a valid url', '<html></html>') === 'gemini',
    'a malformed URL does not throw — falls through to content-based detection'
  );

  // ==========================================================================
  console.log('\n2. UNIT — parseJsonLd (deterministic, no evidence check needed)');
  // ==========================================================================
  {
    const candidate = parseJsonLd(JSON_LD_PAGE, 'https://acme.com/careers/staff-platform-engineer', 'Acme Corp', 'emp-1');
    assert(candidate !== null, 'a valid JobPosting JSON-LD block parses to a non-null candidate');
    assert(candidate?.title === 'Staff Platform Engineer', 'title extracted correctly from JSON-LD');
    assert(candidate?.company === 'Acme Corp', 'company comes from the trusted registry parameter, never the JSON-LD itself');
    assert(candidate?.publicationDate === '2026-09-13', 'datePosted extracted correctly');
    assert(candidate?.locationString === 'Remote', 'TELECOMMUTE jobLocationType maps to Remote');
    assert(candidate?.source === 'careerpage', "source tagged 'careerpage' (the CHECK-constraint-compliant slug, not the spec text's literal 'career_page')");
    assert(candidate?.sourceId.startsWith('careerpage-emp-1-') ?? false, 'sourceId namespaced by employer id, deterministic and collision-resistant');
  }
  {
    const candidate = parseJsonLd(JSON_LD_GRAPH_PAGE, 'https://acme.com/careers/product-designer', 'Acme Corp', 'emp-2');
    assert(candidate !== null, 'a JobPosting nested inside @graph is found and parsed');
    assert(candidate?.title === 'Product Designer', 'title extracted correctly from the @graph-nested JobPosting');
    assert(candidate?.locationString === 'Berlin, DE', 'structured jobLocation address fields are joined into locationString');
  }
  {
    const candidate = parseJsonLd(NON_JOBPOSTING_LD_PAGE, 'https://acme.com/careers/data-eng', 'Acme Corp', 'emp-3');
    assert(candidate === null, 'a page with JSON-LD but no JobPosting node returns null, not a fabricated candidate');
  }
  {
    const candidate = parseJsonLd(MALFORMED_LD_PAGE, 'https://acme.com/careers/x', 'Acme Corp', 'emp-4');
    assert(candidate === null, 'malformed JSON-LD is caught and skipped, never thrown — returns null');
  }

  // ==========================================================================
  console.log('\n2b. UNIT — Finding A: address string vs. object (real observed shapes)');
  // ==========================================================================
  {
    const candidate = parseJsonLd(JSON_LD_STRING_ADDRESS_PAGE, 'https://coinbase.com/careers/positions/8198059', 'Coinbase', 'emp-5');
    assert(candidate !== null, 'the real Coinbase-shaped JobPosting parses to a non-null candidate');
    assert(candidate?.locationString === 'Remote - USA', "address AS A PLAIN STRING (the real, confirmed Coinbase/Okta shape) is now correctly extracted — was '' before the Finding A fix");
  }
  {
    // Regression guard: the existing object-form case (JSON_LD_GRAPH_PAGE,
    // tested above) must still resolve 'Berlin, DE' — already asserted in
    // section 2; not re-duplicated here, just noted as still covered.
    const candidate = parseJsonLd(JSON_LD_GRAPH_PAGE, 'https://acme.com/careers/product-designer', 'Acme Corp', 'emp-2');
    assert(candidate?.locationString === 'Berlin, DE', 'PostalAddress OBJECT form (pre-existing case) still resolves correctly — Finding A fix did not regress it');
  }
  {
    const candidate = parseJsonLd(JSON_LD_NO_LOCATION_PAGE, 'https://acme.com/careers/no-location', 'Acme Corp', 'emp-6');
    assert(candidate !== null, 'a JobPosting with no location signal at all still parses (title/description are present)');
    assert(candidate?.locationString === '', 'genuinely absent location information resolves to an empty string, never guessed — this is the exact input Finding B\'s write-time gate must then reject');
  }

  // ==========================================================================
  console.log('\n3. UNIT — Finding C: detectPageKind / discoverJobPostingLinks (no infra)');
  // ==========================================================================
  assert(detectPageKind(JSON_LD_PAGE) === 'single_posting', 'a page with a JobPosting-typed JSON-LD is detected as single_posting');
  assert(detectPageKind(JSON_LD_GRAPH_PAGE) === 'single_posting', 'a JobPosting nested in @graph is still detected as single_posting');
  assert(detectPageKind(REAL_SHAPE_INDEX_PAGE) === 'index', "Canonical's real Organization-typed /careers shape is detected as index");
  assert(detectPageKind(NON_JOBPOSTING_LD_PAGE) === 'index', 'any non-JobPosting JSON-LD (or none) is treated as index, not single_posting');

  {
    const links = discoverJobPostingLinks(REAL_SHAPE_INDEX_PAGE, 'https://acme.com/careers');
    assert(links.includes('https://acme.com/careers/engineering'), 'a real job-shaped, same-domain link is discovered');
    assert(links.includes('https://acme.com/careers/sales'), 'a second real job-shaped, same-domain link is discovered');
    assert(!links.some((l) => l.includes('not-acme-at-all.example')), 'an off-domain job-shaped link is EXCLUDED — the hard same-origin safety boundary');
    assert(!links.some((l) => l.includes('/about') || l.includes('/privacy')), 'non-job-shaped links (nav/footer, no job|career|position|vacanc in the path) are excluded — deterministic rejection before any fetch');
    assert(links.length === new Set(links).size, 'the returned list has no duplicates');
    assert(
      links.filter((l) => l === 'https://acme.com/careers/engineering').length === 1,
      "acceptance condition: the SAME URL appearing 3 times on the page (nav/main/footer) collapses to exactly ONE entry — deduplicated before fetching"
    );
    assert(
      !links.some((l) => l.includes('#')),
      "the #fragment-only variant is genuinely absent (not just under-counted) — fragment is stripped before the dedup key is computed, since the server ignores it and it's the same resource"
    );
  }
  {
    const capped = discoverJobPostingLinks(REAL_SHAPE_INDEX_PAGE, 'https://acme.com/careers', 1);
    assert(capped.length <= 1, 'maxLinks caps the result set (sized to a small employer cohort, not built for unbounded scale)');
  }

  // ==========================================================================
  console.log('\n3b. UNIT — Discovery-heuristic refinement: locale-family collapse + static/API filtering');
  // ==========================================================================
  {
    const links = discoverJobPostingLinks(LOCALE_AND_NOISE_INDEX_PAGE, 'https://acme.com/careers', 20);

    const localeVariants = links.filter((l) => /\/(en-in|es-us|en-de|en-gb)\/careers$/.test(l));
    assert(
      localeVariants.length <= 1,
      `4 locale-variant copies of the SAME /careers landing page collapse to at most 1 representative, not 4 (got ${localeVariants.length}: ${localeVariants.join(', ')})`
    );
    assert(
      links.includes('https://acme.com/careers/positions/8198059?gh_jid=8198059'),
      'a genuinely distinct posting link is NOT crowded out by locale noise — it survives alongside the collapsed locale family'
    );
    assert(
      links.includes('https://acme.com/en-us/careers/software-engineer-123') && links.includes('https://acme.com/en-gb/careers/software-engineer-456'),
      'two GENUINELY DISTINCT locale-prefixed postings (different remaining path after stripping locale) are BOTH kept — this is not a blanket rejection of locale-prefixed URLs, only of equivalent-landing-page families'
    );
    assert(
      !links.some((l) => l.includes('.jpg') || l.includes('.svg')),
      'static image assets whose filename merely contains a job-shaped word (careers-bg-sm.jpg, careers-fg-lg.svg — the real DuckDuckGo shape) are excluded before any fetch'
    );
    assert(
      !links.some((l) => l.includes('/wp-json/')),
      'a WordPress oEmbed API endpoint (the real Coalition Technologies shape) is excluded before any fetch'
    );
  }

  // ==========================================================================
  console.log('\n4. REAL-INFRA — provider run against seeded synthetic employers (self-skips if env unavailable)');
  // ==========================================================================
  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — real-infra section skipped.');
  } else {
    const admin = adminClient();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const domainFor = (label: string) => `c5-test-${label}-${suffix}.example`;

    const indexPageDomain = domainFor('indexpage');
    // A real-shaped index page (Finding C) whose discovered sub-links point
    // at OTHER pages on the SAME domain — subPages routes those exact paths
    // to their own fixture content, distinct from the employer's root page.
    //
    // C5 second finding (docs/c5-finding2-audit.md): /careers/jobs is a
    // discovered sub-link that is ITSELF another index/listing page — the
    // real virtual7 /unternehmen/jobs/ shape. The guard added in fetchJobs()
    // must skip it before extraction. /careers/eng-role is the genuine single
    // posting and must still produce a candidate — the guard must not regress
    // legitimate discovery.
    const indexPageHtml = `
<html><head>
<script type="application/ld+json">
{ "@context": "https://schema.org/", "@type": "Organization", "name": "C5 Test indexpage" }
</script>
</head><body>
<main>
  <a href="/careers/eng-role">Engineering role</a>
  <a href="/careers/eng-role">Engineering role (duplicate)</a>
  <a href="/careers/jobs">Job listing index (sub-link that is itself an index)</a>
  <a href="/about">About (non-job-shaped, must never be fetched)</a>
</main>
</body></html>`;
    const discoveredPostingHtml = `
<html><head>
<script type="application/ld+json">
{ "@context": "https://schema.org/", "@type": "JobPosting", "title": "Discovered Engineering Role", "description": "Found via index-page link discovery.", "datePosted": "2026-09-14", "employmentType": "FULL_TIME", "jobLocation": { "@type": "Place", "address": "Remote - USA" } }
</script>
</head><body></body></html>`;
    // The real virtual7 /unternehmen/jobs/ shape: Organization-typed JSON-LD
    // (no JobPosting node) + multiple job listing links. detectPageKind() on
    // this content returns 'index', so the guard must skip it entirely.
    const discoveredIndexPageHtml = `
<html><head>
<script type="application/ld+json">
{ "@context": "https://schema.org/", "@type": "Organization", "name": "C5 Test indexpage Jobs" }
</script>
</head><body>
<main>
  <a href="/careers/jobs/role-1">Role 1</a>
  <a href="/careers/jobs/role-2">Role 2</a>
  <a href="/careers/jobs/role-3">Role 3</a>
</main>
</body></html>`;

    const employerDefs = [
      { label: 'jsonld', domain: domainFor('jsonld'), path: '/careers/staff-eng', html: JSON_LD_PAGE, status: 200 },
      { label: 'blocked', domain: domainFor('blocked'), path: '/careers/x', html: '', status: 403 },
      { label: 'notfound', domain: domainFor('notfound'), path: '/careers/x', html: '', status: 500 },
      { label: 'noextraction', domain: domainFor('noextraction'), path: '/careers/x', html: NON_JOBPOSTING_LD_PAGE, status: 200 },
      { label: 'atsredirect', domain: 'boards.greenhouse.io', path: '/acme-c5-test/jobs/1', html: '<html></html>', status: 200 },
      { label: 'networkfail', domain: domainFor('networkfail'), path: '/careers/x', html: '', status: 0 },
      {
        label: 'indexpage', domain: indexPageDomain, path: '/careers', html: indexPageHtml, status: 200,
        subPages: { '/careers/eng-role': discoveredPostingHtml, '/careers/jobs': discoveredIndexPageHtml, '/about': '<html><body>About us</body></html>' },
      },
    ];

    // Keyed by label, not positional index — robust against any single
    // insert failing without desyncing the mapping between a def and its
    // created row ids.
    const sourceIdByLabel = new Map<string, string>();
    const employerIdByLabel = new Map<string, string>();

    try {
      for (const def of employerDefs) {
        const url = `https://${def.domain}${def.path}`;
        const { data: source, error: sourceErr } = await admin
          .from('supply_sources')
          .insert({
            // Distinct `board` per row — uq_supply_sources_platform_board is
            // UNIQUE(platform_slug, board); every career-page employer would
            // otherwise collide on ('careerpage', '').
            platform_slug: 'careerpage', board: def.label, employer_name: `C5 Test ${def.label}`,
            endpoint_template: url, acquisition_method: 'http_html', extraction_method: 'native_adapter',
            auth_requirement: 'none', permission_basis: 'manual_review', review_status: 'approved',
            reviewed_at: new Date().toISOString(), reviewed_by: 'career-page-provider-suite-test',
            review_reason: 'transient test row', status: 'active',
          })
          .select('id')
          .single();
        if (sourceErr) console.error(`  [setup] supply_sources insert failed for '${def.label}':`, sourceErr.message);
        if (source?.id) sourceIdByLabel.set(def.label, source.id);

        const { data: employer, error: employerErr } = await admin
          .from('allowlist_employers')
          .insert({
            canonical_name: `C5 Test ${def.label}`, official_domain: def.domain, career_url: url,
            ats_provider: null, remote_evidence: 'test fixture', review_status: 'approved',
            reviewed_at: new Date().toISOString(), reviewed_by: 'career-page-provider-suite-test',
            linked_source_id: source?.id,
          })
          .select('id')
          .single();
        if (employerErr) console.error(`  [setup] allowlist_employers insert failed for '${def.label}':`, employerErr.message);
        if (employer?.id) employerIdByLabel.set(def.label, employer.id);
      }

      // Only intercept requests to the synthetic test domains above — every
      // OTHER call (critically, the Supabase REST client's own calls, which
      // also go through global.fetch under the hood) must pass through to
      // the real fetch untouched, or getApprovedCareerPageEmployers()'s own
      // query would be starved before the per-employer loop ever runs.
      // fetchedUrls tracks every intercepted URL — the Finding C real-infra
      // assertions below verify discovery behavior against this log, not
      // just the final candidate output shape.
      const fetchedUrls: string[] = [];
      const originalFetch = global.fetch;
      (global as any).fetch = async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input.url;
        const def = employerDefs.find((d) => url.includes(d.domain));
        if (!def) return originalFetch(input, init);
        fetchedUrls.push(url);
        if (def.status === 0) throw new Error('simulated network failure');
        // subPages routes an exact path (Finding C's discovered sub-links)
        // to its own fixture content — falls back to the employer's root
        // page/status for any other path on that same domain (incl. its
        // own /robots.txt request, which incidentally parses as "no
        // applicable rule -> allowed" since it isn't real robots syntax).
        const subPages = (def as any).subPages as Record<string, string> | undefined;
        if (subPages) {
          const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
          if (subPages[path] !== undefined) {
            return { ok: true, status: 200, text: async () => subPages[path] };
          }
        }
        return {
          ok: def.status >= 200 && def.status < 300,
          status: def.status,
          text: async () => def.html,
        };
      };

      let results;
      try {
        results = await new CareerPageProvider().fetchJobs();
      } finally {
        global.fetch = originalFetch;
      }

      assert(Array.isArray(results), 'fetchJobs() resolves (never throws) even with a mix of success/403/500/network-failure/misregistered employers');
      assert(
        results.some((j) => j.title === 'Staff Platform Engineer'),
        'the JSON-LD employer produced a valid candidate via the deterministic path'
      );
      assert(
        !results.some((j) => j.company === 'C5 Test blocked'),
        'the 403-blocked employer produced no candidate'
      );
      assert(
        !results.some((j) => j.company === 'C5 Test atsredirect'),
        'the misregistered (ATS-redirect-host) employer produced no candidate — never silently routed through the ATS path here'
      );
      assert(
        !results.some((j) => j.company === 'C5 Test networkfail'),
        'the network-failure employer produced no candidate, but did not abort the other employers\' processing (per-employer isolation)'
      );

      if (!process.env.GEMINI_API_KEY) {
        assert(
          !results.some((j) => j.company === 'C5 Test noextraction'),
          'with no GEMINI_API_KEY configured, the non-JSON-LD employer (which requires Gemini) correctly produces zero candidates rather than a fabricated one — this ALSO proves the json_ld employer\'s candidate above was never routed through Gemini at all, since it succeeded independent of whether a key exists'
        );
      } else {
        skip('GEMINI_API_KEY is configured in this environment — skipping the no-key-required assertion for the non-JSON-LD employer.');
      }

      // Finding C real-infra: the index-page employer's discovered sub-link
      // is genuinely fetched and extracted — closes the loop the original
      // acquisition validation pass exposed as broken (a general /careers
      // page alone never produces a candidate; discovery is what makes it
      // work end-to-end).
      assert(
        results.some((j) => j.title === 'Discovered Engineering Role'),
        'the index-page employer\'s DISCOVERED sub-link (not its own root /careers page) produced a real candidate, via the full discover -> fetch -> json_ld pipeline'
      );
      assert(
        fetchedUrls.some((u) => u.includes(`${indexPageDomain}/careers/eng-role`)),
        'the discovered job-shaped sub-link was genuinely fetched (verified via the fetch-call log, not just output shape)'
      );
      assert(
        !fetchedUrls.some((u) => u.includes(`${indexPageDomain}/about`)),
        'the non-job-shaped /about link was NEVER fetched — deterministic rejection happened before any network call, exactly as Finding C\'s acceptance condition requires'
      );
      const engRoleFetchCount = fetchedUrls.filter((u) => u.includes(`${indexPageDomain}/careers/eng-role`)).length;
      assert(
        engRoleFetchCount === 1,
        `the duplicated /careers/eng-role link (appeared twice in the source HTML) was fetched exactly ONCE, not twice — deduplication held all the way through to the real fetch call (got ${engRoleFetchCount} fetches)`
      );

      // C5 second finding regression (docs/c5-finding2-audit.md §8):
      // /careers/jobs is a discovered sub-link that is itself an Organization-
      // typed index page (no JobPosting JSON-LD node — the real virtual7
      // /unternehmen/jobs/ shape). The guard added to fetchJobs() must:
      //   1. Fetch it (robots + domain-slot + HTTP — already done before the guard)
      //   2. Classify it as 'index' via detectPageKind(subHtml)
      //   3. Skip it — never route it to extractCandidateFromPage()
      //
      // Both assertions are needed: (a) output shape alone could look correct
      // even if the guard were absent (Gemini/shape-guard catches multi-job
      // content too, behaviorally); (b) the fetchedUrls log proves the guard
      // fires post-fetch as designed, not pre-fetch as a discovery filter would.
      assert(
        fetchedUrls.some((u) => u.includes(`${indexPageDomain}/careers/jobs`)),
        'the discovered index sub-link (/careers/jobs) WAS fetched — the second-finding guard fires after the fetch (post-fetch classification), not before'
      );
      assert(
        !results.some((j) => j.company === 'C5 Test indexpage' && j.sourceUrl?.includes('/careers/jobs')),
        'the index-shaped discovered sub-link (/careers/jobs) produced NO candidate — detectPageKind() classified it as \'index\' and the guard skipped it before extraction'
      );
      // Regression: the genuine single-posting sub-link must still produce a
      // candidate — the guard must not over-skip real postings.
      assert(
        results.filter((j) => j.title === 'Discovered Engineering Role').length === 1,
        'the genuine single-posting sub-link (/careers/eng-role) still produces exactly ONE candidate — the second-finding guard does not regress legitimate discovery (this is the same assertion as Finding C\'s, now strengthened by the presence of the index sub-link in the same employer\'s fixture)'
      );

      // 403/429 must be a SOURCE FAILURE on the linked supply_sources row,
      // never interpreted as a dead-link/removed-job signal (§4c).
      const blockedSourceId = sourceIdByLabel.get('blocked');
      const { data: blockedAfter } = await admin
        .from('supply_sources')
        .select('consecutive_fetch_failures')
        .eq('id', blockedSourceId)
        .single();
      assert(
        (blockedAfter?.consecutive_fetch_failures ?? 0) >= 1,
        `the 403-blocked employer's failure is recorded on its supply_sources row as a source failure (got consecutive_fetch_failures=${blockedAfter?.consecutive_fetch_failures})`
      );

      const networkFailSourceId = sourceIdByLabel.get('networkfail');
      const { data: networkFailAfter } = await admin
        .from('supply_sources')
        .select('consecutive_fetch_failures')
        .eq('id', networkFailSourceId)
        .single();
      assert(
        (networkFailAfter?.consecutive_fetch_failures ?? 0) >= 1,
        `the network-failure employer's failure is also recorded (got consecutive_fetch_failures=${networkFailAfter?.consecutive_fetch_failures})`
      );

      // The misregistered (ats_redirect) employer is a successful fetch
      // that's deliberately skipped, not a failure — recorded as success/0.
      const atsRedirectSourceId = sourceIdByLabel.get('atsredirect');
      const { data: atsRedirectAfter } = await admin
        .from('supply_sources')
        .select('consecutive_fetch_failures, last_successful_fetch_at')
        .eq('id', atsRedirectSourceId)
        .single();
      assert(
        (atsRedirectAfter?.consecutive_fetch_failures ?? 0) === 0 && !!atsRedirectAfter?.last_successful_fetch_at,
        'the misregistered ATS-redirect employer is recorded as a successful fetch (0 jobs), not a failure — it needs manual correction, not automated retry pressure'
      );
    } finally {
      const createdEmployerIds = Array.from(employerIdByLabel.values());
      const createdSourceIds = Array.from(sourceIdByLabel.values());
      for (const id of createdEmployerIds) await admin.from('allowlist_employers').delete().eq('id', id);
      for (const id of createdSourceIds) await admin.from('supply_sources').delete().eq('id', id);
      const { data: leftoverEmployers } = await admin.from('allowlist_employers').select('id').ilike('canonical_name', `C5 Test %`);
      assert(
        (leftoverEmployers ?? []).filter((e) => createdEmployerIds.includes(e.id)).length === 0,
        'no test employer rows from this run remain after cleanup'
      );
    }
  }

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running career-page-provider suite:', e); process.exit(1); });
