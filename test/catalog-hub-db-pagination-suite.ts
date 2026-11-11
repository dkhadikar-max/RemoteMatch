/**
 * Database-side remote-job hub pagination.
 *
 * Applies migration 048 to an embedded Postgres, verifies the SECURITY INVOKER
 * RPC under anon/RLS, checks category parity against matchesCategory(), and
 * proves the projection trigger follows inserts, updates, and deletes.
 *
 * Run: npx tsx test/catalog-hub-db-pagination-suite.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { SEO_CATEGORIES, matchesCategory } from '../src/lib/seo/data';
import { CatalogHubTimeoutError, getCatalogHubPage } from '../src/lib/ingestion/catalog-read';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

async function setRole(db: PGlite, role: 'anon' | 'authenticated' | 'service_role') {
  await db.query('RESET ROLE;');
  await db.query(`SET ROLE ${role};`);
  await db.query(`SET request.jwt.claim.role = '${role}';`);
}

async function rpc<T>(db: PGlite, args: { p_category_slug: string | null; p_page: number; p_page_size: number }): Promise<T> {
  const result = await db.query(
    `SELECT public.get_remote_job_hub_page(
      p_category_slug := $1,
      p_page := $2,
      p_page_size := $3
    ) AS result;`,
    [args.p_category_slug, args.p_page, args.p_page_size]
  );
  const value = (result.rows[0] as any).result;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

async function searchRpc(db: PGlite, args: {
  p_terms: string[];
  p_offset: number;
  p_page_size: number;
}): Promise<{ total: number; jobs: Array<Record<string, any>> }> {
  const result = await db.query(
    `SELECT public.get_remote_job_search_page(
      p_terms := $1::text[],
      p_offset := $2,
      p_page_size := $3
    ) AS result;`,
    [args.p_terms, args.p_offset, args.p_page_size]
  );
  const value = (result.rows[0] as any).result;
  return (typeof value === 'string' ? JSON.parse(value) : value) as { total: number; jobs: Array<Record<string, any>> };
}

async function sitemapRpc(db: PGlite, args: {
  p_after_source: string | null;
  p_after_source_id: string | null;
  p_page_size: number;
}): Promise<Array<{ source: string; source_id: string; title: string; posted_at: string; required_skills: string[] }>> {
  const result = await db.query(
    `SELECT * FROM public.get_remote_job_sitemap_page(
      p_after_source := $1,
      p_after_source_id := $2,
      p_page_size := $3
    );`,
    [args.p_after_source, args.p_after_source_id, args.p_page_size]
  );
  return result.rows as Array<{ source: string; source_id: string; title: string; posted_at: string; required_skills: string[] }>;
}

async function sitemapJsonRpc(db: PGlite, args: {
  p_after_source: string | null;
  p_after_source_id: string | null;
  p_page_size: number;
}): Promise<Array<{ source: string; source_id: string; title: string; posted_at: string; required_skills: string[] }>> {
  const result = await db.query(
    `SELECT public.get_remote_job_sitemap_page_json(
      p_after_source := $1,
      p_after_source_id := $2,
      p_page_size := $3
    ) AS result;`,
    [args.p_after_source, args.p_after_source_id, args.p_page_size]
  );
  const value = (result.rows[0] as any).result;
  return (typeof value === 'string' ? JSON.parse(value) : value) as Array<{
    source: string; source_id: string; title: string; posted_at: string; required_skills: string[];
  }>;
}

interface Fixture {
  source?: string;
  source_id: string;
  title: string;
  posted_at: string;
  required_skills: string[];
  remote_type: string | null;
  eligible_countries: string[];
  experience_requirement: string | null;
  status: string;
  source_language: string | null;
  translation_status: string | null;
  company?: string;
  description?: string;
  superseded_by_opportunity_id?: string | null;
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
}

async function main() {
  console.log('\nCATALOG HUB PAGINATION (PGlite): migration, RLS, trigger, category parity');
  const directorySource = read('src/lib/seo/directory.ts');
  const sitemapReaderSource = read('src/lib/ingestion/catalog-read.ts');
  assert(directorySource.includes('MAX_DIRECTORY_REQUEST_PAGE = 100') &&
    directorySource.includes('if (requestedPage > MAX_DIRECTORY_REQUEST_PAGE) return rejectedDeepPage();'),
    'directory and search reject crawler pages above 100 before querying Postgres');
  assert(/const pageSize = 1000;/.test(sitemapReaderSource),
    'sitemap reads use 1,000-row batches to stay below the anon 3s statement timeout');
  const db = new PGlite();

  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;

      CREATE TABLE public.opportunities (
        id uuid PRIMARY KEY,
        source text NOT NULL,
        source_id text NOT NULL,
        type text NOT NULL DEFAULT 'job',
        title text NOT NULL,
        company text NOT NULL DEFAULT 'Fixture Co',
        company_logo text,
        description text NOT NULL DEFAULT 'Fixture description',
        source_url text,
        official_url text NOT NULL DEFAULT 'https://example.test/apply',
        canonical_url_hash text NOT NULL,
        content_hash text NOT NULL,
        employment_type text,
        remote_type text,
        eligible_countries text[],
        excluded_countries text[] DEFAULT ARRAY[]::text[],
        timezone_requirements text[] DEFAULT ARRAY[]::text[],
        salary_min numeric,
        salary_max numeric,
        salary_currency text,
        salary_period text,
        required_skills text[],
        preferred_skills text[] DEFAULT ARRAY[]::text[],
        experience_requirement text,
        quality_score integer,
        source_quality integer,
        description_completeness text,
        salary_quality text,
        remote_policy_confidence text,
        explicit_remote_scope text,
        status text NOT NULL,
        posted_at timestamptz,
        is_permanently_removed boolean DEFAULT false,
        link_checked_at timestamptz,
        superseded_by_opportunity_id uuid,
        source_language text,
        translation_status text,
        UNIQUE (source, source_id)
      );

      ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
      CREATE POLICY opportunities_select_active
        ON public.opportunities FOR SELECT TO anon, authenticated
        USING (status = 'active');
      GRANT SELECT ON public.opportunities TO anon, authenticated, service_role;
      GRANT INSERT, UPDATE, DELETE ON public.opportunities TO service_role;
    `);

    await db.exec(read('supabase/migrations/048_remote_job_hub_db_pagination.sql'));
    assert(true, 'migration 048 applies cleanly to a minimal Postgres schema');
    await db.exec(read('supabase/migrations/20261109095000_catalog_hub_sitemap_query_performance.sql'));
    assert(true, 'migration 051 applies cleanly and keeps the directory RPC SECURITY INVOKER');
    await db.exec(read('supabase/migrations/20261109120000_sitemap_batched_read.sql'));
    assert(true, 'migration 052 adds the covering sitemap index and bounded JSONB batch RPC');
    await db.exec(read('supabase/migrations/20261111110000_split_category_count_and_page.sql'));
    assert(true, 'category hub RPC separates exact totals from bounded page retrieval');
    await db.exec(read('supabase/migrations/20261111130000_search_remote_opportunities_page.sql'));
    assert(true, 'public search RPC applies the visibility gate and returns a bounded exact-count page');
    await db.exec(read('supabase/migrations/20261111150000_exclude_superseded_catalog_rows.sql'));
    assert(true, 'catalog projection trigger excludes superseded rows on insert and update');
    const usCountIndex = await db.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'opportunity_catalog_index_united_states_count';
    `);
    assert(
      String((usCountIndex.rows[0] as any)?.indexdef ?? '').includes('opportunity_catalog_index_united_states_count'),
      'broad US category has a dedicated partial count index'
    );

    const fixtures: Fixture[] = [];
    const now = Date.UTC(2026, 10, 1);
    const base = (source_id: string, i: number, overrides: Partial<Fixture> = {}): Fixture => ({
      source_id,
      title: `General role ${i}`,
      company: 'Fixture Co',
      description: 'Fixture description',
      posted_at: new Date(now + i * 60_000).toISOString(),
      required_skills: [],
      remote_type: 'APAC',
      eligible_countries: [],
      experience_requirement: null,
      status: 'active',
      source_language: 'en',
      translation_status: null,
      superseded_by_opportunity_id: null,
      ...overrides,
    });

    for (let i = 0; i < 16; i++) fixtures.push(base(`generic-${String(i).padStart(2, '0')}`, i));
    fixtures.push(
      base('software', 16, { title: 'Frontend Engineer', required_skills: ['React'] }),
      base('product', 17, { title: 'Product Manager', required_skills: ['Roadmapping'] }),
      base('design', 18, { title: 'UX Designer', required_skills: ['Figma'] }),
      base('data', 19, { title: 'Data Analyst', required_skills: ['SQL'] }),
      base('marketing', 20, { title: 'Growth Marketing Specialist', required_skills: ['SEO'] }),
      base('senior', 21, { title: 'Principal Analyst', experience_requirement: '7-10' }),
      base('entry-level', 22, { title: 'Assistant Analyst', experience_requirement: '0-1' }),
      base('worldwide', 23, { title: 'Global Support', remote_type: 'Worldwide' }),
      base('united-states', 24, { title: 'US Support', remote_type: 'US' }),
      base('europe', 25, { title: 'EU Support', remote_type: 'EU/EEA' }),
      base('translated-de', 26, { title: 'Übersetzte Rolle', source_language: 'de', translation_status: 'ok' }),
      base('translation-error', 27, { title: 'Hidden foreign role', source_language: 'de', translation_status: 'error' }),
      base('expired', 28, { title: 'Expired role', status: 'expired' }),
      // Same source_id across providers, but only alpha belongs in software engineering.
      base('collision', 29, { title: 'Operations Coordinator', required_skills: ['Payroll'], source: 'zeta' }),
      base('collision', 29, { title: 'Collision Engineer', required_skills: ['React'], source: 'alpha' }),
      base('search-title', 30, { title: 'searchtoken Specialist' }),
      base('search-company', 31, { company: 'searchtoken Industries' }),
      base('search-description', 32, { description: 'This role involves searchtoken research.' }),
      base('search-remote', 33, { remote_type: 'searchtoken' }),
      base('search-skill', 34, { required_skills: ['searchtoken'] }),
      base('search-multiterm', 35, { title: 'Senior Specialist', company: 'Engineer Labs' }),
      base('search-short-go', 39, { title: 'Senior Go Developer', required_skills: ['Go'] }),
      base('search-short-csharp', 40, { title: 'C# Developer', required_skills: ['C#'] }),
      base('search-short-cpp', 41, { title: 'C++ Developer', required_skills: ['C++'] }),
      base('search-hidden-expired', 36, { title: 'searchtoken hidden', status: 'expired' }),
      base('search-hidden-translation-error', 37, { title: 'searchtoken hidden foreign', source_language: 'de', translation_status: 'error' }),
      base('search-hidden-superseded', 38, { title: 'searchtoken superseded', superseded_by_opportunity_id: '00000000-0000-4000-8000-000000000001' }),
    );

    await setRole(db, 'service_role');
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      await db.query(
        `INSERT INTO public.opportunities (
          id, source, source_id, title, company, description, posted_at, required_skills,
          remote_type, eligible_countries, experience_requirement,
          status, source_language, translation_status, superseded_by_opportunity_id,
          canonical_url_hash, content_hash
        ) VALUES (
          $1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::text[],
          $9, $10::text[], $11, $12, $13, $14, $15::uuid, $16, $17
        );`,
        [
          `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
          f.source ?? 'fixture',
          f.source_id,
          f.title,
          f.company ?? 'Fixture Co',
          f.description ?? 'Fixture description',
          f.posted_at,
          f.required_skills,
          f.remote_type,
          f.eligible_countries,
          f.experience_requirement,
          f.status,
          f.source_language,
          f.translation_status,
          f.superseded_by_opportunity_id ?? null,
          `hash-${f.source_id}-${f.source ?? 'fixture'}`,
          `content-${f.source_id}-${f.source ?? 'fixture'}`,
        ]
      );
    }

    await setRole(db, 'anon');
    const indexedSearch = await searchRpc(db, {
      p_terms: ['searchtoken'], p_offset: 0, p_page_size: 24,
    });
    const indexedSearchIds = new Set(indexedSearch.jobs.map((job) => job.source_id));
    assert(
      indexedSearch.total === 5 &&
      indexedSearch.jobs.length === 5 &&
      ['search-title', 'search-company', 'search-description', 'search-remote', 'search-skill'].every((id) => indexedSearchIds.has(id)),
      'public search matches title, company, description, remote type and whole skill tags',
      { total: indexedSearch.total, returned: indexedSearch.jobs.length, ids: [...indexedSearchIds] }
    );
    assert(
      !indexedSearchIds.has('search-hidden-expired') &&
      !indexedSearchIds.has('search-hidden-translation-error') &&
      !indexedSearchIds.has('search-hidden-superseded'),
      'public search RPC never exposes expired, translation-error or superseded rows'
    );
    const multiTermSearch = await searchRpc(db, {
      p_terms: ['senior', 'engineer'], p_offset: 0, p_page_size: 24,
    });
    assert(
      multiTermSearch.total === 1 &&
      multiTermSearch.jobs[0]?.source_id === 'search-multiterm',
      'public search ANDs terms while allowing each term to match a different searchable field'
    );
    const secondSearchPage = await searchRpc(db, {
      p_terms: ['searchtoken'], p_offset: 5, p_page_size: 24,
    });
    assert(
      secondSearchPage.total === 5 && secondSearchPage.jobs.length === 0,
      'search pagination preserves the exact total when the requested page is empty',
      { total: secondSearchPage.total, returned: secondSearchPage.jobs.length }
    );
    const shortGoSearch = await searchRpc(db, {
      p_terms: ['go'], p_offset: 0, p_page_size: 24,
    });
    assert(
      shortGoSearch.jobs.some((job) => job.source_id === 'search-short-go'),
      'one/two-character alphanumeric terms use token-prefix matching and exact skill tags'
    );
    const shortCSharpSearch = await searchRpc(db, {
      p_terms: ['c#'], p_offset: 0, p_page_size: 24,
    });
    assert(
      shortCSharpSearch.jobs.some((job) => job.source_id === 'search-short-csharp'),
      'short punctuation-bearing skill terms use indexed prefixes and exact skill tags'
    );
    const shortCppSearch = await searchRpc(db, {
      p_terms: ['c++'], p_offset: 0, p_page_size: 24,
    });
    assert(
      shortCppSearch.jobs.some((job) => job.source_id === 'search-short-cpp'),
      'punctuation-heavy short terms avoid trigram scans while retaining C++ skill/title matching'
    );
    const emptyTermSearch = await searchRpc(db, {
      p_terms: [], p_offset: 0, p_page_size: 24,
    });
    assert(
      emptyTermSearch.total === 0 && emptyTermSearch.jobs.length === 0,
      'an empty/sanitized-away search query returns zero results without a full-catalog count'
    );
    const searchSecurity = await db.query(`
      SELECT p.prosecdef AS security_definer, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_remote_job_search_page';
    `);
    assert(
      (searchSecurity.rows[0] as any).security_definer === true &&
      JSON.stringify((searchSecurity.rows[0] as any).proconfig ?? []).includes('row_security=off'),
      'search RPC is SECURITY DEFINER with row_security disabled and explicit public visibility predicates'
    );

    const visible = fixtures.filter((f) =>
      f.status === 'active' &&
      f.superseded_by_opportunity_id == null &&
      (f.source_language === null || f.source_language === 'en' || f.translation_status === 'ok') &&
      (f.translation_status === null || f.translation_status !== 'error')
    );
    const expectedOrder = (rows: Fixture[]) => [...rows].sort((a, b) =>
      b.posted_at.localeCompare(a.posted_at) ||
      a.source_id.localeCompare(b.source_id) ||
      (a.source ?? 'fixture').localeCompare(b.source ?? 'fixture')
    );
    // The production RPC preserves the legacy page window, then deduplicates
    // source IDs before resolving full rows. Model that exact page behavior:
    // totals count catalog entries, while a page emits one row per source ID.
    const expectedPageJobs = (rows: Fixture[]) => {
      const ordered = expectedOrder(rows);
      const firstSourceById = new Map<string, Fixture>();
      for (const row of [...rows].sort((a, b) =>
        (a.source ?? 'fixture').localeCompare(b.source ?? 'fixture')
      )) {
        if (!firstSourceById.has(row.source_id)) firstSourceById.set(row.source_id, row);
      }
      const seen = new Set<string>();
      return ordered.slice(0, 24).flatMap((row) => {
        if (seen.has(row.source_id)) return [];
        seen.add(row.source_id);
        return [firstSourceById.get(row.source_id)!];
      });
    };

    const indexCount = await db.query('SELECT count(*)::int AS n FROM public.opportunity_catalog_index;');
    assert(Number((indexCount.rows[0] as any).n) === visible.length, 'trigger/backfill projection contains only active, translation-safe rows');

    await setRole(db, 'anon');
    const rootPage1 = await rpc<{ total: number; jobs: Array<{ source_id: string; source: string }> }>(db, {
      p_category_slug: null, p_page: 1, p_page_size: 24,
    });
    assert(rootPage1.total === visible.length, 'root directory returns the exact active, translation-safe total');
    assert(
      rootPage1.jobs.map((j) => j.source_id).join('|') === expectedPageJobs(visible).map((f) => f.source_id).join('|'),
      'root page 1 returns the newest 24 rows in deterministic order'
    );
    const collisionRows = rootPage1.jobs.filter((job) => job.source_id === 'collision');
    assert(
      collisionRows.length === 1 && collisionRows[0].source === 'alpha',
      'duplicate source_id entries are deduplicated within the page and resolve to the first source deterministically'
    );

    const rootPage2 = await rpc<{ total: number; jobs: Array<{ source_id: string }> }>(db, {
      p_category_slug: null, p_page: 2, p_page_size: 24,
    });
    assert(rootPage2.total === visible.length && rootPage2.jobs.length === visible.length - 24, 'root page 2 returns only the remaining rows with the same exact total');

    // Sitemap pagination must seek by the composite natural key, preserve
    // deterministic ordering, and enforce the same active/translation-safe RLS.
    const sitemapRows: Array<{ source: string; source_id: string }> = [];
    let afterSource: string | null = null;
    let afterSourceId: string | null = null;
    for (let page = 0; page < 10; page++) {
      const rows = await sitemapRpc(db, {
        p_after_source: afterSource,
        p_after_source_id: afterSourceId,
        p_page_size: 5,
      });
      if (rows.length === 0) break;
      sitemapRows.push(...rows);
      const last = rows[rows.length - 1];
      afterSource = last.source;
      afterSourceId = last.source_id;
      if (rows.length < 5) break;
    }
    const expectedSitemap = [...visible].sort((a, b) =>
      (a.source ?? 'fixture').localeCompare(b.source ?? 'fixture') ||
      a.source_id.localeCompare(b.source_id)
    );
    assert(
      sitemapRows.map((row) => `${row.source}:${row.source_id}`).join('|') ===
        expectedSitemap.map((row) => `${row.source ?? 'fixture'}:${row.source_id}`).join('|'),
      'keyset sitemap pages return every active translation-safe listing exactly once in stable order'
    );
    assert(
      sitemapRows.every((row) => !['translation-error', 'expired'].includes(row.source_id)),
      'sitemap RPC excludes translation-error and inactive listings under anon/RLS'
    );

    const sitemapJsonFirst = await sitemapJsonRpc(db, {
      p_after_source: null, p_after_source_id: null, p_page_size: 5,
    });
    const sitemapJsonNext = await sitemapJsonRpc(db, {
      p_after_source: sitemapJsonFirst[sitemapJsonFirst.length - 1]?.source ?? null,
      p_after_source_id: sitemapJsonFirst[sitemapJsonFirst.length - 1]?.source_id ?? null,
      p_page_size: 5,
    });
    assert(
      sitemapJsonFirst.map((row) => `${row.source}:${row.source_id}`).join('|') ===
        expectedSitemap.slice(0, 5).map((row) => `${row.source ?? 'fixture'}:${row.source_id}`).join('|') &&
      sitemapJsonNext.map((row) => `${row.source}:${row.source_id}`).join('|') ===
        expectedSitemap.slice(5, 10).map((row) => `${row.source ?? 'fixture'}:${row.source_id}`).join('|'),
      'JSONB sitemap batches preserve composite-cursor order and return the same records as the legacy setof RPC'
    );
    const sitemapJsonSecurity = await db.query(`
      SELECT p.prosecdef AS security_definer
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_remote_job_sitemap_page_json';
    `);
    assert((sitemapJsonSecurity.rows[0] as any).security_definer === false,
      'JSONB sitemap batch RPC remains SECURITY INVOKER');

    const outOfRange = await rpc<{ total: number; jobs: unknown[] }>(db, {
      p_category_slug: null, p_page: 5000, p_page_size: 24,
    });
    assert(outOfRange.total === visible.length && outOfRange.jobs.length === 0, 'out-of-range page preserves total and returns an empty jobs array');

    let categoryParity = true;
    const parityFailures: string[] = [];
    for (const category of SEO_CATEGORIES) {
      const expected = expectedOrder(visible.filter((f) => matchesCategory(category, {
        title: f.title,
        requiredSkills: f.required_skills,
        remoteType: f.remote_type ?? undefined,
        eligibleCountries: f.eligible_countries,
        experienceRequirement: f.experience_requirement ?? undefined,
      })));
      const actual = await rpc<{ total: number; jobs: Array<{ source_id: string; source: string; title: string }> }>(db, {
        p_category_slug: category.slug, p_page: 1, p_page_size: 24,
      });
      if (category.slug === 'software-engineering') {
        const categoryCollision = actual.jobs.find((job) => job.source_id === 'collision');
        assert(
          categoryCollision?.source === 'alpha' && categoryCollision.title === 'Collision Engineer',
          'duplicate source IDs resolve only to a row that matches the requested category'
        );
      }
      if (
        actual.total !== expected.length ||
        actual.jobs.map((j) => j.source_id).join('|') !== expectedPageJobs(visible.filter((f) => matchesCategory(category, {
          title: f.title,
          requiredSkills: f.required_skills,
          remoteType: f.remote_type ?? undefined,
          eligibleCountries: f.eligible_countries,
          experienceRequirement: f.experience_requirement ?? undefined,
        }))).map((f) => f.source_id).join('|')
      ) {
        categoryParity = false;
        parityFailures.push(category.slug);
      }
    }
    assert(categoryParity, `SQL category predicates match matchesCategory() for all ${SEO_CATEGORIES.length} hubs`, parityFailures.join(', '));

    await setRole(db, 'service_role');
    const policy = await db.query(`
      SELECT c.relrowsecurity AS enabled
      FROM pg_class c
      WHERE c.oid = 'public.opportunity_catalog_index'::regclass;
    `);
    const functionSecurity = await db.query(`
      SELECT p.prosecdef AS security_definer
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_remote_job_hub_page';
    `);
    assert((policy.rows[0] as any).enabled === true, 'projection table has RLS enabled');
    assert((functionSecurity.rows[0] as any).security_definer === false, 'page RPC is SECURITY INVOKER, not SECURITY DEFINER');

    // The trigger is transactional: lifecycle/translation changes remove and
    // restore a row in the projection without a separate refresh operation.
    await setRole(db, 'service_role');
    await db.query(`UPDATE public.opportunities SET status = 'expired' WHERE source_id = 'generic-00';`);
    let changed = await db.query(`SELECT count(*)::int AS n FROM public.opportunity_catalog_index WHERE source_id = 'generic-00';`);
    assert(Number((changed.rows[0] as any).n) === 0, 'status transition to expired removes the projection row');

    await db.query(`UPDATE public.opportunities SET status = 'active', source_language = 'de', translation_status = 'error' WHERE source_id = 'generic-00';`);
    changed = await db.query(`SELECT count(*)::int AS n FROM public.opportunity_catalog_index WHERE source_id = 'generic-00';`);
    assert(Number((changed.rows[0] as any).n) === 0, 'translation error removes the projection row');

    await db.query(`UPDATE public.opportunities SET source_language = 'de', translation_status = 'ok' WHERE source_id = 'generic-00';`);
    changed = await db.query(`SELECT count(*)::int AS n FROM public.opportunity_catalog_index WHERE source_id = 'generic-00';`);
    assert(Number((changed.rows[0] as any).n) === 1, 'successfully translated foreign row is restored to the projection');

    await db.query(`DELETE FROM public.opportunities WHERE source_id = 'generic-00';`);
    changed = await db.query(`SELECT count(*)::int AS n FROM public.opportunity_catalog_index WHERE source_id = 'generic-00';`);
    assert(Number((changed.rows[0] as any).n) === 0, 'deleting an opportunity deletes its projection row');

    await setRole(db, 'anon');
    const afterDelete = await rpc<{ total: number; jobs: unknown[] }>(db, {
      p_category_slug: null, p_page: 1, p_page_size: 24,
    });
    assert(afterDelete.total === visible.length - 1, 'directory total reflects committed trigger maintenance without a manual refresh');

    // Exercise the same catalog size that exposed the production failure. The
    // function must count the whole projection but return only a page, even if
    // a caller asks for an oversized page size.
    await setRole(db, 'service_role');
    await db.exec(`
      INSERT INTO public.opportunities (
        id, source, source_id, title, posted_at, required_skills,
        remote_type, eligible_countries, experience_requirement,
        status, source_language, translation_status,
        canonical_url_hash, content_hash
      )
      SELECT
        gen_random_uuid(),
        'scale',
        'scale-' || g::text,
        'Scale role ' || g::text,
        timestamptz '2026-11-02 00:00:00+00' + g * interval '1 second',
        ARRAY[]::text[],
        'US',
        ARRAY[]::text[],
        NULL,
        'active',
        'en',
        NULL,
        'scale-h-' || g::text,
        'scale-c-' || g::text
      FROM generate_series(1, 92357) AS series(g);
    `);

    await setRole(db, 'anon');
    const largePage1 = await rpc<{ total: number; jobs: Array<{ source_id: string }> }>(db, {
      p_category_slug: null, p_page: 1, p_page_size: 1000,
    });
    const largePage2 = await rpc<{ total: number; jobs: Array<{ source_id: string }> }>(db, {
      p_category_slug: null, p_page: 2, p_page_size: 24,
    });
    const largeIds1 = new Set(largePage1.jobs.map((j) => j.source_id));
    assert(
      largePage1.total === visible.length - 1 + 92357 && largePage1.jobs.length === 24,
      '92,357-row catalog returns an exact total but clamps every response to 24 full rows'
    );
    assert(
      largePage2.total === largePage1.total &&
      largePage2.jobs.length === 24 &&
      largePage2.jobs.every((j) => !largeIds1.has(j.source_id)),
      'large-catalog page 2 is bounded and does not repeat page 1 listings'
    );

    const largeUsPage = await rpc<{ total: number; jobs: Array<{ source_id: string }> }>(db, {
      p_category_slug: 'united-states', p_page: 1, p_page_size: 24,
    });
    assert(
      largeUsPage.total === 92358 && largeUsPage.jobs.length === 24,
      'broad US category returns an exact 92k+ total and only one bounded 24-row page'
    );

    const largeSitemapBatch1 = await sitemapJsonRpc(db, {
      p_after_source: null, p_after_source_id: null, p_page_size: 1000,
    });
    const lastLargeSitemapRow = largeSitemapBatch1[largeSitemapBatch1.length - 1];
    const largeSitemapBatch2 = await sitemapJsonRpc(db, {
      p_after_source: lastLargeSitemapRow.source,
      p_after_source_id: lastLargeSitemapRow.source_id,
      p_page_size: 1000,
    });
    const largeSitemapIds = new Set(largeSitemapBatch1.map((row) => `${row.source}:${row.source_id}`));
    assert(
      largeSitemapBatch1.length === 1000 && largeSitemapBatch2.length === 1000 &&
      largeSitemapBatch2.every((row) => !largeSitemapIds.has(`${row.source}:${row.source_id}`)),
      '92k+ catalog sitemap RPC returns bounded 1,000-row JSON batches with a non-overlapping next cursor'
    );
    const sitemapCoveringIndex = await db.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_opportunities_sitemap_visible_cursor_cover';
    `);
    assert(
      String((sitemapCoveringIndex.rows[0] as any)?.indexdef ?? '').includes('INCLUDE (title, posted_at, required_skills)'),
      'migration 052 creates the covering partial sitemap cursor index'
    );

    // Concurrent large-catalog regression: exercise the same RPC at the
    // production failure scale (92k+ rows) with overlapping root reads and
    // deep-page reads. This validates bounded responses and deterministic
    // totals under concurrent callers; PGlite timings are diagnostic only and
    // are not treated as a production latency/SLO measurement.
    const concurrentCases = Array.from({ length: 32 }, (_, i) => ({
      p_category_slug: null,
      p_page: i % 4 === 0 ? 161 : i % 4 === 1 ? 3289 : i % 4 === 2 ? 1 : 2,
      p_page_size: 24,
    }));
    const concurrentStarted = performance.now();
    const concurrentResults = await Promise.all(concurrentCases.map((args) => rpc<{
      total: number;
      jobs: Array<{ source_id: string }>;
    }>(db, args)));
    const concurrentElapsed = performance.now() - concurrentStarted;
    const expectedLargeTotal = visible.length - 1 + 92357;
    assert(
      concurrentResults.length === 32 && concurrentResults.every((result) =>
        result.total === expectedLargeTotal && result.jobs.length <= 24
      ),
      '32 concurrent root/category and deep-page RPC reads remain bounded and preserve the 92k+ catalog total'
    );
    console.log(`  ℹ 32 concurrent large-catalog RPC reads completed in ${concurrentElapsed.toFixed(1)} ms (PGlite diagnostic; not a production latency claim).`);

    const timeoutClient = {
      rpc: async () => ({
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      }),
    } as any;
    let timeoutClassified = false;
    try {
      await getCatalogHubPage(timeoutClient, null, 1, 24);
    } catch (error) {
      timeoutClassified = error instanceof CatalogHubTimeoutError;
    }
    assert(timeoutClassified, 'catalog RPC SQLSTATE 57014 is classified as CatalogHubTimeoutError');

    const unexpectedClient = {
      rpc: async () => ({
        data: null,
        error: { code: '42601', message: 'syntax error' },
      }),
    } as any;
    let unexpectedPropagated = false;
    try {
      await getCatalogHubPage(unexpectedClient, null, 1, 24);
    } catch (error) {
      unexpectedPropagated = error instanceof Error && error.message.includes('syntax error');
    }
    assert(unexpectedPropagated, 'unexpected RPC errors still propagate rather than becoming empty results');

  } finally {
    await db.close();
  }

  finish();
}

main().catch((error) => {
  console.error('SUITE ERROR:', error);
  process.exitCode = 1;
});
