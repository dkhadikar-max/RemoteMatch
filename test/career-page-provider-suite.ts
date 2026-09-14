/**
 * Supply Discovery gate C5 — career-page provider (docs/c5-implementation-plan.md §7, §12).
 * Mirrors ats-provider-suite.ts's structure: unit coverage with no infra,
 * then a real-infra section (self-skips if env unavailable) that seeds
 * synthetic allowlist_employers rows, mocks global.fetch for the page
 * fetch itself (never the DB), and cleans up unconditionally.
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { detectExtractionMethod, parseJsonLd, CareerPageProvider } from '../src/lib/providers/career-page';
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
  console.log('\n3. REAL-INFRA — provider run against seeded synthetic employers (self-skips if env unavailable)');
  // ==========================================================================
  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — real-infra section skipped.');
  } else {
    const admin = adminClient();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const domainFor = (label: string) => `c5-test-${label}-${suffix}.example`;

    const employerDefs = [
      { label: 'jsonld', domain: domainFor('jsonld'), path: '/careers/staff-eng', html: JSON_LD_PAGE, status: 200 },
      { label: 'blocked', domain: domainFor('blocked'), path: '/careers/x', html: '', status: 403 },
      { label: 'notfound', domain: domainFor('notfound'), path: '/careers/x', html: '', status: 500 },
      { label: 'noextraction', domain: domainFor('noextraction'), path: '/careers/x', html: NON_JOBPOSTING_LD_PAGE, status: 200 },
      { label: 'atsredirect', domain: 'boards.greenhouse.io', path: '/acme-c5-test/jobs/1', html: '<html></html>', status: 200 },
      { label: 'networkfail', domain: domainFor('networkfail'), path: '/careers/x', html: '', status: 0 },
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
      const originalFetch = global.fetch;
      (global as any).fetch = async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input.url;
        const def = employerDefs.find((d) => url.includes(d.domain));
        if (!def) return originalFetch(input, init);
        if (def.status === 0) throw new Error('simulated network failure');
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
